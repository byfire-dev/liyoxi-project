import { wechatReceiptMatches } from "./channel-success.js";
// W1-11a b：数据守卫由入账层复核；权限、再验证与凭证在 W1-11b。
import { chainKey, rowKey } from "../../flow/index.js";
import type { Guard, MachineBinding } from "../../flow/index.js";

const paid: Guard = async (tx, facts) => {
  const id = (facts.args as { paymentTxnId?: string } | undefined)?.paymentTxnId;
  if (id === undefined) return false;
  const [order, receipt] = await Promise.all([
    tx.billingOrder.findUnique({ where: { id: facts.subjectId } }),
    tx.paymentTxn.findUnique({ where: { id } }),
  ]);
  return (
    order !== null &&
    receipt !== null &&
    receipt.status === "succeeded" &&
    receipt.appliedAt === null &&
    receipt.refundedFen < (receipt.channelAmountFen ?? 0) &&
    receipt.billingOrderId === order.id &&
    receipt.entityId === order.entityId &&
    receipt.channel === order.channel &&
    receipt.channelAmountFen === order.amountFen &&
    wechatReceiptMatches(order, receipt)
  );
};
const mismatch: Guard = async (tx, facts) => {
  const id = (facts.args as { paymentTxnId?: string } | undefined)?.paymentTxnId;
  if (id === undefined || !["amount_mismatch", "payer_mismatch"].includes(facts.reasonCode ?? ""))
    return false;
  const [order, receipt] = await Promise.all([
    tx.billingOrder.findUnique({ where: { id: facts.subjectId } }),
    tx.paymentTxn.findUnique({ where: { id } }),
  ]);
  return (
    order !== null &&
    receipt !== null &&
    receipt.status === "succeeded" &&
    receipt.appliedAt === null &&
    receipt.refundedFen < (receipt.channelAmountFen ?? 0) &&
    receipt.billingOrderId === order.id &&
    receipt.entityId === order.entityId &&
    receipt.channel === order.channel &&
    receipt.channelAmountFen !== null &&
    (facts.reasonCode === "amount_mismatch"
      ? receipt.channelAmountFen !== order.amountFen
      : !wechatReceiptMatches(order, receipt))
  );
};
export const paymentMachineBindings: readonly { key: string; binding: MachineBinding }[] = [
  {
    key: chainKey("billing_order", "status"),
    binding: {
      companions: [
        "paid_amount_fen",
        "paid_at",
        "paid_payment_txn_id",
        "applied_at",
        "transfer_state",
        "cancelled_at",
        "cancel_reason",
      ],
      guards: {
        [rowKey("08:164", "billing_order.apply_payment")]: paid,
        [rowKey("08:171", "billing_order.confirm_transfer")]: async (tx, facts) => {
          const order = await tx.billingOrder.findUnique({ where: { id: facts.subjectId } });
          return order?.transferState === "proof_submitted" && (await paid(tx, facts));
        },
        [rowKey("08:173", "billing_order.approve_review")]: async (tx, facts) => {
          if (!(await paid(tx, facts))) return false;
          const txnId = (facts.args as { paymentTxnId?: string })?.paymentTxnId;
          const receipt = txnId ? await tx.paymentTxn.findUnique({ where: { id: txnId } }) : null;
          const proof = receipt?.transferProofId
            ? await tx.transferProof.findUnique({ where: { id: receipt.transferProofId } })
            : null;
          const approval = proof?.reviewApprovalRequestId
            ? await tx.approvalRequest.findUnique({ where: { id: proof.reviewApprovalRequestId } })
            : null;
          const order = await tx.billingOrder.findUnique({ where: { id: facts.subjectId } });
          return (
            !!order &&
            !!receipt &&
            !!proof &&
            !!approval &&
            order.transferState === "confirm_review" &&
            proof.billingOrderId === order.id &&
            proof.entityId === order.entityId &&
            proof.reviewStatus === "accepted" &&
            proof.firstConfirm === null &&
            approval.kind === "transfer_confirm" &&
            approval.subjectType === "transfer_proof" &&
            approval.subjectId === proof.id &&
            approval.entityId === order.entityId &&
            approval.status === "approved" &&
            approval.decidedAt !== null &&
            receipt.confirmedByStaffId !== null &&
            receipt.reviewedByStaffId !== null &&
            receipt.confirmedByStaffId === approval.requesterStaffId &&
            receipt.reviewedByStaffId === approval.decidedByStaffId &&
            receipt.confirmedByStaffId !== receipt.reviewedByStaffId &&
            order.createdByStaffId !== receipt.confirmedByStaffId &&
            order.createdByStaffId !== receipt.reviewedByStaffId &&
            proof.reviewedByStaffId === receipt.reviewedByStaffId &&
            facts.ctx.actor.type === "staff" &&
            facts.ctx.actor.id === receipt.reviewedByStaffId
          );
        },
        [rowKey("08:165", "billing_order.cancel_mismatch")]: mismatch,
      },
    },
  },
  {
    key: chainKey("payment_exception", "status"),
    binding: {
      companions: ["resolved_at"],
      guards: {
        [rowKey("08:767", "payment_exception.reclassify")]: async (tx, f) => {
          const e = await tx.paymentException.findUnique({ where: { id: f.subjectId } });
          return (
            e?.kind === "bill_only" &&
            e.billingOrderId !== null &&
            e.paymentTxnId === (f.args as { paymentTxnId?: string })?.paymentTxnId
          );
        },
        [rowKey("08:761", "payment_exception.record_healed")]: async (tx, f) =>
          (await tx.paymentException.findUnique({ where: { id: f.subjectId } }))?.status ===
          "auto_healed",
        [rowKey("08:760", "payment_exception.open")]: async (tx, facts) =>
          (await tx.paymentException.findUnique({ where: { id: facts.subjectId } }))?.status ===
          "open",
      },
    },
  },
];
