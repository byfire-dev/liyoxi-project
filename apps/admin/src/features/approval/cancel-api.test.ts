import { expect, it, vi } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../lib/api";
import { cancelFixture } from "../order/orders/test-data.fixture";
import { createCancelApi } from "./cancel-api";
import { cancelCommand, cancelQuery, cancelSummaryQuery } from "./cancel-model";
const handlers = (): ApiHandlers => ({
  redirectToLogin: vi.fn(),
  stepUp: vi.fn(async () => false),
  refreshAccess: vi.fn(),
  invalidateQueries: vi.fn(),
  notify: vi.fn(),
  showBlocked: vi.fn(),
  buildMismatch: vi.fn(),
});
it("真实typed五POST路径/正文/同键及GET绑定，list和summary同筛选且零现金退款调用", async () => {
  const value = cancelFixture(),
    requests: Request[] = [];
  const api = createCancelApi({
    api: createAdminApi({
      baseUrl: "https://fictional-admin.test",
      build: "w513",
      handlers: handlers(),
      fetch: async (request) => {
        requests.push(request.clone());
        const url = new URL(request.url);
        const data = url.pathname.endsWith("/summary")
          ? {
              tabs: { pending_approval: 1, pending_execution: 2, processed: 3 },
              monthReturnedPoints: 100,
              monthDoneCount: 1,
              inProgressCount: 3,
              monthRejectedCount: 0,
              overdueCount: 0,
            }
          : url.pathname.endsWith("cancel-requests")
            ? { items: [value], total: 1, page: 1, pageSize: 20 }
            : value;
        return new Response(JSON.stringify({ code: 0, message: "ok", data }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
  });
  const signal = new AbortController().signal;
  for (const action of ["approve", "reject", "withdraw", "void", "execute"] as const)
    await api.write(
      value.cancelRequestId,
      cancelCommand(value, action, "核对原因"),
      "same-key",
      signal,
    );
  await api.get(value.cancelRequestId, signal);
  const raw = {
    cancel_kind: "order_cancel,ad_cancel",
    cancel_tab: "pending_execution",
    cancel_q: "演练",
    cancel_overdueOnly: "true",
  };
  await api.list(cancelQuery(raw), signal);
  await api.summary(cancelSummaryQuery(raw), signal);
  expect(
    requests
      .slice(0, 5)
      .map((request) => [
        request.method,
        new URL(request.url).pathname,
        request.headers.get("Idempotency-Key"),
      ]),
  ).toEqual(
    ["approve", "reject", "withdraw", "void", "execute"].map((action) => [
      "POST",
      `/api/v1/admin/cancel-requests/${value.cancelRequestId}/${action}`,
      "same-key",
    ]),
  );
  expect(await requests[0]!.json()).toMatchObject({
    lockVersion: value.approval.lockVersion,
    confirm: { totalRefundPoints: 100 },
  });
  expect(await requests[4]!.json()).toEqual({
    confirm: { requestNo: value.requestNo, totalRefundPoints: 100 },
    confirmChecks: ["order_points_checked"],
  });
  expect(requests[5]!.method).toBe("GET");
  const list = new URL(requests[6]!.url),
    summary = new URL(requests[7]!.url);
  for (const key of ["q", "kind", "overdueOnly"])
    expect(summary.searchParams.get(key)).toBe(list.searchParams.get(key));
  expect(list.searchParams.get("tab")).toBe("pending_execution");
  expect(summary.searchParams.has("tab")).toBe(false);
});
