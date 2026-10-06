import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type * as ReactModule from "react";
import type * as QueryModule from "@tanstack/react-query";
import { createReceiptsApi, type ReceiptRow } from "./api";
import { createAdminApi } from "../../../lib/api";
import type { AppServices } from "../../../app/services";
const h = vi.hoisted(() => ({
  pageState: undefined as { scope: string; page: number } | undefined,
  search: { tab: "processed_today", q: undefined as string | undefined },
  services: null as unknown as AppServices,
  pages: {} as Record<number, unknown>,
  effects: [] as (() => void)[],
  placeholder: false,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useState: (initial: { scope: string; page: number }) => [
    (h.pageState ??= initial),
    (next: typeof initial | ((current: typeof initial) => typeof initial)) => {
      h.pageState = typeof next === "function" ? next(h.pageState!) : next;
    },
  ],
  useRef: (initial: unknown) => ({ current: initial }),
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void) => {
    h.effects.push(fn);
  },
}));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => h.search, useNavigate: () => vi.fn() }),
  useRouteContext: () => ({ services: h.services }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof QueryModule>()),
  useQuery: (options: { queryKey: unknown[]; queryFn: () => Promise<unknown> }) => {
    void options.queryFn();
    const list = options.queryKey.includes("list");
    return {
      data: list ? h.pages[Number(options.queryKey.at(-1))] : { pending: 0, processed_today: 101 },
      isPending: false,
      isError: false,
      isFetching: false,
      isPlaceholderData: list && h.placeholder,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("antd", () =>
  Object.fromEntries(
    [
      "Alert",
      "Button",
      "Drawer",
      "Input",
      "Modal",
      "Pagination",
      "Radio",
      "Select",
      "Spin",
      "Table",
    ].map((v) => [v, v]),
  ),
);
vi.mock("../../../components/QueueWorkbench", () => ({ QueueWorkbench: "QueueWorkbench" }));
vi.mock("../../../components/PageHeader", () => ({ PageHeader: "PageHeader" }));
vi.mock("../../../lib/permissions", () => ({ useCan: () => false }));
import { ReceiptsPage } from "./page";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number): ReceiptRow => ({
  transferProofId: id(n),
  uploadNo: 1,
  paymentOrderId: id(n + 1000),
  orderNo: `FK${n}`,
  orderType: "plan_new",
  entity: {
    entityId: id(n + 2000),
    name: `主体${n}`,
    primaryStoreId: null,
    primaryStoreName: null,
    storeCount: 1,
    verificationStatus: "verified",
    managerStaff: null,
  },
  amountFen: 100,
  uploadedAt: "2026-10-06T00:00:00.000Z",
  uploadedBy: { type: "merchant", name: "老板" },
  dueAt: null,
  isOverdue: false,
  hints: [],
  reviewStatus: "accepted",
  reviewedAt: "2026-10-06T01:00:00.000Z",
  reviewedBy: null,
});
const requests: URL[] = [];
beforeEach(() => {
  h.pageState = undefined;
  h.search = { tab: "processed_today", q: undefined };
  h.effects = [];
  h.placeholder = false;
  requests.length = 0;
  h.pages = {
    1: {
      items: Array.from({ length: 100 }, (_, i) => row(i + 1)),
      page: 1,
      pageSize: 100,
      total: 101,
    },
    2: { items: [row(101)], page: 2, pageSize: 100, total: 101 },
  };
  const noop = () => {};
  const api = createAdminApi({
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
      const url = new URL(request.url);
      requests.push(url);
      const data = url.pathname.endsWith("summary")
        ? { pending: 0, processed_today: 101, pendingAmountFen: "0" }
        : h.pages[Number(url.searchParams.get("page"))];
      return new Response(JSON.stringify({ data }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  h.services = { api } as AppServices;
});
function children() {
  return (
    ReceiptsPage() as ReactElement<{ children: ReactElement<Record<string, unknown>>[] }>
  ).props.children.filter(Boolean);
}
describe("今日已处理完整分页", () => {
  it("真实total 101显示第二页入口，点击后请求page2并展示第101条；搜索/页签回第一页", async () => {
    let nodes = children();
    const paging = nodes.find((v) => v.type === "Pagination")!;
    expect(paging.props.total).toBe(101);
    expect(paging.props.pageSize).toBe(100);
    (paging.props.onChange as (page: number) => void)(2);
    nodes = children();
    const queue = nodes.find((v) => v.type === "QueueWorkbench")!.props.queue as {
      items: ReceiptRow[];
    };
    expect(queue.items.map((v) => v.transferProofId)).toEqual([id(101)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      requests
        .filter((v) => !v.pathname.endsWith("summary"))
        .map((v) => v.searchParams.get("page")),
    ).toEqual(["1", "2"]);
    const result = await createReceiptsApi(h.services).list("processed_today", undefined, 2);
    expect(result).toMatchObject({ total: 101, page: 2, pageSize: 100 });
    expect(result.items[0]!.transferProofId).toBe(id(101));
    h.search.q = "新查询";
    nodes = children();
    expect(nodes.find((v) => v.type === "Pagination")!.props.current).toBe(1);
    h.search.tab = "pending";
    nodes = children();
    expect(nodes.find((v) => v.type === "Pagination")!.props.current).toBe(1);
  });
  it("翻页占位数据不会成为可处理的旧页队列，总数下降时回最后有效页", async () => {
    const nodes = children();
    (nodes.find((v) => v.type === "Pagination")!.props.onChange as (page: number) => void)(2);
    h.placeholder = true;
    expect(children().find((v) => v.type === "QueueWorkbench")!.props.queue).toEqual({
      status: "loading",
    });
    h.placeholder = false;
    h.pages[2] = { items: [], page: 2, pageSize: 100, total: 100 };
    children();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.pageState!.page).toBe(1);
  });
});
