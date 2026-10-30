import { AdminStoreAssetDetailSchema, AdminStoreAssetRowSchema } from "@liyoxi/contract";
import { QueryClient, type QueryObserver, type QueryObserverOptions } from "@tanstack/react-query";
import { isValidElement, type ReactElement } from "react";
import type * as ReactModule from "react";
import type * as QueryModule from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "../../../app/services";
import { createAdminApi } from "../../../lib/api";
import type { AccessSnapshot } from "../../../lib/permissions";

// 与既有 editor-component 用例相同的 hook 边界；真实 QueryObserver、
// view、AssetConfirm、ConfirmAction 和请求客户端贯穿同一弹层实例。
const h = vi.hoisted(() => ({
  component: "",
  cursor: 0,
  state: new Map<string, unknown[]>(),
  cleanups: [] as (() => void)[],
  query: null as QueryClient | null,
  observers: new Map<string, QueryObserver>(),
  subscriptions: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof ReactModule>()),
  useState(initial: unknown) {
    const slots = h.state.get(h.component) ?? [],
      index = h.cursor++;
    h.state.set(h.component, slots);
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      slots[index],
      (next: unknown) => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next;
      },
    ];
  },
  useRef(initial: unknown) {
    const slots = h.state.get(h.component) ?? [],
      index = h.cursor++;
    h.state.set(h.component, slots);
    return (slots[index] ??= { current: initial });
  },
  useEffect(effect: () => void | (() => void)) {
    const slots = h.state.get(h.component) ?? [],
      index = h.cursor++;
    h.state.set(h.component, slots);
    if (!(index in slots)) {
      slots[index] = true;
      const cleanup = effect();
      if (cleanup) h.cleanups.push(cleanup);
    }
  },
}));
vi.mock("@tanstack/react-query", async (original) => {
  const actual = await original<typeof QueryModule>();
  return {
    ...actual,
    useQuery(options: QueryObserverOptions) {
      if (!h.query) throw new Error("缺少查询客户端");
      const key = JSON.stringify(options.queryKey);
      let observer = h.observers.get(key);
      if (!observer) {
        observer = new actual.QueryObserver(h.query, options);
        h.observers.set(key, observer);
        h.subscriptions.push(observer.subscribe(() => {}));
      } else observer.setOptions(options);
      return observer.getCurrentResult();
    },
  };
});
vi.mock("antd", () => ({
  Alert: "Alert",
  Button: "Button",
  Checkbox: "Checkbox",
  ConfigProvider: "ConfigProvider",
  Input: "Input",
  Modal: "Modal",
  Select: "Select",
  Space: "Space",
}));
vi.mock("../../../components/InfoList", () => ({ InfoList: "InfoList" }));
vi.mock("../../../components/QueryTablePage", () => ({ QueryTablePage: "QueryTablePage" }));
vi.mock("../../../components/StateBlock", () => ({
  EmptyState: "EmptyState",
  ErrorState: "ErrorState",
}));
vi.mock("./actions", () => ({ AssetActions: "AssetActions" }));
vi.mock("./demands", () => ({ AssetDemands: "AssetDemands" }));
vi.mock("./editor", () => ({ AssetEditor: "AssetEditor" }));
import { AssetConfirm } from "./confirm";
import { MerchantAssetsView } from "./view";
import { ASSET_READ_KEY, assetListQuery, assetSearch } from "./model";
import { merchantScope } from "../detail/model";
import { assetDraft, prepareAsset } from "./write-model";

const id = "0199e187-e72a-7000-8000-000000000001",
  at = "2030-10-14T04:00:00.000Z";
const asset = AdminStoreAssetDetailSchema.parse({
  storeAssetId: id,
  storeId: id,
  storeName: "虚构门店",
  type: "text",
  title: "虚构文字",
  fileCount: 0,
  durationMs: null,
  pageCount: null,
  charCount: 8,
  thumbnail: null,
  usability: "reference_only",
  processingState: "processed",
  moderationState: "pass",
  adoptedCount: 0,
  createdAt: at,
  uploader: {
    actorType: "staff",
    role: null,
    displayName: "虚构员工",
    merchantUserId: null,
    staffId: id,
  },
  contentTags: [],
  hasUnconfirmedAutoTags: false,
  usageTags: [],
  timelinessTag: null,
  adminStatus: "organized",
  isInsightPartial: false,
  portraitAuth: { fileCount: 0, authorizedAt: null },
  reviewDueAt: null,
  isReviewOverdue: false,
  assetDemandId: null,
  sourceStoreAssetId: null,
  actions: ["delete"],
  textBody: "虚构正文",
  note: null,
  files: [],
  transcript: null,
  keypoints: [],
  structuredItems: [],
  techSpecLabel: null,
  suggestion: null,
  insightSteps: [],
  portraitAuthFileIds: [],
  reviewedBy: null,
  reviewedAt: at,
  usages: [],
  lockVersion: 7,
});
const access: AccessSnapshot = {
  staff: { id, name: "虚构员工", roleKey: "cs", roleName: "客服" },
  isLead: false,
  moduleLevels: { merchant: "v" },
  actions: [],
  dataScope: "own",
  releases: {},
};
const row = AdminStoreAssetRowSchema.strip().parse(asset);
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(value)) return [];
  return [value, ...nodes(value.props.children)];
}
function run(component: string, render: () => unknown): unknown {
  h.component = component;
  h.cursor = 0;
  return render();
}
function renderElement(component: string, value: unknown): Node {
  if (!isValidElement<Record<string, unknown>>(value))
    throw new Error(`缺少真实组件：${component}`);
  const render = value.type;
  if (typeof render !== "function") throw new Error(`缺少真实组件：${component}`);
  const result = run(component, () => Reflect.apply(render, undefined, [value.props]));
  if (!isValidElement<Record<string, unknown>>(result)) throw new Error("组件未返回节点");
  return result;
}
function control(tree: unknown, type: string): Node {
  const found = nodes(tree).find((node) => node.type === type);
  if (!found) throw new Error(`缺少界面节点：${type}`);
  return found;
}
function call(node: Node, key: string, ...args: unknown[]) {
  const callback = node.props[key];
  if (typeof callback !== "function") throw new Error(`缺少真实交互：${key}`);
  return callback(...args);
}
afterEach(() => {
  for (const cleanup of h.cleanups) cleanup();
  for (const unsubscribe of h.subscriptions) unsubscribe();
  h.query?.clear();
  h.state.clear();
  h.observers.clear();
  h.cleanups = [];
  h.subscriptions = [];
});

describe("读侧错误中的删除确认", () => {
  it("列表在删除在途时失败仍保留原确认；未知后重试同key，取消回列表且零详情GET", async () => {
    const query = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    h.query = query;
    let listFails = false,
      failDelete: ((error: Error) => void) | undefined;
    const requests: Request[] = [],
      keys: (string | null)[] = [];
    const noop = () => {};
    const services = {
      queryClient: query,
      api: createAdminApi({
        baseUrl: "http://asset-confirm.test",
        build: "test",
        handlers: {
          redirectToLogin: noop,
          stepUp: async () => false,
          refreshAccess: noop,
          invalidateQueries: noop,
          notify: noop,
          showBlocked: noop,
          buildMismatch: noop,
        },
        fetch: async (request) => {
          requests.push(request.clone());
          const path = new URL(request.url).pathname;
          if (request.method === "POST") {
            keys.push(request.headers.get("Idempotency-Key"));
            return new Promise<Response>((_resolve, reject) => {
              failDelete = reject;
            });
          }
          if (path.endsWith("/store-assets") && listFails) throw new Error("列表后台读取失败");
          const data = path.endsWith("/store-assets")
            ? { items: [row], total: 1, page: 1, pageSize: 20 }
            : path.endsWith("/summary")
              ? {
                  tabs: { all: 1, organizing: 0, adopted: 0 },
                  organizedCount: 1,
                  types: { image: 0, video: 0, recording: 0, audio: 0, document: 0, text: 1 },
                  awaitingPortraitConfirmCount: 0,
                  reviewOverdueCount: 0,
                }
              : asset;
          return new Response(JSON.stringify({ code: 0, message: "ok", data }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
    } as AppServices;
    let wire = assetSearch({ assetId: id });
    const change = vi.fn((next: Record<string, string>) => {
        wire = next;
      }),
      prefix = [...ASSET_READ_KEY, merchantScope(access), id];
    const view = () => {
      const root = run("root", () =>
        MerchantAssetsView({ services, storeId: id, access, search: wire, change }),
      );
      return renderElement(`content:${JSON.stringify(wire)}`, root);
    };
    view();
    await vi.waitFor(() =>
      expect(nodes(view()).some((node) => node.type === "AssetActions")).toBe(true),
    );
    call(control(view(), "AssetActions"), "open", { kind: "delete", row: asset });
    const firstEditor = control(view(), "AssetEditor");
    const intent = { kind: "delete" as const, row: asset },
      prepared = prepareAsset(intent, { ...assetDraft(intent), reason: "虚构删除原因" }, [], []);
    const panel = () => {
      const editor = control(view(), "AssetEditor");
      expect(editor.key).toBe(firstEditor.key);
      const confirm = run("confirm", () =>
        AssetConfirm({
          prepared,
          spec: { title: "删除素材", echo: [], checkLabel: "确认删除" },
          api: editor.props.api as Parameters<typeof AssetConfirm>[0]["api"],
          refresh: async () => call(editor, "refresh"),
          close: () => call(editor, "close"),
          notice: (message) => call(editor, "notice", message),
          deleteReads: editor.props.deleteReads as Parameters<
            typeof AssetConfirm
          >[0]["deleteReads"],
        }),
      );
      const modal = renderElement("shared-confirm", confirm);
      return renderElement("shared-body", modal.props.children);
    };
    call(panel(), "onInputChange", { checked: true, typed: "" });
    call(panel(), "onConfirm");
    await vi.waitFor(() => expect(keys).toHaveLength(1));
    expect(keys[0]).toMatch(/^merchant-asset-write:/u);
    const readsBeforeError = requests.filter(
      (r) => r.method === "GET" && new URL(r.url).pathname.endsWith(`/${id}`),
    ).length;
    expect(readsBeforeError).toBeGreaterThan(0);
    listFails = true;
    const listKey = [...prefix, "list", assetListQuery(id, wire)];
    await query.invalidateQueries({ queryKey: listKey, exact: true });
    expect(query.getQueryState(listKey)?.status).toBe("error");
    expect(control(view(), "AssetEditor").key).toBe(firstEditor.key);
    expect(panel().props.submitting).toBe(true);
    failDelete?.(new Error("删除结果未知"));
    await vi.waitFor(() => expect(panel().props.submitting).toBe(false));
    call(panel(), "onConfirm");
    await vi.waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
    failDelete?.(new Error("删除结果仍未知"));
    await vi.waitFor(() => expect(panel().props.submitting).toBe(false));
    listFails = false;
    call(panel(), "onCancel");
    await vi.waitFor(() => {
      expect(query.getQueryCache().findAll({ queryKey: [...prefix, "detail", id] })).toHaveLength(
        0,
      );
      expect(query.getQueryState(listKey)?.status).toBe("success");
      expect(query.isFetching()).toBe(0);
    });
    expect(change).toHaveBeenCalledWith(assetSearch({ ...wire, assetId: undefined }));
    const root = run("root", () =>
      MerchantAssetsView({ services, storeId: id, access, search: wire, change }),
    );
    expect(isValidElement<Record<string, unknown>>(root) && root.props.notice).toContain(
      "删除结果尚未确认",
    );
    expect(nodes(view()).some((node) => node.type === "AssetEditor")).toBe(false);
    expect(
      requests.filter((r) => r.method === "GET" && new URL(r.url).pathname.endsWith(`/${id}`)),
    ).toHaveLength(readsBeforeError);
    expect(query.getQueryCache().findAll({ queryKey: [...prefix, "detail", id] })).toHaveLength(0);
  });
});
