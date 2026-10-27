import {
  PaymentExceptionDetailSchema,
  PaymentExceptionPageSchema,
  PaymentExceptionRowSchema,
} from "@liyoxi/contract";
import type { PaymentExceptionListQuery } from "@liyoxi/contract";
import type { PaymentException, Prisma } from "@liyoxi/db";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { addWorkingDays } from "@liyoxi/shared/workcal";
import { byEntity } from "../../../authz/index.js";
import type { StaffContext } from "../../../authz/index.js";
import type { Tx } from "../../../kernel/index.js";
import { loadWorkCalendar, workHoursAt } from "../../../sla/index.js";
import { assertFinanceView } from "../../finance-config/read.js";
import { describePaymentOrders } from "../describe.js";
import { entityRef, iso, staffBrief } from "../purchase-read.js";
import { receiptView } from "../../refund/quote.js";
import { OPEN, visible, whereInScope } from "./context.js";
import type { PaymentExceptionDeps } from "./context.js";
import { resolutions } from "./matrix.js";

const include = { billingOrder: true, paymentTxn: true } satisfies Prisma.PaymentExceptionInclude;
type Row = Prisma.PaymentExceptionGetPayload<{ include: typeof include }>;
async function overdueReader(tx: Tx, deps: PaymentExceptionDeps, rows: PaymentException[]) {
  const now = deps.clock.now(),
    from = rows.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), now);
  const calendar = await loadWorkCalendar(
    tx,
    { from: calendarDate(from), to: addDays(calendarDate(now), 14) },
    await workHoursAt(tx, now),
  );
  return (r: PaymentException) =>
    OPEN.includes(r.status) && addWorkingDays(calendar, r.createdAt, 1).at < now;
}
async function rowView(tx: Tx, row: Row, isOverdue: boolean) {
  return PaymentExceptionRowSchema.parse({
    paymentExceptionId: row.id,
    exceptionNo: row.exceptionNo,
    kind: row.kind,
    detectedBy: row.detectedBy,
    billDate: row.billDate.toISOString().slice(0, 10),
    entity: row.entityId ? await entityRef(tx, row.entityId) : null,
    paymentOrder: row.billingOrder
      ? {
          paymentOrderId: row.billingOrder.id,
          orderNo: row.billingOrder.orderNo,
          type: row.billingOrder.type,
          title: (
            await describePaymentOrders(tx, row.billingOrder.entityId, [row.billingOrder.orderNo])
          )[0]!.title,
        }
      : null,
    channelTxnNo: row.paymentTxn?.channelTxnNo ?? null,
    amountFen: row.amountFen,
    causeText: row.causeText,
    status: row.status,
    resolution: row.resolution,
    createdAt: iso(row.createdAt),
    resolvedAt: iso(row.resolvedAt),
    isOverdue,
  });
}
/** 只投影正式安全字段；旧收款事实键作兼容映射，绝不把任意JSON或openid/账号原样给客户端。 */
function factView(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = (key: string) => (typeof value[key] === "string" ? value[key] : undefined);
  return {
    outTradeNo: text("outTradeNo"),
    transactionId: text("transactionId") ?? text("channelTxnNo"),
    outRefundNo: text("outRefundNo"),
    refundId: text("refundId"),
    amountFen:
      typeof value.amountFen === "number" &&
      Number.isSafeInteger(value.amountFen) &&
      value.amountFen >= 0
        ? value.amountFen
        : undefined,
    state: text("state") ?? text("status"),
    occurredAt: text("occurredAt") ?? text("successAt"),
    text: text("text"),
  };
}
export async function list(
  tx: Tx,
  deps: PaymentExceptionDeps,
  staff: StaffContext,
  query: PaymentExceptionListQuery,
) {
  assertFinanceView(staff);
  const where = whereInScope(staff, query),
    total = await tx.paymentException.count({ where });
  const rows = await tx.paymentException.findMany({
    where,
    include,
    orderBy: [{ billDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    skip: (query.page - 1) * query.pageSize,
    take: query.pageSize,
  });
  const overdue = await overdueReader(tx, deps, rows);
  return PaymentExceptionPageSchema.parse({
    items: await Promise.all(rows.map((r) => rowView(tx, r, overdue(r)))),
    page: query.page,
    pageSize: query.pageSize,
    total,
  });
}
export async function detail(tx: Tx, deps: PaymentExceptionDeps, staff: StaffContext, id: string) {
  assertFinanceView(staff);
  await visible(tx, staff, id);
  const row = await tx.paymentException.findUniqueOrThrow({
    where: { id },
    include: {
      ...include,
      refundTxn: true,
      refundRequest: { include: { approvalRequest: true } },
      wxBillLine: true,
    },
  });
  const overdue = await overdueReader(tx, deps, [row]),
    allowed = resolutions(row, staff),
    receipt = row.paymentTxn,
    refund = row.refundTxn,
    line = row.wxBillLine;
  const candidates =
    row.kind === "bank_unmatched" && row.status === "open" && receipt
      ? await tx.billingOrder.findMany({
          where: {
            AND: [byEntity(staff.scope), ...(row.entityId ? [{ entityId: row.entityId }] : [])],
            channel: "bank_transfer",
            status: { in: ["pending_payment", "pending_confirmation"] },
            OR: [{ transferState: null }, { transferState: { not: "confirm_review" } }],
            amountFen: receipt.channelAmountFen ?? -1,
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 20,
        })
      : [];
  const newer =
    row.kind === "paid_after_cancel" && row.billingOrder?.cancelledAt
      ? await tx.billingOrder.findFirst({
          where: {
            entityId: row.billingOrder.entityId,
            id: { not: row.billingOrder.id },
            status: "paid",
            createdAt: { gt: row.billingOrder.cancelledAt },
          },
          orderBy: { createdAt: "asc" },
        })
      : null;
  return PaymentExceptionDetailSchema.parse({
    ...(await rowView(tx, row, overdue(row))),
    billFact: factView(row.billFact),
    platformFact: factView(row.platformFact),
    paymentTxn: receipt ? await receiptView(tx, receipt.id) : null,
    refundTxn: refund
      ? {
          refundTxnId: refund.id,
          outRefundNo: refund.outRefundNo,
          channel: refund.channel,
          origin: refund.origin,
          status: refund.status,
          amountFen: refund.amountFen,
          channelRefundNo: refund.channelRefundNo,
          submitCount: refund.submitCount,
          lastSubmitAt: iso(refund.lastSubmitAt),
          isRetryHalted: refund.isRetryHalted,
          failCode: refund.failCode,
          failMessage: refund.failMessage,
          successAt: iso(refund.successAt),
          userReceivedAccount: refund.userReceivedAccount,
          isLateSuccess: refund.isLateSuccess,
          offline:
            refund.channel === "offline"
              ? {
                  transferDate: refund.transferDate?.toISOString().slice(0, 10),
                  payeeName: refund.payeeName,
                  payeeBank: refund.payeeBank,
                  payeeAccountMask: refund.payeeAccountMask,
                  receiptFileId: refund.receiptFileId,
                  note: refund.note,
                  registeredBy: await staffBrief(tx, refund.registeredByStaffId),
                }
              : null,
        }
      : null,
    wxBillLine: line
      ? {
          wxBillLineId: line.id,
          lineNo: line.lineNo,
          lineKind: line.lineKind,
          tradedAt: line.tradedAt.toISOString(),
          outTradeNo: line.outTradeNo,
          outRefundNo: line.outRefundNo,
          orderAmountFen: line.orderAmountFen,
          refundAmountFen: line.refundAmountFen,
          matchState: line.matchState,
        }
      : null,
    allowedResolutions: allowed,
    linkCandidates: await Promise.all(
      candidates.map(async (c) => ({
        paymentOrderId: c.id,
        orderNo: c.orderNo,
        entity: await entityRef(tx, c.entityId),
        amountFen: c.amountFen,
        status: c.status,
        createdAt: c.createdAt.toISOString(),
      })),
    ),
    hints: newer
      ? [
          {
            code: "new_paid_order_after_cancel",
            text: `取消后已有新的已支付付款单 ${newer.orderNo}，请先核对再补单`,
          },
        ]
      : [],
    resolutionNote: row.resolutionNote,
    resolvedBy: await staffBrief(tx, row.resolvedByStaffId),
    refundRequest: row.refundRequest
      ? {
          refundRequestId: row.refundRequest.id,
          requestNo: row.refundRequest.approvalRequest.requestNo,
          status: row.refundRequest.status,
        }
      : null,
    lockVersion: row.lockVersion,
    actions: allowed.length ? ["resolve"] : [],
  });
}
