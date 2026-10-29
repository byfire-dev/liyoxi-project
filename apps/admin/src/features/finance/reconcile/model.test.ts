import { PaymentExceptionResolveBodySchema } from "@liyoxi/contract";
import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { access, detail, id, orderId } from "./fixtures.test-support";
import {
  canReconcile,
  canCreateException,
  canReturnReceipt,
  createReconcileIntent,
  exceptionQuery,
  reconcileSearch,
  refreshReconcile,
  resolutions,
  resolveBody,
} from "./model";
it("服务端actions与权限决定九类动作，核销额外守卫、候选关联及平台凭证范围严格", () => {
  const value = {
    ...detail(),
    allowedResolutions: [
      "restore",
      "refund",
      "retried",
      "rebuild_order",
      "link_order",
      "offline_return",
      "record_channel_refund",
      "corrected",
      "written_off",
    ] as const,
  };
  const row = { ...value, allowedResolutions: [...value.allowedResolutions] };
  expect(resolutions(row, access)).toHaveLength(8);
  expect(
    resolutions(row, { ...access, actions: [...access.actions, "sys.super_admin"] }),
  ).toHaveLength(9);
  expect(resolutions({ ...row, actions: [] }, access)).toEqual([]);
  expect(resolutions({ ...row, status: "resolved" }, access)).toEqual([]);
  expect(canReconcile({ ...access, actions: [] })).toBe(false);
  expect(canCreateException(access)).toBe(true);
  expect(canCreateException({ ...access, dataScope: "own" })).toBe(false);
  expect(canCreateException({ ...access, dataScope: "group" })).toBe(false);
  expect(canReturnReceipt({ ...access, dataScope: "own" })).toBe(false);
  expect(canReturnReceipt({ ...access, actions: ["finance.recon.resolve"] })).toBe(false);
  for (const resolution of row.allowedResolutions) {
    const body = resolveBody(row, resolution, "真实核对说明", {
      linkPaymentOrderId: orderId,
      offlineReturn: {
        transferDate: "2030-10-18",
        bankSerialNo: "FICTIONAL-1",
        payeeName: "虚构付款人",
        payeeBank: "虚构银行",
        payeeAccount: "622200000001",
        receiptFileId: id,
      },
    });
    expect(PaymentExceptionResolveBodySchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      lockVersion: 7,
      confirm: { exceptionNo: row.exceptionNo, amountFen: 101 },
    });
    expect(body.offlineReturn !== undefined).toBe(resolution === "offline_return");
    expect(body.linkPaymentOrderId !== undefined).toBe(resolution === "link_order");
  }
  expect(() => resolveBody(row, "link_order", "核对", { linkPaymentOrderId: id })).toThrow();
  expect(
    exceptionQuery(
      reconcileSearch({
        month: "2030-99",
        tab: "future",
        kind: "future",
        billDateFrom: "2030-02-30",
        paymentExceptionId: "javascript:bad",
        page: 3,
      }),
    ),
  ).toMatchObject({ tab: "open", kind: undefined, billDateFrom: undefined, page: 3 });
});
it("未知结果同正文原key/双击零重复；关闭取消迟到写和读，写前GET不能覆盖真实重读", async () => {
  let count = 0;
  const intent = createReconcileIntent(() => `fixture-${++count}`),
    keys: string[] = [];
  await expect(
    intent.submit("resolve", { version: 7 }, async (key) => {
      keys.push(key);
      throw new Error("unknown");
    }),
  ).rejects.toThrow("unknown");
  await intent.submit("resolve", { version: 7 }, async (key) => {
    keys.push(key);
    return true;
  });
  expect(keys).toEqual(["fixture-1", "fixture-1"]);
  let finish!: (value: string) => void, own!: AbortSignal;
  const pending = intent.submit("rerun", {}, async (_key, signal) => {
    own = signal;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  expect(await intent.submit("rerun", {}, async () => "duplicate")).toBeUndefined();
  intent.close();
  expect(own.aborted).toBe(true);
  finish("late");
  expect(await pending).toBeUndefined();
  const cache = new QueryClient(),
    key = ["fixture", "detail", id],
    controller = new AbortController();
  let oldFinish!: (value: string) => void;
  const old = cache
    .fetchQuery({
      queryKey: key,
      queryFn: ({ signal }) => {
        signal.addEventListener("abort", () => undefined);
        return new Promise<string>((resolve) => {
          oldFinish = resolve;
        });
      },
    })
    .catch(() => undefined);
  await refreshReconcile(cache, key, controller.signal, async () => "fresh");
  oldFinish("old");
  await old;
  expect(cache.getQueryData(key)).toBe("fresh");
  await expect(
    refreshReconcile(cache, key, controller.signal, async () => {
      controller.abort();
      return "wrong-scope";
    }),
  ).rejects.toThrow();
  expect(cache.getQueryData(key)).toBe("fresh");
  cache.clear();
});
