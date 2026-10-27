import type { PermissionKey } from "@liyoxi/contract/authz";
import { AppError, lockRows } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import { assertPermission, byEntity } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import type { BillingPurchaseDeps } from "../payment/purchase-context.js";
import { createTermRefund } from "../ledger/term-refund.js";

export interface RefundDeps extends BillingPurchaseDeps {
  isQualificationDead: (tx: Tx, entityId: string) => Promise<boolean>;
  approvalRefs: {
    prepare(tx: Tx, input: { serviceTicketId: string; entityId: string }): Promise<void>;
    attach(
      tx: Tx,
      input: { serviceTicketId: string; approvalRequestId: string; entityId: string },
    ): Promise<void>;
    list(
      tx: Tx,
      input: { approvalRequestId: string; entityId: string },
    ): Promise<{ serviceTicketId: string; ticketNo: string }[]>;
  };
  /** 只用于真实事务断点注入，不改变运行时路径。 */
  onRefundStep?: (step: "intent" | "external" | "result" | "success") => void | Promise<void>;
}
export const termsOf = (deps: RefundDeps) =>
  createTermRefund({ clock: deps.clock, events: deps.events });
export const approvalOf = (deps: RefundDeps) => {
  if (!deps.approval) throw new TypeError("退款要求真实审批运行时");
  return deps.approval;
};
export async function assertStaff(
  tx: Tx,
  deps: RefundDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  permission: PermissionKey,
  skipStepUp = false,
) {
  if (ctx.actor.type !== "staff" || ctx.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  assertPermission(staff, permission, deps.clock.now(), { skipStepUp });
  await lockRows(tx, "staff", [staff.staff.id], "share");
  const current = await tx.staff.findUnique({ where: { id: staff.staff.id } });
  if (
    !current ||
    current.status !== "active" ||
    current.staffRoleKey !== staff.staff.roleKey ||
    current.staffGroupId !== staff.staff.staffGroupId ||
    current.isLead !== staff.staff.isLead
  )
    throw new AppError("PERMISSION_DENIED");
}
export async function visible(tx: Tx, staff: StaffContext, id: string, requester = false) {
  const row = await tx.refundRequest.findFirst({
    where: {
      id,
      ...(requester && staff.scope.kind !== "all"
        ? { OR: [byEntity(staff.scope), { approvalRequest: { requesterStaffId: staff.staff.id } }] }
        : byEntity(staff.scope)),
    },
  });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

/** 先发现整笔收款相关行，再按全局序锁；回调、人工与恢复共用同一边界。账户420由领域最后获取。 */
export async function lockRefund(tx: Tx, id: string) {
  const first = await tx.refundRequest.findUniqueOrThrow({ where: { id } });
  await lockRows(tx, "approval_request", [first.approvalRequestId]);
  await lockRows(tx, "refund_request", [first.id]);
  if (first.billingOrderId) await lockRows(tx, "billing_order", [first.billingOrderId]);
  await lockRows(tx, "payment_txn", [first.paymentTxnId]);
  const txns = await tx.refundTxn.findMany({
    where: { paymentTxnId: first.paymentTxnId },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "refund_txn",
    txns.map((t) => t.id),
  );
  const invoices = first.billingOrderId
    ? await tx.invoiceRequest.findMany({
        where: { billingOrderId: first.billingOrderId },
        orderBy: { id: "asc" },
      })
    : [];
  await lockRows(
    tx,
    "invoice_request",
    invoices.map((i) => i.id),
  );
  const exceptions = await tx.paymentException.findMany({
    where: { OR: [{ paymentTxnId: first.paymentTxnId }, { refundRequestId: id }] },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "payment_exception",
    exceptions.map((e) => e.id),
  );
  const request = await tx.refundRequest.findUniqueOrThrow({ where: { id } });
  const receipt = await tx.paymentTxn.findUniqueOrThrow({ where: { id: request.paymentTxnId } });
  if (receipt.entityId !== request.entityId || receipt.billingOrderId !== request.billingOrderId)
    throw new AppError("STATE_NOT_ALLOWED");
  return {
    request,
    receipt,
    txns: await tx.refundTxn.findMany({
      where: { paymentTxnId: receipt.id },
      orderBy: { id: "asc" },
    }),
    order: request.billingOrderId
      ? await tx.billingOrder.findUniqueOrThrow({ where: { id: request.billingOrderId } })
      : null,
    approval: await tx.approvalRequest.findUniqueOrThrow({
      where: { id: request.approvalRequestId },
    }),
    invoices: first.billingOrderId
      ? await tx.invoiceRequest.findMany({
          where: { billingOrderId: first.billingOrderId },
          orderBy: { id: "asc" },
        })
      : [],
    exceptions,
  };
}
export type LockedRefund = Awaited<ReturnType<typeof lockRefund>>;
export const OPEN = ["created", "processing", "abnormal"];
export function refundable(state: Pick<LockedRefund, "receipt" | "txns">, excludeId?: string) {
  const pending = state.txns
    .filter((t) => t.id !== excludeId && OPEN.includes(t.status))
    .reduce((sum, t) => sum + t.amountFen, 0);
  return Math.max(0, (state.receipt.channelAmountFen ?? 0) - state.receipt.refundedFen - pending);
}
export function confirmMoney(
  state: LockedRefund,
  confirm: { requestNo: string; amountFen: number },
) {
  if (
    confirm.requestNo !== state.approval.requestNo ||
    confirm.amountFen !== state.request.amountFen
  )
    throw new AppError("CONFIRM_MISMATCH");
}
