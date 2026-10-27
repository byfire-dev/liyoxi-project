import type { PaymentExceptionKindCode } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { uuidv7 } from "../../../kernel/index.js";
import type { IdentityContext, Tx } from "../../../kernel/index.js";
import type { PaymentExceptionDeps } from "./context.js";

/** 真正的新差异事实；不覆盖已有单的状态或财务结论。调用方已锁所关联资金行。 */
export async function openFact(
  tx: Tx,
  deps: PaymentExceptionDeps,
  ctx: IdentityContext,
  input: {
    kind: PaymentExceptionKindCode;
    exceptionNo?: string;
    dedupeKey: string;
    entityId: string | null;
    billingOrderId: string | null;
    paymentTxnId: string;
    refundTxnId?: string;
    wxBillLineId?: string;
    amountFen: number;
    causeText: string;
    detectedBy: "manual" | "query";
    occurredAt?: Date;
    billFact?: Prisma.InputJsonObject;
    platformFact?: Prisma.InputJsonObject;
  },
) {
  const old = await tx.paymentException.findUnique({ where: { dedupeKey: input.dedupeKey } });
  if (old) return old.id;
  const now = deps.clock.now(),
    id = uuidv7();
  const inserted = await tx.paymentException.createMany({
    data: [
      {
        id,
        exceptionNo: input.exceptionNo ?? (await deps.bizNo.next(tx, "CY")),
        entityId: input.entityId,
        billingOrderId: input.billingOrderId,
        paymentTxnId: input.paymentTxnId,
        refundTxnId: input.refundTxnId ?? null,
        wxBillLineId: input.wxBillLineId ?? null,
        kind: input.kind,
        detectedBy: input.detectedBy,
        billDate: new Date(`${calendarDate(input.occurredAt ?? now)}T00:00:00Z`),
        amountFen: input.amountFen,
        causeText: input.causeText,
        dedupeKey: input.dedupeKey,
        status: "open",
        resolution: "none",
        ...(input.billFact ? { billFact: input.billFact } : {}),
        ...(input.platformFact ? { platformFact: input.platformFact } : {}),
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  if (!inserted.count)
    return (await tx.paymentException.findUniqueOrThrow({ where: { dedupeKey: input.dedupeKey } }))
      .id;
  await deps.flow.transition(tx, ctx, {
    machine: "payment_exception",
    stateField: "status",
    id,
    event: "payment_exception.open",
    ref: "08:760",
    created: true,
    ...(input.entityId ? { entityId: input.entityId } : {}),
    audit: {
      stream: "ops",
      category: "recon",
      action: "finance.payment_exception.open",
      summary: input.causeText,
      target: { type: "payment_exception", id },
    },
    emit: {
      type: "payment_exception.opened",
      payload: {
        v: 1,
        paymentExceptionId: id,
        kind: input.kind,
        billingOrderId: input.billingOrderId,
        paymentTxnId: input.paymentTxnId,
        amountFen: input.amountFen,
      },
      dedupeKey: `payment_exception.opened:${id}`,
    },
  });
  if (input.billingOrderId)
    await tx.billingOrder.update({
      where: { id: input.billingOrderId },
      data: { hasOpenException: true, updatedAt: now },
    });
  await tx.paymentTxn.update({
    where: { id: input.paymentTxnId },
    data: { reconState: "diff", updatedAt: now },
  });
  return id;
}
