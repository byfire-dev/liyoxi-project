import { beforeEach, describe, expect, it, vi } from "vitest";
import { billingPayment } from "../../../../shots/billing-fixtures";
import type { PurchaseApi } from "./api";
const h = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
  rendered: false,
  cleanups: [] as (() => void)[],
  handlers: [] as (() => Promise<void> | void)[],
  rev: 1,
  token: "token",
  seq: 0,
  file: { path: "local-receipt.jpg", name: "receipt.jpg", size: 100 },
  job: {
    snapshot: () => ({ status: "done", fileId: "stored-file", progress: 100 }),
    dispose: vi.fn(),
    subscribe: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const i = h.stateIndex++;
    if (!(i in h.states)) h.states[i] = initial;
    return [
      h.states[i],
      (v: unknown) => {
        h.states[i] = v;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = h.refIndex++;
    return (h.refs[i] ??= { current: initial });
  },
  useEffect: (effect: () => () => void) => {
    if (!h.rendered) h.cleanups.push(effect());
  },
}));
vi.mock("@tarojs/components", () => ({ View: "View" }));
vi.mock("@tarojs/taro", () => ({ default: {} }));
vi.mock("@/components/Button", () => ({ Button: "Button" }));
vi.mock("@/components/Note", () => ({ Note: "Note" }));
vi.mock("@/components/UploadGrid", () => ({ UploadGrid: "UploadGrid" }));
vi.mock("@/lib/runtime", () => ({
  newIdempotencyKey: () => `proof-${++h.seq}`,
  withPrivacy: async () => ({ ok: true, value: h.file }),
  withSubscribe: (_point: string, handler: () => Promise<void> | void) => () => {
    h.handlers.push(handler);
  },
}));
vi.mock("@/lib/upload/billing-receipt", () => ({ createReceiptUpload: () => h.job }));
vi.mock("@/stores/context", () => ({
  useContextStore: { getState: () => ({ contextRev: h.rev }) },
}));
vi.mock("@/stores/session", () => ({
  useSessionStore: { getState: () => ({ accessToken: h.token }) },
}));
vi.mock("@/stores/bootstrap", () => ({
  useBootstrapStore: { getState: () => ({ data: { uploadLimits: { imageMaxMb: 5 } } }) },
}));
vi.mock("../wallet/runtime", () => ({ billingRequest: vi.fn() }));
import { ReceiptPicker } from "./receipt";
type Element = {
  type: unknown;
  props: { children: Element[]; onClick?: () => void; onAdd?: () => void };
};
function render(api: PurchaseApi, onSubmitted: (v: ReturnType<typeof billingPayment>) => void) {
  h.stateIndex = h.refIndex = 0;
  const node = ReceiptPicker({
    payment: billingPayment("bank-waiting"),
    api,
    onSubmitted,
  }) as unknown as Element;
  h.rendered = true;
  return node.props.children;
}
async function chosen() {
  const proof = vi.fn().mockResolvedValue(billingPayment("payment-waiting")),
    onSubmitted = vi.fn();
  const api = { proof } as unknown as PurchaseApi;
  await render(api, onSubmitted).find((v) => v?.type === "UploadGrid")!.props.onAdd!();
  await Promise.resolve();
  return {
    proof,
    onSubmitted,
    api,
    click: () => render(api, onSubmitted).find((v) => v?.type === "Button")!.props.onClick!(),
  };
}
beforeEach(() => {
  h.states = [];
  h.refs = [];
  h.cleanups = [];
  h.handlers = [];
  h.rendered = false;
  h.rev = 1;
  h.token = "token";
  h.seq = 0;
  vi.clearAllMocks();
});
describe("实际凭证组件的延迟授权", () => {
  it("点击后卸载，授权迟到不发凭证请求也不导航", async () => {
    const p = await chosen();
    p.click();
    h.cleanups.forEach((fn) => fn());
    await h.handlers[0]!();
    expect(h.job.dispose).toHaveBeenCalledOnce();
    expect(p.proof).not.toHaveBeenCalled();
    expect(p.onSubmitted).not.toHaveBeenCalled();
  });
  it.each(["context", "token"])("点击时固定%s，授权返回后已变则不提交", async (kind) => {
    const p = await chosen();
    p.click();
    if (kind === "context") h.rev++;
    else h.token = "new-token";
    await h.handlers[0]!();
    expect(p.proof).not.toHaveBeenCalled();
    expect(p.onSubmitted).not.toHaveBeenCalled();
  });
  it("原上下文授权返回只提交一次，单飞覆盖等待授权期间", async () => {
    const p = await chosen();
    p.click();
    p.click();
    expect(h.handlers).toHaveLength(1);
    await h.handlers[0]!();
    expect(p.proof).toHaveBeenCalledOnce();
    expect(p.proof).toHaveBeenCalledWith(
      billingPayment("bank-waiting").paymentOrderId,
      "stored-file",
      "proof-1",
    );
    expect(p.onSubmitted).toHaveBeenCalledOnce();
  });
  it("凭证请求期间卸载，迟到响应也不导航", async () => {
    const p = await chosen();
    let resolve!: (v: ReturnType<typeof billingPayment>) => void;
    p.proof.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    p.click();
    const result = h.handlers[0]!();
    h.cleanups.forEach((fn) => fn());
    resolve(billingPayment("payment-waiting"));
    await result;
    expect(p.proof).toHaveBeenCalledOnce();
    expect(p.onSubmitted).not.toHaveBeenCalled();
  });
});
