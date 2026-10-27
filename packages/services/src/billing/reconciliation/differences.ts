import type { PaymentExceptionKindCode } from "@liyoxi/contract";
import type { PaymentTxn, Prisma, WxBillLine } from "@liyoxi/db";
import { lockRows, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type { ReconciliationDeps } from "./context.js";
import { dateValue } from "./context.js";
const OPEN = ["open", "resolving"];
export async function refreshReceipt(tx: Tx, deps: ReconciliationDeps, receipt: PaymentTxn) {
  const open = await tx.paymentException.count({
    where: { paymentTxnId: receipt.id, status: { in: OPEN } },
  });
  if (receipt.billingOrderId)
    await tx.billingOrder.update({
      where: { id: receipt.billingOrderId },
      data: {
        hasOpenException:
          (await tx.paymentException.count({
            where: { billingOrderId: receipt.billingOrderId, status: { in: OPEN } },
          })) > 0,
        updatedAt: deps.clock.now(),
      },
    });
  return open > 0;
}
export async function openDifference(
  tx: Tx,
  deps: ReconciliationDeps,
  ctx: IdentityContext,
  input: {
    kind: PaymentExceptionKindCode;
    day: string;
    key: string;
    amountFen: number;
    receipt?: PaymentTxn | null;
    line?: WxBillLine;
    refundTxnId?: string;
    cause: string;
    billFact?: Prisma.InputJsonObject;
    platformFact?: Prisma.InputJsonObject;
  },
) {
  const old =
    (input.kind === "bill_only" && input.receipt
      ? await tx.paymentException.findFirst({
          where: { paymentTxnId: input.receipt.id, kind: "bill_only" },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : null) ?? (await tx.paymentException.findUnique({ where: { dedupeKey: input.key } }));
  if (old) {
    await lockRows(tx, "payment_exception", [old.id]);
    // 同一原件行经可信查单补到现金后可补齐原空关联；已作出的人工结论不覆盖。
    const bind =
      old.status === "open" &&
      !old.paymentTxnId &&
      input.receipt &&
      input.line &&
      (!old.wxBillLineId || old.wxBillLineId === input.line.id) &&
      input.receipt.outTradeNo === input.line.outTradeNo;
    if ((!old.wxBillLineId && input.line) || bind)
      await tx.paymentException.update({
        where: { id: old.id },
        data: {
          ...(input.line ? { wxBillLineId: input.line.id } : {}),
          ...(bind
            ? {
                paymentTxnId: input.receipt!.id,
                entityId: input.receipt!.entityId,
                billingOrderId: input.receipt!.billingOrderId,
              }
            : {}),
          updatedAt: deps.clock.now(),
        },
      });
    return old.id;
  }
  const now = deps.clock.now(),
    id = uuidv7(),
    receipt = input.receipt;
  const inserted = await tx.paymentException.createMany({
    data: [
      {
        id,
        exceptionNo: await deps.bizNo.next(tx, "CY"),
        kind: input.kind,
        detectedBy: "reconciliation",
        billDate: dateValue(input.day),
        entityId: receipt?.entityId ?? null,
        billingOrderId: receipt?.billingOrderId ?? null,
        paymentTxnId: receipt?.id ?? null,
        refundTxnId: input.refundTxnId ?? null,
        wxBillLineId: input.line?.id ?? null,
        amountFen: input.amountFen,
        status: "open",
        resolution: "none",
        causeText: input.cause,
        dedupeKey: input.key,
        ...(input.billFact ? { billFact: input.billFact } : {}),
        ...(input.platformFact ? { platformFact: input.platformFact } : {}),
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  if (!inserted.count)
    return (await tx.paymentException.findUniqueOrThrow({ where: { dedupeKey: input.key } })).id;
  await deps.flow.transition(tx, ctx, {
    machine: "payment_exception",
    stateField: "status",
    id,
    event: "payment_exception.open",
    ref: "08:760",
    created: true,
    ...(receipt?.entityId ? { entityId: receipt.entityId } : {}),
    audit: {
      stream: "ops",
      category: "recon",
      action: "finance.reconciliation.exception",
      summary: input.cause,
      target: { type: "payment_exception", id },
    },
    emit: {
      type: "payment_exception.opened",
      payload: {
        v: 1,
        paymentExceptionId: id,
        kind: input.kind,
        billingOrderId: receipt?.billingOrderId ?? null,
        paymentTxnId: receipt?.id ?? null,
        amountFen: input.amountFen,
      },
      dedupeKey: `payment_exception.opened:${id}`,
    },
  });
  if (receipt) {
    await refreshReceipt(tx, deps, receipt);
    await tx.paymentTxn.update({
      where: { id: receipt.id },
      data: { reconState: "diff", updatedAt: now },
    });
  }
  return id;
}
/** 只允许正式08:768：后续真实账单出现的platform_only，不覆盖人工结论/正在退款的单。 */
export async function healPlatformOnly(
  tx: Tx,
  deps: ReconciliationDeps,
  ctx: IdentityContext,
  receipt: PaymentTxn,
  line: WxBillLine,
) {
  const rows = await tx.paymentException.findMany({
    where: {
      paymentTxnId: receipt.id,
      kind: "platform_only",
      status: "open",
      billDate: line.billDate,
    },
    orderBy: { id: "asc" },
  });
  for (const row of rows)
    await deps.flow.transition(tx, ctx, {
      machine: "payment_exception",
      stateField: "status",
      id: row.id,
      event: "payment_exception.auto_heal",
      ref: "08:768",
      args: { wxBillLineId: line.id },
      set: { resolved_at: deps.clock.now() },
      ...(receipt.entityId ? { entityId: receipt.entityId } : {}),
      audit: {
        stream: "ops",
        category: "recon",
        action: "finance.reconciliation.healed",
        summary: "后续可信账单出现且收款一致",
        target: { type: "payment_exception", id: row.id },
      },
      emit: {
        type: "payment_exception.auto_healed",
        payload: { v: 1, paymentExceptionId: row.id },
        dedupeKey: `payment_exception.auto_healed:${row.id}`,
      },
    });
}
