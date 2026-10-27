import { randomBytes } from "node:crypto";
import type { PaymentExceptionCreateBody } from "@liyoxi/contract";
import type { StaffContext } from "../../../authz/index.js";
import { AppError, uuidv7 } from "../../../kernel/index.js";
import type { IdentityContext, Tx } from "../../../kernel/index.js";
import { assertStaff } from "../../refund/context.js";
import { lockBankSerial, normalizeBankSerial, serialConflicts } from "../transfer-review.js";
import type { PaymentExceptionDeps } from "./context.js";
import { openFact } from "./facts.js";

export async function create(
  tx: Tx,
  deps: PaymentExceptionDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  input: PaymentExceptionCreateBody,
) {
  await assertStaff(tx, deps, ctx, staff, "finance.recon.resolve");
  // 没有主体的真实收款只对平台范围可见，不能由区域/主体范围新建后越权处理。
  if (staff.scope.kind !== "all") throw new AppError("PERMISSION_DENIED");
  if (new Date(input.receivedAt) > deps.clock.now()) throw new AppError("VALIDATION_FAILED");
  if (
    input.confirm.amountFen !== input.amountFen ||
    input.confirm.bankSerialNo !== input.bankSerialNo
  )
    throw new AppError("CONFIRM_MISMATCH");
  const serial = normalizeBankSerial(input.bankSerialNo);
  if (!serial) throw new AppError("VALIDATION_FAILED");
  await lockBankSerial(tx, serial);
  if (
    input.payerBankCode &&
    !(await tx.dictItem.findFirst({
      where: { dictTypeKey: "bank", code: input.payerBankCode, isEnabled: true },
    }))
  )
    throw new AppError("DICT_ITEM_DISABLED");
  const conflicts = await serialConflicts(tx, serial);
  if (
    conflicts.length &&
    (!input.payerBankCode || conflicts.some((c) => c.payerBank === input.payerBankCode))
  )
    throw new AppError("BANK_SERIAL_DUPLICATE");
  // 差异去重键按正式约定使用流水号；跨银行同号也不能挪用已有差异为本次响应。
  if (await tx.paymentException.findUnique({ where: { dedupeKey: `bank_unmatched:${serial}` } }))
    throw new AppError("BANK_SERIAL_DUPLICATE");
  const now = deps.clock.now(),
    cy = await deps.bizNo.next(tx, "CY"),
    receiptId = uuidv7();
  await tx.paymentTxn.create({
    data: {
      id: receiptId,
      entityId: null,
      billingOrderId: null,
      channel: "bank_transfer",
      attemptNo: 1,
      outTradeNo: `${cy}-01-${randomBytes(3).toString("hex").toUpperCase()}`,
      amountFen: input.amountFen,
      channelAmountFen: input.amountFen,
      channelPayerRef: input.payerName,
      status: "succeeded",
      channelTxnNo: serial,
      bankSerialRaw: input.bankSerialNo,
      payerBank: input.payerBankCode ?? null,
      channelSuccessAt: new Date(input.receivedAt),
      confirmedByStaffId: staff.staff.id,
      reconState: "diff",
      createdAt: now,
      updatedAt: now,
    },
  });
  return openFact(tx, deps, ctx, {
    kind: "bank_unmatched",
    exceptionNo: cy,
    dedupeKey: `bank_unmatched:${serial}`,
    entityId: null,
    billingOrderId: null,
    paymentTxnId: receiptId,
    amountFen: input.amountFen,
    detectedBy: "manual",
    occurredAt: new Date(input.receivedAt),
    causeText: "对公收款没有对应付款单",
    billFact: {
      transactionId: serial,
      amountFen: input.amountFen,
      state: "succeeded",
      occurredAt: input.receivedAt,
    },
    platformFact: { text: input.note },
  });
}
