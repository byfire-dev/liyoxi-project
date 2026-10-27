import type { PaymentExceptionResolveBody } from "@liyoxi/contract";
import type { PaymentException } from "@liyoxi/db";
import { assertPermission } from "../../../authz/index.js";
import type { StaffContext } from "../../../authz/index.js";
import { AppError } from "../../../kernel/index.js";
import type { IdentityContext, Tx } from "../../../kernel/index.js";
import type { PaymentExceptionDeps } from "./context.js";
import { OPEN } from "./context.js";
import { resolutions } from "./matrix.js";

export function check(
  row: PaymentException,
  staff: StaffContext,
  input: PaymentExceptionResolveBody,
  now: Date,
) {
  if (row.lockVersion !== input.lockVersion) throw new AppError("VERSION_CONFLICT");
  if (row.status !== "open") throw new AppError("STATE_NOT_ALLOWED");
  if (input.confirm.exceptionNo !== row.exceptionNo || input.confirm.amountFen !== row.amountFen)
    throw new AppError("CONFIRM_MISMATCH");
  if (input.resolution === "written_off") assertPermission(staff, "sys.super_admin", now);
  const allowed = resolutions(row, staff);
  if (!allowed.includes(input.resolution))
    throw new AppError("RESOLUTION_NOT_ALLOWED", { details: { allowed } });
}
export async function refresh(tx: Tx, deps: PaymentExceptionDeps, row: PaymentException) {
  if (row.billingOrderId)
    await tx.billingOrder.update({
      where: { id: row.billingOrderId },
      data: {
        hasOpenException:
          (await tx.paymentException.count({
            where: { billingOrderId: row.billingOrderId, status: { in: OPEN } },
          })) > 0,
        updatedAt: deps.clock.now(),
      },
    });
  if (
    row.paymentTxnId &&
    !(await tx.paymentException.count({
      where: { paymentTxnId: row.paymentTxnId, status: { in: OPEN } },
    }))
  )
    await tx.paymentTxn.update({
      where: { id: row.paymentTxnId },
      data: { reconState: "resolved", updatedAt: deps.clock.now() },
    });
}
export async function resolved(
  tx: Tx,
  deps: PaymentExceptionDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  row: PaymentException,
  input: PaymentExceptionResolveBody,
) {
  const retry = input.resolution === "retried";
  await deps.flow.transition(tx, ctx, {
    machine: "payment_exception",
    stateField: "status",
    id: row.id,
    event: retry ? "payment_exception.retry_fulfill" : "payment_exception.resolve",
    ref: retry ? "08:765" : "08:766",
    args: { resolution: input.resolution },
    ...(row.entityId ? { entityId: row.entityId } : {}),
    set: {
      resolution: input.resolution,
      resolution_note: input.note,
      resolved_by_staff_id: staff.staff.id,
      resolved_at: deps.clock.now(),
    },
    audit: {
      stream: "ops",
      category: "recon",
      action: `finance.payment_exception.${input.resolution}`,
      summary: input.note,
      target: { type: "payment_exception", id: row.id },
    },
    emit: {
      type: "payment_exception.resolved",
      payload: { v: 1, paymentExceptionId: row.id, resolution: input.resolution },
      dedupeKey: `payment_exception.resolved:${row.id}`,
    },
  });
  await refresh(tx, deps, row);
}
