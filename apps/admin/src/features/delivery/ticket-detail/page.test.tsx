import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "../../../app/services";
import { createAdminApi } from "../../../lib/api";
import type { Plan, Ticket } from "./api";
import { DETAIL_KEY } from "./model";
import { batchId } from "./batch-test.fixture";

const h = vi.hoisted(() => ({ services: null as unknown as AppServices, tab: "plan" }));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({
    useParams: () => ({ ticketNo: "LYT-plan-feedback" }),
    useSearch: () => ({ tab: h.tab }),
    useNavigate: () => vi.fn(),
  }),
  useRouteContext: () => ({ services: h.services }),
  useRouterState: () => undefined,
}));
import { TicketDetailPage } from "./page";

const planId = batchId(401);
const at = "2026-10-27T06:59:42.000Z";
const store: Plan["store"] = {
  storeId: batchId(402),
  storeName: "方案反馈测试门店",
  entityId: batchId(403),
  entityName: "方案反馈测试主体",
  city: null,
  district: null,
  qualificationStatus: "verified",
};
const initialPlan: Plan = {
  deliveryPlanId: planId,
  orderId: batchId(404),
  orderNo: "LYD-plan-feedback",
  store,
  status: "drafting",
  draft: { focus: [], referenceAssets: [], note: null, launchMode: "merchant_self", items: [] },
  draftLockVersion: 0,
  currentVersionNo: 0,
  confirmedVersionNo: null,
  pushedAt: null,
  confirmedAt: null,
  staffDueAt: null,
  isOrderInAfterSale: false,
  versions: [],
  changeRequests: [],
  itemWindows: [],
  lockVersion: 0,
  actions: ["draft-replace", "push"],
};
// 缓存当前页签读取的真实 DTO 字段；未选中的页签不挂载。
const ticket = {
  deliveryTicketId: batchId(405),
  ticketNo: "LYT-plan-feedback",
  store,
  dramaTitle: "方案反馈测试剧目",
  episodeCount: 2,
  step: "plan_confirm",
  stages: [],
  plan: { deliveryPlanId: planId },
  merchant: { contactName: null, contactPhoneMask: null },
  order: { orderNo: initialPlan.orderNo, submittedAt: at, totalChargePoints: 100, siblings: [] },
  deliveryManager: null,
  editor: null,
  publisher: null,
  stepDueAt: null,
  deliveryTargetAt: at,
  usageEndDate: "2027-10-27",
} satisfies Pick<
  Ticket,
  | "deliveryTicketId"
  | "ticketNo"
  | "store"
  | "dramaTitle"
  | "episodeCount"
  | "step"
  | "stages"
  | "deliveryManager"
  | "editor"
  | "publisher"
  | "stepDueAt"
  | "deliveryTargetAt"
  | "usageEndDate"
> & {
  plan: Pick<NonNullable<Ticket["plan"]>, "deliveryPlanId">;
  merchant: Pick<Ticket["merchant"], "contactName" | "contactPhoneMask">;
  order: Pick<Ticket["order"], "orderNo" | "submittedAt" | "totalChargePoints" | "siblings">;
};
let query: QueryClient;
beforeEach(() => {
  h.tab = "plan";
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const noop = () => {};
  h.services = {
    queryClient: query,
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
      fetch: async () => {
        throw new Error("静态渲染应使用缓存中的服务端详情");
      },
    }),
  } as AppServices;
  query.setQueryData([...DETAIL_KEY, ticket.ticketNo], ticket);
  query.setQueryData([...DETAIL_KEY, "plan", planId], initialPlan);
});
afterEach(() => query.clear());
function render() {
  return renderToStaticMarkup(
    <QueryClientProvider client={query}>
      <TicketDetailPage />
    </QueryClientProvider>,
  );
}
function serverPlan(patch: Partial<Plan>) {
  query.setQueryData<Plan>([...DETAIL_KEY, "plan", planId], (previous) => ({
    ...previous!,
    ...patch,
  }));
}
function serverSample(url: string) {
  h.tab = "sample";
  const sampleCache = {
    versionNo: 1,
    uploadedBy: { name: "样片测试剪辑师" },
    uploadedAt: at,
    qc: null,
    preview: { url, expiresAt: "2026-10-27T08:00:00.000Z", posterUrl: null },
    actions: [],
  } satisfies Pick<
    NonNullable<Ticket["currentSample"]>,
    "versionNo" | "uploadedAt" | "qc" | "preview" | "actions"
  > & {
    uploadedBy: Pick<NonNullable<Ticket["currentSample"]>["uploadedBy"], "name">;
  };
  query.setQueryData([...DETAIL_KEY, ticket.ticketNo], {
    ...ticket,
    step: "sample_making",
    actions: [],
    currentSample: sampleCache,
  });
}
describe("工单详情的方案推送反馈", () => {
  it("草稿推送后展示服务端版本、待确认状态与北京时间，重推后更新版本和时间", () => {
    let html = render();
    expect(html).toContain("<dt>推送情况</dt><dd>尚未推送</dd>");
    expect(html).toContain("<dt>确认情况</dt><dd>尚未确认</dd>");
    expect(html).toContain("<dt>最近推送</dt><dd>—</dd>");

    serverPlan({ status: "pending_confirm", currentVersionNo: 1, pushedAt: at });
    html = render();
    expect(html).toContain("<dt>推送情况</dt><dd>已推送第 1 版</dd>");
    expect(html).toContain("<dt>确认情况</dt><dd>等待商家确认</dd>");
    expect(html).toContain("<dt>最近推送</dt><dd>2026-10-27 14:59</dd>");
    expect(html).not.toContain("尚未推送");
    expect(html).not.toContain("尚未确认");

    serverPlan({ currentVersionNo: 2, pushedAt: "2026-10-27T07:05:00.000Z" });
    html = render();
    expect(html).toContain("已推送第 2 版");
    expect(html).toContain("等待商家确认");
    expect(html).toContain("2026-10-27 15:05");
    expect(html).not.toContain("已推送第 1 版");
    expect(html).not.toContain("2026-10-27 14:59");
  });

  it("已确认方案显示确认版本，要求修改的方案明确提示修改", () => {
    serverPlan({
      status: "confirmed",
      currentVersionNo: 2,
      confirmedVersionNo: 2,
      pushedAt: at,
      confirmedAt: "2026-10-27T07:01:00.000Z",
    });
    let html = render();
    expect(html).toContain("<dt>确认情况</dt><dd>已确认第 2 版</dd>");
    expect(html).not.toContain("等待商家确认");

    serverPlan({ status: "revising", confirmedVersionNo: null, confirmedAt: null });
    html = render();
    expect(html).toContain("商家要求修改，请调整方案后重新推送");
    expect(html).not.toContain("等待商家确认");
  });
});

describe("工单详情的样片预览地址", () => {
  it("配置的本地存储源走同源代理并保留签名参数，默认测试模式保持原地址", () => {
    const origin = __LYX_LOCAL_STORAGE_ORIGIN__ || "http://192.168.1.4:9110";
    const path =
      "/lyx-local-media/sample_video/preview.mp4?X-Amz-Signature=sample%2Bsignature&response-content-disposition=inline";
    serverSample(`${origin}${path}`);
    const expected = __LYX_LOCAL_STORAGE_ORIGIN__
      ? `/__lyx_local_storage${path}`
      : `${origin}${path}`;
    expect(render().match(/<video\b[^>]*\bsrc="([^"]+)"/)?.[1]).toBe(
      expected.replaceAll("&", "&amp;"),
    );
  });

  it("外部 HTTPS 样片地址和签名参数保持原样", () => {
    const url =
      "https://media.example.test/sample.mp4?X-Amz-Signature=external%2Bsignature&response-content-disposition=inline";
    serverSample(url);
    expect(render().match(/<video\b[^>]*\bsrc="([^"]+)"/)?.[1]).toBe(url.replaceAll("&", "&amp;"));
  });
});
