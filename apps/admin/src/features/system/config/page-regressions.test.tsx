import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type * as QueryModule from "@tanstack/react-query";
import { createAdminApi } from "../../../lib/api";
import type { AppServices } from "../../../app/services";
import type { Checklist, ChecklistBody, Param, ParamList } from "./model";

// 沿既有页面测试使用 hook/路由边界替身；执行真实页面回调和真实请求客户端，不复制提交逻辑。
const h = vi.hoisted(() => ({
  active: "params",
  cursor: 0,
  state: {} as Record<string, unknown[]>,
  search: {} as Record<string, unknown>,
  services: null as unknown as AppServices,
  params: null as unknown as ParamList,
  checklists: [] as Checklist[],
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useState: (initial: unknown) => {
    const slots = (h.state[h.active] ??= []),
      index = h.cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      slots[index],
      (next: unknown) => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next;
      },
    ];
  },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: "Link",
  getRouteApi: () => ({
    useSearch: () => h.search,
    useNavigate: () => (next: { search: Record<string, unknown> }) => {
      h.search = next.search;
    },
  }),
  useRouteContext: () => ({ services: h.services }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof QueryModule>()),
  useQuery: (options: { queryKey: unknown[] }) => ({
    data: options.queryKey.includes("params")
      ? h.params
      : options.queryKey.includes("checklists")
        ? h.checklists
        : {
            year: 2026,
            importedAt: null,
            workHours: { start: "09:00", end: "18:00" },
            holidays: [],
          },
    isPending: false,
    isError: false,
    refetch: async () => ({}),
  }),
}));
vi.mock("antd", () =>
  Object.fromEntries(
    ["Alert", "Button", "Checkbox", "DatePicker", "Input", "InputNumber", "Modal", "Select"].map(
      (name) => [name, name],
    ),
  ),
);
vi.mock("../../../components/ConfigPage", () => ({ ConfigPage: "ConfigPage" }));
vi.mock("../../../components/ConfirmAction", () => ({ ConfirmAction: "ConfirmAction" }));
vi.mock("../../../components/FormField", () => ({ FormField: "FormField" }));
vi.mock("../../../components/PageHeader", () => ({ PageHeader: "PageHeader" }));
vi.mock("../../../components/QueryTablePage", () => ({ QueryTablePage: "QueryTablePage" }));
vi.mock("../../../components/ReadOnlyValue", () => ({ ReadOnlyValue: "ReadOnlyValue" }));
vi.mock("../../../components/StateBlock", () => ({
  EmptyState: "EmptyState",
  ErrorState: "ErrorState",
}));
vi.mock("../../../lib/permissions", () => ({ useCan: () => true }));
vi.mock("./private-controls", () => ({
  DraftRejected: class extends Error {},
  ErrorSummary: "ErrorSummary",
  TypedParamField: "TypedParamField",
  UnsavedGuard: "UnsavedGuard",
}));
import { ParamsPage } from "./params-page";
import { ChecklistsPage } from "./checklists-page";

type Node = ReactElement<Record<string, unknown>>;
function descendants(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...descendants(node.props.children as ReactNode)];
}
function render(page: "params" | "checklists") {
  h.active = page;
  h.cursor = 0;
  return descendants(page === "params" ? ParamsPage() : ChecklistsPage());
}
function field(nodes: Node[], key: string) {
  return nodes.find(
    (node) => node.type === "TypedParamField" && (node.props.item as Param).key === key,
  )!;
}
function param(key: string, type: Param["type"], value: unknown, defaultValue: unknown): Param {
  return {
    key,
    group: type === "json" ? "platform" : "invoice",
    label: key,
    description: "",
    type,
    unit: type === "int" ? "天" : null,
    range: type === "int" ? { min: 1, max: 3650 } : null,
    defaultValue,
    value,
    rev: "2",
    latestRev: "2",
    effectiveAt: "2026-10-08T00:00:00Z",
    savedBy: null,
    savedAt: null,
    pending: [],
    snapshotOn: "read",
  };
}
const id = "01990000-0000-7000-8000-000000000001";
const draft: Checklist = {
  checklistTemplateId: id,
  code: "patrol.check",
  versionNo: 2,
  status: "draft",
  items: [
    { key: "check", label: "原条目", required: true, allowNa: false, merchantVisible: false },
  ],
  activatedAt: null,
  retiredAt: null,
  createdBy: null,
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:00Z",
  lockVersion: 0,
  actions: ["activate", "discard"],
};
const requests: { path: string; key: string | null; body: unknown }[] = [];
function services(fetch: (request: Request) => Promise<Response>) {
  const noop = () => {};
  h.services = {
    api: createAdminApi({
      build: "test",
      baseUrl: "https://admin.example.test",
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
        requests.push({
          path: new URL(request.url).pathname,
          key: request.headers.get("Idempotency-Key"),
          body: request.body ? await request.clone().json() : undefined,
        });
        return fetch(request);
      },
    }),
  } as AppServices;
}
const ok = (data: unknown) =>
  new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });
const stateDenied = () =>
  new Response(
    JSON.stringify({
      error: "STATE_NOT_ALLOWED",
      code: 1000,
      message: "旧草稿已退役",
      requestId: "test",
      retryable: false,
    }),
    { status: 409, headers: { "Content-Type": "application/json" } },
  );
beforeEach(() => {
  h.state = {};
  h.search = { group: "invoice", year: 2026 };
  h.params = {
    items: [
      param("invoice.apply_within_days", "int", 30, null),
      param("platform.legal_entity", "json", { name: "原主体" }, null),
    ],
    groups: [
      { group: "invoice", title: "开票" },
      { group: "platform", title: "平台信息" },
    ],
    lastSaved: null,
  };
  h.checklists = [structuredClone(draft)];
  requests.length = 0;
});

describe("W207 实际页面失败恢复", () => {
  it("合法数值参数清空保持null并实际提交null及原CAS版本", async () => {
    services(async () => ok(h.params));
    (field(render("params"), "invoice.apply_within_days").props.onChange as (value: null) => void)(
      null,
    );
    let nodes = render("params");
    expect(field(nodes, "invoice.apply_within_days").props.value).toBeNull();
    (nodes.find((node) => node.type === "ConfigPage")!.props.onSubmit as () => void)();
    nodes = render("params");
    const confirmation = nodes.find((node) => node.type === "ConfirmAction");
    expect(confirmation, "合法不设值应进入真实确认流程").toBeDefined();
    const result = await (
      confirmation!.props.onConfirm as (value: { idempotencyKey: string }) => Promise<unknown>
    )({ idempotencyKey: "nullable-param-save" });
    expect(result).toEqual({ outcome: "done" });
    expect(requests).toEqual([
      {
        path: "/api/v1/admin/param-values",
        key: "nullable-param-save",
        body: { items: [{ key: "invoice.apply_within_days", value: null, expectedRev: "2" }] },
      },
    ]);
  });

  it("JSON不设草稿切组再回来仍回显null，不能显示原对象而提交null", () => {
    h.search.group = "platform";
    services(async () => ok(h.params));
    (field(render("params"), "platform.legal_entity").props.onChange as (value: null) => void)(
      null,
    );
    const switchGroup = (group: string) => {
      const groupField = render("params").find(
        (node) => node.type === "FormField" && node.props.label === "参数分组",
      )!;
      const select = (groupField.props.children as (props: object) => Node)({});
      (select.props.onChange as (group: string) => void)(group);
    };
    switchGroup("invoice");
    switchGroup("platform");
    expect(field(render("params"), "platform.legal_entity").props.value).toBeNull();
  });

  it("旧草稿退役成功、创建失败后，改内容和创建键仍能完成新建", async () => {
    let retired = false,
      creates = 0;
    const replay = new Set<string>();
    services(async (request) => {
      if (request.url.endsWith("/discard")) {
        const key = request.headers.get("Idempotency-Key")!;
        if (replay.has(key)) return ok({ ...draft, status: "retired" });
        if (retired) return stateDenied();
        replay.add(key);
        retired = true;
        return ok({ ...draft, status: "retired" });
      }
      if (++creates === 1) throw new Error("创建暂时不可达");
      return ok({ ...draft, versionNo: 3 });
    });
    const save = openChecklistEditor();
    expect(await save(body("第一次修订"), "create-first")).toMatchObject({
      message: "创建暂时不可达",
    });
    expect(await save(body("再次修改后修订"), "create-changed")).toEqual({});
    expect(requests.filter((request) => request.path.endsWith("/discard"))).toHaveLength(1);
    expect(requests.filter((request) => !request.path.endsWith("/discard"))).toMatchObject([
      { key: "create-first", body: body("第一次修订") },
      { key: "create-changed", body: body("再次修改后修订") },
    ]);
  });

  it("退役响应未知时沿同一退役键回放，创建内容变化不重复退役", async () => {
    let retired = false;
    const replay = new Set<string>();
    services(async (request) => {
      if (request.url.endsWith("/discard")) {
        const key = request.headers.get("Idempotency-Key")!;
        if (replay.has(key)) return ok({ ...draft, status: "retired" });
        if (retired) return stateDenied();
        replay.add(key);
        retired = true;
        throw new Error("退役响应丢失");
      }
      return ok({ ...draft, versionNo: 3 });
    });
    const save = openChecklistEditor();
    expect(await save(body("原修订"), "unknown-first")).toMatchObject({ message: "退役响应丢失" });
    expect(await save(body("修改后修订"), "unknown-changed")).toEqual({});
    const discards = requests.filter((request) => request.path.endsWith("/discard"));
    expect(discards).toHaveLength(2);
    expect(discards[0]!.key).toBe(discards[1]!.key);
    expect(requests.at(-1)).toMatchObject({ key: "unknown-changed", body: body("修改后修订") });
  });

  it("别的操作人已退役时仍拒绝，不把STATE_NOT_ALLOWED冒充本次成功", async () => {
    services(async (request) => (request.url.endsWith("/discard") ? stateDenied() : ok(draft)));
    expect(await openChecklistEditor()(body("修订"), "concurrent-retired")).toMatchObject({
      message: "旧草稿已退役",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe(`/api/v1/admin/checklist-templates/${id}/discard`);
  });
});
function body(label: string): ChecklistBody {
  return { code: "patrol.check", items: [{ ...draft.items[0]!, label }] };
}
function openChecklistEditor() {
  h.search = { id, page: 1, pageSize: 20 };
  const details = render("checklists").find((node) => node.type === "Modal")!;
  const edit = descendants(details).find(
    (node) => node.type === "Button" && node.props.children === "放弃旧草稿并创建修订版本",
  )!;
  (edit.props.onClick as () => void)();
  const editor = render("checklists").find(
    (node) => typeof node.type === "function" && node.type.name === "ChecklistEditor",
  )!;
  return editor.props.save as (
    body: ChecklistBody,
    key: string,
  ) => Promise<{ message?: string; errors?: Record<string, string> }>;
}
