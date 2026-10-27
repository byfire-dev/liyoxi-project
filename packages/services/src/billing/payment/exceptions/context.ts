import type { PaymentExceptionListQuery } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { byEntity } from "../../../authz/index.js";
import type { StaffContext } from "../../../authz/index.js";
import { AppError, lockRows } from "../../../kernel/index.js";
import type { Tx } from "../../../kernel/index.js";
import type { Fulfillment } from "../../subscription/index.js";
import type { RefundDeps } from "../../refund/index.js";

export interface PaymentExceptionDeps extends RefundDeps {
  fulfillment: Fulfillment;
}
export const OPEN = ["open", "resolving"];
export function whereInScope(
  staff: StaffContext,
  query?: PaymentExceptionListQuery,
): Prisma.PaymentExceptionWhereInput {
  return {
    AND: [
      byEntity(staff.scope),
      ...(query
        ? [
            ...(query.tab === "all"
              ? []
              : [
                  {
                    status:
                      query.tab === "resolved" ? { in: ["resolved", "auto_healed"] } : query.tab,
                  },
                ]),
            ...(query.kind ? [{ kind: { in: query.kind } }] : []),
            ...(query.billDateFrom || query.billDateTo
              ? [
                  {
                    billDate: {
                      ...(query.billDateFrom
                        ? { gte: new Date(`${query.billDateFrom}T00:00:00Z`) }
                        : {}),
                      ...(query.billDateTo
                        ? { lte: new Date(`${query.billDateTo}T00:00:00Z`) }
                        : {}),
                    },
                  },
                ]
              : []),
            ...(query.q
              ? [
                  {
                    OR: [
                      { exceptionNo: { contains: query.q, mode: "insensitive" as const } },
                      {
                        billingOrder: {
                          orderNo: { contains: query.q, mode: "insensitive" as const },
                        },
                      },
                      {
                        paymentTxn: {
                          channelTxnNo: { contains: query.q, mode: "insensitive" as const },
                        },
                      },
                      { entity: { name: { contains: query.q, mode: "insensitive" as const } } },
                    ],
                  },
                ]
              : []),
          ]
        : []),
    ],
  };
}
export async function visible(tx: Tx, staff: StaffContext, id: string) {
  const row = await tx.paymentException.findFirst({ where: { id, ...whereInScope(staff) } });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}
/** 先发现整组低阶行，再按290/300/310/320/330/340排序；refund分支须由W410先建审批并取低阶锁。 */
export async function lockException(tx: Tx, id: string, linkOrderId?: string) {
  const before = await tx.paymentException.findUniqueOrThrow({ where: { id } });
  const orderId = linkOrderId ?? before.billingOrderId;
  if (orderId) await lockRows(tx, "billing_order", [orderId]);
  if (before.paymentTxnId) await lockRows(tx, "payment_txn", [before.paymentTxnId]);
  const proofs = orderId
    ? await tx.transferProof.findMany({
        where: { billingOrderId: orderId },
        orderBy: { id: "asc" },
      })
    : [];
  await lockRows(
    tx,
    "transfer_proof",
    proofs.map((p) => p.id),
  );
  const refunds = before.paymentTxnId
    ? await tx.refundTxn.findMany({
        where: { paymentTxnId: before.paymentTxnId },
        orderBy: { id: "asc" },
      })
    : [];
  await lockRows(
    tx,
    "refund_txn",
    refunds.map((r) => r.id),
  );
  const invoices = orderId
    ? await tx.invoiceRequest.findMany({
        where: { billingOrderId: orderId },
        orderBy: { id: "asc" },
      })
    : [];
  await lockRows(
    tx,
    "invoice_request",
    invoices.map((i) => i.id),
  );
  const exceptions = before.paymentTxnId
    ? await tx.paymentException.findMany({
        where: { paymentTxnId: before.paymentTxnId },
        orderBy: { id: "asc" },
      })
    : [before];
  await lockRows(
    tx,
    "payment_exception",
    [...new Set([id, ...exceptions.map((e) => e.id)])].sort(),
  );
  const exception = await tx.paymentException.findUniqueOrThrow({ where: { id } });
  if (
    exception.paymentTxnId !== before.paymentTxnId ||
    exception.billingOrderId !== before.billingOrderId
  )
    throw new AppError("PRECONDITION_CHANGED");
  return {
    exception,
    order: orderId ? await tx.billingOrder.findUniqueOrThrow({ where: { id: orderId } }) : null,
    receipt: before.paymentTxnId
      ? await tx.paymentTxn.findUniqueOrThrow({ where: { id: before.paymentTxnId } })
      : null,
    refunds: await tx.refundTxn.findMany({
      where: { id: { in: refunds.map((r) => r.id) } },
      orderBy: { id: "asc" },
    }),
    invoices: await tx.invoiceRequest.findMany({
      where: { id: { in: invoices.map((r) => r.id) } },
      orderBy: { id: "asc" },
    }),
    proofs: await tx.transferProof.findMany({
      where: { id: { in: proofs.map((r) => r.id) } },
      orderBy: { id: "asc" },
    }),
  };
}
export type LockedException = Awaited<ReturnType<typeof lockException>>;
