import { randomBytes } from "node:crypto";
import type { PaymentExceptionResolveBody } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import type { StaffContext } from "../../../authz/index.js";
import { AppError, lockRows, uuidv7 } from "../../../kernel/index.js";
import type { Tx } from "../../../kernel/index.js";
import { sealBankAccount } from "../../../security/index.js";
import { lockBankSerial, normalizeBankSerial } from "../transfer-review.js";
import type { LockedException, PaymentExceptionDeps } from "./context.js";

/** bank_unmatched尚未入账；真实线下回款与证据在同TX落地，不伪造退款审批或回收权益。 */
export async function offlineReturn(
  tx: Tx,
  deps: PaymentExceptionDeps,
  staff: StaffContext,
  state: LockedException,
  input: PaymentExceptionResolveBody,
) {
  const proof = input.offlineReturn,
    receipt = state.receipt;
  if (
    !proof ||
    !receipt ||
    receipt.channel !== "bank_transfer" ||
    receipt.status !== "succeeded" ||
    receipt.billingOrderId ||
    receipt.appliedAt ||
    receipt.entityId
  )
    throw new AppError("STATE_NOT_ALLOWED");
  if (proof.transferDate > calendarDate(deps.clock.now())) throw new AppError("VALIDATION_FAILED");
  if (receipt.channelPayerRef !== proof.payeeName) throw new AppError("PAYEE_NAME_MISMATCH");
  const amount = (receipt.channelAmountFen ?? 0) - receipt.refundedFen;
  if (
    amount <= 0 ||
    state.refunds.some((r) => ["created", "processing", "abnormal"].includes(r.status))
  )
    throw new AppError("REFUND_EXCEEDS_REFUNDABLE");
  const serial = normalizeBankSerial(proof.bankSerialNo);
  if (!serial) throw new AppError("VALIDATION_FAILED");
  await lockBankSerial(tx, serial);
  if (await tx.refundTxn.findFirst({ where: { channel: "offline", channelRefundNo: serial } }))
    throw new AppError("BANK_SERIAL_DUPLICATE");
  await lockRows(tx, "file_object", [proof.receiptFileId]);
  const file = await tx.fileObject.findUnique({ where: { id: proof.receiptFileId } });
  if (
    !file ||
    file.status !== "stored" ||
    file.category !== "pay_receipt" ||
    file.moderationState === "block" ||
    file.uploadActorType !== "staff" ||
    file.uploadActorId !== staff.staff.id ||
    file.scopeType !== "platform"
  )
    throw new AppError("FILE_NOT_USABLE");
  const now = deps.clock.now(),
    sealed = sealBankAccount(deps.keyring(), "refund_txn.payee_account_enc", proof.payeeAccount);
  const refund = await tx.refundTxn.create({
    data: {
      id: uuidv7(),
      entityId: null,
      billingOrderId: null,
      paymentTxnId: receipt.id,
      refundRequestId: null,
      channel: "offline",
      origin: "system",
      outRefundNo: `${state.exception.exceptionNo}-${String(state.refunds.length + 1).padStart(2, "0")}-${randomBytes(3).toString("hex").toUpperCase()}`,
      amountFen: amount,
      status: "succeeded",
      channelRefundNo: serial,
      successAt: now,
      transferDate: new Date(`${proof.transferDate}T00:00:00Z`),
      payeeName: proof.payeeName,
      payeeBank: proof.payeeBank,
      payeeAccountEnc: sealed.enc,
      payeeAccountMask: sealed.mask,
      receiptFileId: file.id,
      registeredByStaffId: staff.staff.id,
      note: input.note,
      reconState: "matched",
      createdAt: now,
      updatedAt: now,
    },
  });
  await deps.media.link(tx, {
    fileId: file.id,
    refType: "refund_txn",
    refId: refund.id,
    role: "receipt",
    entityId: null,
    storeId: null,
  });
  await tx.paymentTxn.update({
    where: { id: receipt.id },
    data: { refundedFen: receipt.refundedFen + amount, updatedAt: now },
  });
  await tx.paymentException.update({
    where: { id: state.exception.id },
    data: { refundTxnId: refund.id, updatedAt: now },
  });
}
