import {
  RefundBreakdownSchema,
  RefundRequestDetailSchema,
  RefundRequestRowSchema,
  RefundSummarySchema,
} from "@liyoxi/contract";
import type { RefundFilter, RefundListQuery } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { byEntity, hasPermission, satisfiesLevel } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { dictRef, entityRef, iso, staffBrief } from "../payment/purchase-read.js";
import { describePaymentOrders } from "../payment/describe.js";
import { approvalOf, OPEN, visible } from "./context.js";
import type { RefundDeps } from "./context.js";
import { originalRoute, receiptView } from "./quote.js";

const rows = { approvalRequest: true, billingOrder: true } satisfies Prisma.RefundRequestInclude;
type Row = Prisma.RefundRequestGetPayload<{ include: typeof rows }>;
export const overdue = (r: Row, now: Date) =>
  r.status === "pending_approval"
    ? !!r.approvalRequest.dueAt && r.approvalRequest.dueAt < now
    : r.status === "pending_execution" && !!r.execDueAt && r.execDueAt < now;
function finance(staff: StaffContext) {
  if (!satisfiesLevel(staff.moduleLevels.finance, "view")) throw new AppError("PERMISSION_DENIED");
}
export async function rowView(tx: Tx, deps: RefundDeps, r: Row) {
  return RefundRequestRowSchema.parse({
    refundRequestId: r.id,
    requestNo: r.approvalRequest.requestNo,
    source: r.source,
    entity: r.entityId ? await entityRef(tx, r.entityId) : null,
    paymentOrder: r.billingOrder
      ? {
          paymentOrderId: r.billingOrder.id,
          orderNo: r.billingOrder.orderNo,
          type: r.billingOrder.type,
          title: (
            await describePaymentOrders(tx, r.billingOrder.entityId, [r.billingOrder.orderNo])
          )[0]!.title,
        }
      : null,
    amountFen: r.amountFen,
    ruleCode: r.ruleCode,
    ruleText: r.ruleText,
    status: r.status,
    closeReason: r.closeReason,
    execRoute: r.execRoute,
    execDueAt: iso(r.execDueAt),
    isExecOverdue:
      r.status === "pending_execution" && !!r.execDueAt && r.execDueAt < deps.clock.now(),
    hasExecError: r.execError !== null && ["executing", "pending_execution"].includes(r.status),
    requester: await staffBrief(tx, r.approvalRequest.requesterStaffId),
    createdAt: r.createdAt.toISOString(),
    decidedAt: iso(r.approvalRequest.decidedAt),
    doneAt: iso(r.doneAt),
    closedAt: iso(r.closedAt),
  });
}
function where(staff: StaffContext, query: RefundFilter): Prisma.RefundRequestWhereInput {
  return {
    AND: [
      byEntity(staff.scope),
      ...(query.entityId ? [{ entityId: query.entityId }] : []),
      ...(query.storeId ? [{ billingOrder: { storeId: query.storeId } }] : []),
      ...(query.ruleCode ? [{ ruleCode: query.ruleCode }] : []),
      ...(query.source ? [{ source: query.source }] : []),
      ...(query.q
        ? [
            {
              OR: [
                {
                  approvalRequest: {
                    requestNo: { contains: query.q, mode: "insensitive" as const },
                  },
                },
                { billingOrder: { orderNo: { contains: query.q, mode: "insensitive" as const } } },
                { entity: { name: { contains: query.q, mode: "insensitive" as const } } },
              ],
            },
          ]
        : []),
    ],
  };
}
const overdueWhere = (now: Date): Prisma.RefundRequestWhereInput => ({
  OR: [
    { status: "pending_approval", approvalRequest: { dueAt: { lt: now } } },
    { status: "pending_execution", execDueAt: { lt: now } },
  ],
});
export async function list(tx: Tx, deps: RefundDeps, staff: StaffContext, query: RefundListQuery) {
  finance(staff);
  const status =
    query.tab === "all"
      ? undefined
      : query.tab === "pending_execution"
        ? { in: ["pending_execution", "executing"] }
        : query.tab === "processed"
          ? { in: ["done", "not_executed"] }
          : "pending_approval";
  const filter = {
    AND: [
      where(staff, query),
      { status },
      ...(query.overdueOnly ? [overdueWhere(deps.clock.now())] : []),
    ],
  };
  const items = await tx.refundRequest.findMany({
    where: filter,
    include: rows,
    orderBy:
      query.tab === "pending_approval"
        ? [{ createdAt: "asc" }, { id: "asc" }]
        : query.tab === "pending_execution"
          ? [{ status: "desc" }, { execDueAt: "asc" }, { id: "asc" }]
          : [{ createdAt: "desc" }, { id: "desc" }],
    skip: (query.page - 1) * query.pageSize,
    take: query.pageSize,
  });
  return {
    items: await Promise.all(items.map((r) => rowView(tx, deps, r))),
    page: query.page,
    pageSize: query.pageSize,
    total: await tx.refundRequest.count({ where: filter }),
  };
}
export async function summary(tx: Tx, deps: RefundDeps, staff: StaffContext, query: RefundFilter) {
  finance(staff);
  const base = where(staff, query),
    now = deps.clock.now(),
    month = calendarDate(now).slice(0, 7),
    from = new Date(`${month}-01T00:00:00+08:00`),
    end = new Date(
      Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1) - 8 * 3_600_000,
    );
  const monthRows = await tx.refundRequest.findMany({
    where: { AND: [base, { status: "done", doneAt: { gte: from, lt: end } }] },
    select: { id: true },
  });
  const [money] = await tx.$queryRaw<
    { amount: string }[]
  >`SELECT COALESCE(sum(amount_fen),0)::text AS amount FROM refund_request WHERE id = ANY(${monthRows.map((r) => r.id)}::uuid[])`;
  const count = (filter: Prisma.RefundRequestWhereInput) =>
    tx.refundRequest.count({
      where: { AND: [base, ...(query.overdueOnly ? [overdueWhere(now)] : []), filter] },
    });
  const tabs = {
    pending_approval: await count({ status: "pending_approval" }),
    pending_execution: await count({ status: { in: ["pending_execution", "executing"] } }),
    processed: await count({ status: { in: ["done", "not_executed"] } }),
  };
  return RefundSummarySchema.parse({
    tabs,
    executingCount: await count({ status: "executing" }),
    monthRefunded: { amountFen: money?.amount ?? "0", count: monthRows.length },
    inProgressCount: tabs.pending_approval + tabs.pending_execution,
    monthRejectedCount: await count({ closeReason: "rejected", closedAt: { gte: from, lt: end } }),
    overdueCount: await count(overdueWhere(now)),
  });
}
export async function detail(tx: Tx, deps: RefundDeps, staff: StaffContext, id: string) {
  if (
    !["finance", "order"].some((m) =>
      satisfiesLevel(staff.moduleLevels[m as "finance" | "order"], "view"),
    )
  )
    throw new AppError("PERMISSION_DENIED");
  await visible(tx, staff, id, true);
  const r = await tx.refundRequest.findUniqueOrThrow({
    where: { id },
    include: {
      ...rows,
      refundTxns: { orderBy: { createdAt: "asc" } },
      paymentExceptions: true,
      paymentTxn: true,
    },
  });
  const invoice = r.billingOrderId
    ? await tx.invoiceRequest.findFirst({
        where: { billingOrderId: r.billingOrderId },
        orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
      })
    : null;
  const approval = await approvalOf(deps).decisionView(tx, staff, r.approvalRequestId),
    open = r.refundTxns.find((t) => OPEN.includes(t.status));
  const canRetry = r.status === "executing" && open?.status === "created";
  const canConfirm =
    canRetry &&
    !!open &&
    open.isRetryHalted &&
    !!open.lastSubmitAt &&
    deps.clock.now().getTime() - open.lastSubmitAt.getTime() >= 600_000;
  const allowedRoutes =
    r.status === "pending_execution" &&
    !open &&
    !["issued", "red_pending"].includes(invoice?.status ?? "")
      ? [...((await originalRoute(tx, deps, r.paymentTxn)) ? ["wechat_original"] : []), "offline"]
      : [];
  const actions: string[] = [
    ...approval.actions.filter((a) => ["approve", "reject", "withdraw"].includes(a)),
  ];
  if (hasPermission(staff, "finance.refund.execute")) {
    if (allowedRoutes.includes("wechat_original")) actions.push("execute");
    if (allowedRoutes.includes("offline")) actions.push("record-offline");
    if (canRetry) actions.push("retry");
    if (canConfirm) actions.push("confirm-not-accepted");
  }
  if (
    r.status === "pending_execution" &&
    !r.entitlementRevokedAt &&
    !r.refundTxns.some((t) => ["succeeded", ...OPEN].includes(t.status)) &&
    hasPermission(staff, "finance.refund.approve")
  )
    actions.push("void");
  const history = await tx.statusTransition.findMany({
    where: {
      OR: [
        { machine: "refund_request", subjectId: r.id },
        { machine: "approval_request", subjectId: r.approvalRequestId },
      ],
    },
    orderBy: { seq: "asc" },
  });
  const audits = await tx.auditLog.findMany({
    where: { targetType: "refund_request", targetId: r.id },
    orderBy: { createdAt: "asc" },
  });
  const logs = [
    ...history.map((h) => ({
      at: h.occurredAt.toISOString(),
      actor: h.actorType,
      action: h.event,
      note: h.note,
    })),
    ...audits.map((a) => ({
      at: a.createdAt.toISOString(),
      actor: a.actorName ?? a.actorType,
      action: a.action,
      note: a.summary,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return RefundRequestDetailSchema.parse({
    ...(await rowView(tx, deps, r)),
    reason: await dictRef(tx, "refund_reason", r.reasonCode),
    note: r.note,
    isOverride: r.isOverride,
    baseAmountFen: r.baseAmountFen,
    deductAmountFen: r.deductAmountFen,
    paymentTxn: await receiptView(tx, r.paymentTxnId),
    breakdown: RefundBreakdownSchema.parse(r.breakdownSnapshot),
    stageNote: r.ruleText,
    recheckLog: r.recheckLog,
    invoice: {
      latest: invoice
        ? { invoiceRequestId: invoice.id, requestNo: invoice.requestNo, status: invoice.status }
        : null,
      needsRedInvoice: !!invoice && ["issued", "red_pending"].includes(invoice.status),
    },
    entitlementRevokedAt: iso(r.entitlementRevokedAt),
    executedBy: await staffBrief(tx, r.executedByStaffId),
    executedAt: iso(r.executedAt),
    voidedBy: await staffBrief(tx, r.voidedByStaffId),
    closeNote: r.closeNote,
    execError: r.execError,
    refundTxns: await Promise.all(
      r.refundTxns.map(async (t) => ({
        refundTxnId: t.id,
        outRefundNo: t.outRefundNo,
        channel: t.channel,
        origin: t.origin,
        status: t.status,
        amountFen: t.amountFen,
        channelRefundNo: t.channelRefundNo,
        submitCount: t.submitCount,
        lastSubmitAt: iso(t.lastSubmitAt),
        isRetryHalted: t.isRetryHalted,
        failCode: t.failCode,
        failMessage: t.failMessage,
        successAt: iso(t.successAt),
        userReceivedAccount: t.userReceivedAccount,
        isLateSuccess: t.isLateSuccess,
        offline:
          t.channel === "offline"
            ? {
                transferDate: t.transferDate?.toISOString().slice(0, 10),
                payeeName: t.payeeName,
                payeeBank: t.payeeBank,
                payeeAccountMask: t.payeeAccountMask,
                receiptFileId: t.receiptFileId,
                note: t.note,
                registeredBy: await staffBrief(tx, t.registeredByStaffId),
              }
            : null,
      })),
    ),
    allowedRoutes,
    canRetry,
    canConfirmNotAccepted: canConfirm,
    paymentException: r.paymentExceptions[0]
      ? {
          paymentExceptionId: r.paymentExceptions[0].id,
          exceptionNo: r.paymentExceptions[0].exceptionNo,
          kind: r.paymentExceptions[0].kind,
        }
      : null,
    relatedServiceTickets: r.entityId
      ? await deps.approvalRefs.list(tx, {
          approvalRequestId: r.approvalRequestId,
          entityId: r.entityId,
        })
      : [],
    approval,
    logs,
    actions,
  });
}
