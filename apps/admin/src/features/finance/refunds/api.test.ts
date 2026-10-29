import { expect, it } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { createPaymentsApi } from "../payments/api";
import { createRefundsApi, type RefundDetail } from "./api";

const id = "0199e187-e72a-7000-8000-000000000001",
  otherId = "0199e187-e72a-7000-8000-000000000002";
const at = "2030-10-18T04:00:00.000Z";
function detail(refundRequestId = id): RefundDetail {
  return {
    refundRequestId,
    requestNo: "TK-FICTIONAL-001",
    source: "staging_probe",
    entity: null,
    paymentOrder: null,
    amountFen: 1,
    ruleCode: "unapplied_receipt",
    ruleText: "未入账收款",
    status: "executing",
    closeReason: null,
    execRoute: "wechat_original",
    execDueAt: null,
    isExecOverdue: false,
    hasExecError: false,
    requester: null,
    createdAt: at,
    decidedAt: at,
    doneAt: null,
    closedAt: null,
    reason: null,
    note: null,
    isOverride: false,
    baseAmountFen: 1,
    deductAmountFen: 0,
    paymentTxn: {
      paymentTransactionId: id,
      attemptNo: 1,
      channel: "wechat_jsapi",
      status: "succeeded",
      outTradeNo: "FICTIONAL-TRADE",
      channelTxnNo: "FICTIONAL-CHANNEL",
      channelAmountFen: 1,
      feeFen: 0,
      channelSuccessAt: at,
      isApplied: false,
      refundedFen: 0,
      reconState: "pending",
      payerName: null,
      confirmedBy: null,
      reviewedBy: null,
    },
    breakdown: {
      v: 1,
      rule: "unapplied_receipt",
      refundableFen: 1,
      paymentExceptionId: id,
      exceptionNo: "CY-FICTIONAL",
      exceptionKind: "duplicate_payment",
      unappliedFen: 1,
    },
    stageNote: "预发系统退款处理中",
    recheckLog: null,
    invoice: { latest: null, needsRedInvoice: false },
    entitlementRevokedAt: null,
    executedBy: null,
    isExecutedBySystem: true,
    executedAt: at,
    voidedBy: null,
    closeNote: null,
    execError: null,
    refundTxns: [],
    allowedRoutes: [],
    canRetry: false,
    canConfirmNotAccepted: false,
    paymentException: null,
    relatedServiceTickets: [],
    approval: {
      approvalId: id,
      kind: "staging_pay_refund",
      status: "approved",
      roundNo: 1,
      submittedAt: at,
      dueAt: null,
      badges: [],
      requester: null,
      decidedBy: null,
      isDecidedBySystem: true,
      decidedAt: at,
      decisionNote: null,
      reasons: [],
      lockVersion: 1,
      actions: [],
    },
    logs: [],
    actions: [],
  };
}
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
  const api = createAdminApi({
    baseUrl: "https://finance.example.test",
    build: "w418",
    handlers,
    fetch,
  });
  return { payments: createPaymentsApi({ api }), refunds: createRefundsApi({ api }) };
}
const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data, message: "ok" }), {
    headers: { "Content-Type": "application/json" },
  });

it("W418五条读取经真实中央客户端发GET和契约筛选，零汇总/空列表不是失败", async () => {
  const requests: Request[] = [];
  const api = transport(async (request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith("payment-transactions/summary"))
      return ok({
        filtered: { count: 0, channelAmountFen: "0" },
        today: { count: 0, amountFen: "0", wechatCount: 0, bankCount: 0 },
        month: { count: 0, amountFen: "0", wechatCount: 0, bankCount: 0 },
        monthRefund: { count: 0, amountFen: "0" },
        openDiff: { count: 0, amountFen: "0", earliestBillDate: null },
      });
    if (path.endsWith("refund-requests/summary"))
      return ok({
        tabs: { pending_approval: 0, pending_execution: 0, processed: 0 },
        executingCount: 0,
        monthRefunded: { amountFen: "0", count: 0 },
        inProgressCount: 0,
        monthRejectedCount: 0,
        overdueCount: 0,
      });
    if (path.endsWith(id)) return ok(detail());
    return ok({ items: [], total: 0, page: 2, pageSize: 10 });
  });
  expect(
    await api.payments.list({
      page: 2,
      pageSize: 10,
      successFrom: "2030-10-01",
      channel: "bank_transfer",
      isApplied: "false",
    }),
  ).toMatchObject({ items: [], total: 0 });
  expect(
    await api.payments.summary({
      successFrom: "2030-10-01",
      channel: "bank_transfer",
      isApplied: "false",
    }),
  ).toMatchObject({
    filtered: { count: 0, channelAmountFen: "0" },
    openDiff: { earliestBillDate: null },
  });
  expect(
    await api.refunds.list({
      page: 2,
      pageSize: 10,
      tab: "pending_execution",
      source: "staging_probe",
    }),
  ).toMatchObject({ items: [], total: 0 });
  expect(await api.refunds.summary({ source: "staging_probe" })).toMatchObject({
    monthRefunded: { amountFen: "0", count: 0 },
  });
  expect(await api.refunds.detail(id)).toMatchObject({
    refundRequestId: id,
    source: "staging_probe",
    isExecutedBySystem: true,
    executedBy: null,
    actions: [],
  });
  expect(
    requests.map((r) => [
      r.method,
      new URL(r.url).pathname,
      Object.fromEntries(new URL(r.url).searchParams),
    ]),
  ).toEqual([
    [
      "GET",
      "/api/v1/admin/payment-transactions",
      {
        page: "2",
        pageSize: "10",
        successFrom: "2030-10-01",
        channel: "bank_transfer",
        isApplied: "false",
      },
    ],
    [
      "GET",
      "/api/v1/admin/payment-transactions/summary",
      { successFrom: "2030-10-01", channel: "bank_transfer", isApplied: "false" },
    ],
    [
      "GET",
      "/api/v1/admin/refund-requests",
      { page: "2", pageSize: "10", tab: "pending_execution", source: "staging_probe" },
    ],
    ["GET", "/api/v1/admin/refund-requests/summary", { source: "staging_probe" }],
    ["GET", `/api/v1/admin/refund-requests/${id}`, {}],
  ]);
  expect(requests.every((r) => r.body === null)).toBe(true);
});

it("W418五条读请求把取消传到实际fetch并拒绝，不吞掉取消返回空成功", async () => {
  for (const operation of [
    "payment-list",
    "payment-summary",
    "refund-list",
    "refund-summary",
    "refund-detail",
  ]) {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let fetchSignal: AbortSignal | undefined;
    const api = transport(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          fetchSignal = request.signal;
          const cancel = () => reject(request.signal.reason);
          if (request.signal.aborted) cancel();
          else request.signal.addEventListener("abort", cancel, { once: true });
          entered();
        }),
    );
    const controller = new AbortController();
    const pending =
      operation === "payment-list"
        ? api.payments.list({}, controller.signal)
        : operation === "payment-summary"
          ? api.payments.summary({}, controller.signal)
          : operation === "refund-list"
            ? api.refunds.list({}, controller.signal)
            : operation === "refund-summary"
              ? api.refunds.summary({}, controller.signal)
              : api.refunds.detail(id, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await ready;
    expect(fetchSignal?.aborted).toBe(false);
    controller.abort();
    expect(fetchSignal?.aborted).toBe(true);
    await rejected;
  }
});

it("W418拒绝其他退款ID的合法响应，当前错误不把响应原文或渠道信息映到页面", async () => {
  const mismatched = transport(async () => ok(detail(otherId)));
  await expect(mismatched.refunds.detail(id)).rejects.toThrow("退款申请已变化");
  const failed = transport(
    async () =>
      new Response(
        JSON.stringify({ code: 50001, error: "INTERNAL", message: "FICTIONAL-PRIVATE-BODY" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      ),
  );
  await expect(failed.refunds.detail(id)).rejects.toThrow(/^读取失败，请重试$/);
});
