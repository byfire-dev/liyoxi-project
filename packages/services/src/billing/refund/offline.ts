import { calendarDate } from "@liyoxi/shared/time";
import type { RefundOfflineBody } from "@liyoxi/contract";
import { AppError, lockRows, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type { StaffContext } from "../../authz/index.js";
import { sealBankAccount } from "../../security/index.js";
import { lockBankSerial, normalizeBankSerial } from "../payment/transfer-review.js";
import { assertStaff, confirmMoney, lockRefund, visible } from "./context.js";
import type { RefundDeps } from "./context.js";
import { executionGuards, refundNumber, revoke } from "./saga.js";
import { applyRefundCash } from "./result.js";
import { completed, executionTimer } from "./state.js";

export async function recordOffline(
  tx: Tx,
  deps: RefundDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  input: RefundOfflineBody,
) {
  await assertStaff(tx, deps, ctx, staff, "finance.refund.execute");
  await visible(tx, staff, id);
  const state = await lockRefund(tx, id);
  confirmMoney(state, input.confirm);
  if (!input.confirmChecks.includes("offline_transfer_checked"))
    throw new AppError("CONFIRM_MISMATCH");
  await executionGuards(tx, deps, staff, state);
  if (input.transferDate > calendarDate(deps.clock.now())) throw new AppError("VALIDATION_FAILED");
  const serial = normalizeBankSerial(input.bankSerialNo);
  if (!serial) throw new AppError("VALIDATION_FAILED");
  await lockBankSerial(tx, serial);
  if (await tx.refundTxn.findFirst({ where: { channel: "offline", channelRefundNo: serial } }))
    throw new AppError("BANK_SERIAL_DUPLICATE");
  if (state.receipt.channel === "bank_transfer") {
    const entity = state.request.entityId
      ? await tx.entity.findUniqueOrThrow({ where: { id: state.request.entityId } })
      : null;
    if (!entity?.name || input.payeeName !== entity.name) throw new AppError("PAYEE_NAME_MISMATCH");
  } else if (!input.note) throw new AppError("VALIDATION_FAILED");
  await lockRows(tx, "file_object", [input.receiptFileId]);
  const file = await tx.fileObject.findUnique({ where: { id: input.receiptFileId } });
  if (
    !file ||
    file.status !== "stored" ||
    file.category !== "pay_receipt" ||
    file.moderationState === "block" ||
    file.uploadActorType !== "staff" ||
    file.uploadActorId !== staff.staff.id ||
    (state.request.entityId
      ? file.scopeType !== "entity" || file.entityId !== state.request.entityId
      : file.scopeType !== "platform")
  )
    throw new AppError("FILE_NOT_USABLE");
  const outRefundNo = await refundNumber(tx, state);
  await revoke(tx, deps, ctx, state);
  const sealed = sealBankAccount(
      deps.keyring(),
      "refund_txn.payee_account_enc",
      input.payeeAccount,
    ),
    now = deps.clock.now();
  const txn = await tx.refundTxn.create({
    data: {
      id: uuidv7(),
      entityId: state.request.entityId,
      refundRequestId: id,
      billingOrderId: state.request.billingOrderId,
      paymentTxnId: state.receipt.id,
      channel: "offline",
      origin: "system",
      outRefundNo,
      amountFen: state.request.amountFen,
      status: "succeeded",
      channelRefundNo: serial,
      successAt: now,
      transferDate: new Date(`${input.transferDate}T00:00:00.000Z`),
      payeeName: input.payeeName,
      payeeBank: input.payeeBank,
      payeeAccountEnc: sealed.enc,
      payeeAccountMask: sealed.mask,
      receiptFileId: file.id,
      registeredByStaffId: staff.staff.id,
      note: input.note ?? null,
      reconState: "matched",
      createdAt: now,
      updatedAt: now,
    },
  });
  await deps.media.link(tx, {
    fileId: file.id,
    refType: "refund_txn",
    refId: txn.id,
    role: "receipt",
    entityId: state.request.entityId,
    storeId: null,
  });
  await tx.refundRequest.update({
    where: { id },
    data: {
      execRoute: "offline",
      executedByStaffId: staff.staff.id,
      executedAt: now,
      updatedAt: now,
    },
  });
  await applyRefundCash(tx, deps, state, txn);
  await completed(tx, deps, state, true);
  await executionTimer(tx, deps, state);
  return id;
}
