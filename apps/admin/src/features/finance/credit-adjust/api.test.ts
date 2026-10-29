import { expect, it } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { adjustmentError, createAdjustmentApi, needsReconfirm } from "./api";
import { extensionCase, genericDetail, ids, pointCase } from "./fixtures.test-support";
const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data, message: "ok" }), {
    headers: { "Content-Type": "application/json" },
  });
function transport(fetch: (request: Request) => Promise<Response>) {
  const handlers: ApiHandlers = {
    redirectToLogin() {},
    stepUp: async () => false,
    refreshAccess() {},
    invalidateQueries() {},
    notify() {},
    showBlocked() {},
    buildMismatch() {},
  };
  return createAdjustmentApi({
    api: createAdminApi({
      baseUrl: "https://finance.example.test",
      build: "w418",
      handlers,
      fetch,
    }),
  });
}
it("真实中央客户端读取两类型：审批ID仅用于审批GET，核定领域链接后才用不同业务ID取真实详情", async () => {
  const requests: Request[] = [],
    signal = new AbortController().signal,
    point = pointCase(),
    extension = extensionCase();
  const api = transport(async (request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    return ok(
      path.endsWith(ids.pointApproval)
        ? genericDetail(point)
        : path.endsWith(ids.extensionApproval)
          ? genericDetail(extension)
          : path.endsWith(ids.point)
            ? point.row
            : extension.row,
    );
  });
  expect(await api.get(ids.pointApproval, ["points_adjust"], signal)).toMatchObject({
    kind: "points_adjust",
    row: { currentSpendablePoints: 0, applied: null },
  });
  expect(await api.get(ids.extensionApproval, ["subscription_extend"], signal)).toMatchObject({
    kind: "subscription_extend",
    row: {
      preview: { mode: "revive", restorePoints: 0, shiftedTerms: [{ startDate: "2030-11-08" }] },
      applied: null,
    },
  });
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", `/api/v1/admin/approvals/${ids.pointApproval}`],
    ["GET", `/api/v1/admin/point-adjustment-requests/${ids.point}`],
    ["GET", `/api/v1/admin/approvals/${ids.extensionApproval}`],
    ["GET", `/api/v1/admin/term-extension-requests/${ids.extension}`],
  ]);
  for (const change of ["operation", "domain", "approvalId", "denied"] as const) {
    let calls = 0;
    const failing = transport(async () => {
      calls += 1;
      const detail = genericDetail(point);
      if (change === "operation") detail.operations.get = "admin.paymentOrder.get";
      if (change === "domain") detail.domain.type = "refund_request";
      if (change === "approvalId") detail.approvalId = ids.extensionApproval;
      return ok(detail);
    });
    await expect(
      failing.get(
        ids.pointApproval,
        change === "denied" ? ["subscription_extend"] : ["points_adjust"],
        signal,
      ),
    ).rejects.toMatchObject({
      symbol: change === "denied" ? "PERMISSION_DENIED" : "RESPONSE_MISMATCH",
    });
    expect(calls).toBe(1);
  }
});
it("列表/统计保留真实kind/状态/日期/分页；六typed写口用领域ID、原key及正式锁版本/回显body", async () => {
  const rows: { path: string; method: string; key: string | null; body: unknown }[] = [],
    signal = new AbortController().signal;
  const api = transport(async (request) => {
    const url = new URL(request.url);
    rows.push({
      path: `${url.pathname}${url.search}`,
      method: request.method,
      key: request.headers.get("Idempotency-Key"),
      body: request.body === null ? null : await request.json(),
    });
    if (request.method === "GET")
      return ok(
        url.pathname.endsWith("summary")
          ? { items: [], total: { todo: 0, overdue: 0 }, pointsAdjustMonth: null }
          : { items: [], total: 0, page: 2, pageSize: 10 },
      );
    return ok(url.pathname.includes("point-adjustment") ? pointCase().row : extensionCase().row);
  });
  const filters = {
    kind: "points_adjust,subscription_extend",
    q: "虚构",
    overdue: "false" as const,
    submittedFrom: "2030-10-01",
  };
  expect(
    await api.list({ ...filters, status: "pending", tab: "all", page: 2, pageSize: 10 }, signal),
  ).toMatchObject({ total: 0, items: [] });
  expect(await api.summary(filters, signal)).toMatchObject({
    total: { todo: 0 },
    pointsAdjustMonth: null,
  });
  expect(
    Object.fromEntries(new URL(`https://finance.example.test${rows[0]!.path}`).searchParams),
  ).toEqual({ ...filters, status: "pending", tab: "all", page: "2", pageSize: "10" });
  for (const value of [pointCase(), extensionCase()])
    for (const action of ["approve", "reject", "withdraw"] as const)
      await api.decide(value, action, "核对后处理", `w418-${value.kind}-${action}`, signal);
  expect(rows.slice(2)).toEqual([
    {
      path: `/api/v1/admin/point-adjustment-requests/${ids.point}/approve`,
      method: "POST",
      key: "w418-points_adjust-approve",
      body: {
        lockVersion: 7,
        confirm: { requestNo: "JF-TEST-1", direction: "increase", adjustPoints: 100 },
        confirmChecks: ["basis_checked"],
      },
    },
    {
      path: `/api/v1/admin/point-adjustment-requests/${ids.point}/reject`,
      method: "POST",
      key: "w418-points_adjust-reject",
      body: { note: "核对后处理" },
    },
    {
      path: `/api/v1/admin/point-adjustment-requests/${ids.point}/withdraw`,
      method: "POST",
      key: "w418-points_adjust-withdraw",
      body: { note: "核对后处理" },
    },
    {
      path: `/api/v1/admin/term-extension-requests/${ids.extension}/approve`,
      method: "POST",
      key: "w418-subscription_extend-approve",
      body: {
        lockVersion: 7,
        confirm: { requestNo: "YC-TEST-1", days: 7 },
        confirmChecks: ["effect_preview_checked"],
      },
    },
    {
      path: `/api/v1/admin/term-extension-requests/${ids.extension}/reject`,
      method: "POST",
      key: "w418-subscription_extend-reject",
      body: { note: "核对后处理" },
    },
    {
      path: `/api/v1/admin/term-extension-requests/${ids.extension}/withdraw`,
      method: "POST",
      key: "w418-subscription_extend-withdraw",
      body: { note: "核对后处理" },
    },
  ]);
});
it("响应关联不符停止，409保安全符号供重读重确认；已取消请求确实终止fetch且不伪空成功", async () => {
  const value = pointCase(),
    signal = new AbortController().signal;
  const mismatch = transport(async () =>
    ok({ ...value.row, pointAdjustmentRequestId: ids.extension }),
  );
  await expect(mismatch.decide(value, "approve", "", "fixture:1", signal)).rejects.toMatchObject({
    symbol: "RESPONSE_MISMATCH",
  });
  const conflict = transport(
    async () =>
      new Response(
        JSON.stringify({
          code: 40901,
          error: "VERSION_CONFLICT",
          message: "PRIVATE-BODY-MUST-NOT-SHOW",
          requestId: "FICTIONAL-12345678",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
  );
  const error = await conflict
    .decide(value, "approve", "", "fixture:2", signal)
    .catch((failure: unknown) => failure);
  expect(needsReconfirm(error)).toBe(true);
  expect(adjustmentError(error)).toContain("12345678");
  expect(adjustmentError(error)).not.toContain("PRIVATE");
  let entered!: () => void;
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  let actualSignal: AbortSignal | undefined;
  const pending = transport(
    (request) =>
      new Promise<Response>((_done, reject) => {
        actualSignal = request.signal;
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
        entered();
      }),
  );
  const controller = new AbortController(),
    writing = pending.decide(value, "withdraw", "", "fixture:3", controller.signal);
  const cancelled = expect(writing).rejects.toMatchObject({ name: "AbortError" });
  await ready;
  controller.abort();
  expect(actualSignal?.aborted).toBe(true);
  await cancelled;
});
