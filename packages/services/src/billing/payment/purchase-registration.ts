import { createIdentityContext, invariantNow, lockRows } from "../../kernel/index.js";
import type { Clock, FiredTimer, InvariantRegistration, Tx } from "../../kernel/index.js";
import { rowKey, chainKey } from "../../flow/index.js";
import type { Flow, MachineBinding } from "../../flow/index.js";
import type { Timers } from "../../timers/index.js";
import { paymentMachineBindings } from "./machines.js";

interface TimerBinding {
  clock: Clock;
  flow: Flow;
  timers: Timers;
}
const bindings: TimerBinding[] = [];
/** 静态登记的依赖由组合根绑定；解绑恢复上层作用域，测试不污染别的运行时。 */
export function bindBillingTimers(value: TimerBinding): () => void {
  bindings.push(value);
  return () => {
    const index = bindings.indexOf(value);
    if (index >= 0) bindings.splice(index, 1);
  };
}
export async function handleTransferTtl(tx: Tx, timer: FiredTimer) {
  const binding = bindings.at(-1);
  if (!binding) throw new Error("po.transfer_ttl 未绑定 billing 时钟与状态迁移运行时");
  if (timer.subjectType !== "billing_order" || !timer.subjectId) return "skipped" as const;
  await lockRows(tx, "billing_order", [timer.subjectId]);
  const o = await tx.billingOrder.findUnique({ where: { id: timer.subjectId } });
  if (
    !o ||
    o.channel !== "bank_transfer" ||
    o.status !== "pending_payment" ||
    o.expiresAt > binding.clock.now() ||
    timer.payload?.expiresAt !== o.expiresAt.toISOString() ||
    (await tx.transferProof.count({ where: { billingOrderId: o.id, reviewStatus: "pending" } }))
  )
    return "skipped" as const;
  const row = await tx.timer.findUniqueOrThrow({
      where: { id: timer.id },
      select: { dedupeKey: true },
    }),
    ctx = createIdentityContext({
      actor: { type: "system", job: "po.transfer_ttl" },
      entityId: o.entityId,
      storeId: o.storeId,
    });
  await binding.flow.transition(tx, ctx, {
    machine: "billing_order",
    stateField: "status",
    id: o.id,
    event: "billing_order.cancel",
    ref: "08:175",
    reasonCode: "transfer_ttl",
    set: { transfer_state: null, cancelled_at: binding.clock.now(), cancel_reason: "transfer_ttl" },
    audit: {
      stream: "activity",
      category: "payment",
      action: "billing.order.cancel",
      summary: "对公付款单到期取消",
      target: { type: "billing_order", id: o.id },
      entityId: o.entityId,
      storeId: o.storeId,
    },
    emit: {
      type: "billing_order.cancelled",
      payload: { v: 1, billingOrderId: o.id, entityId: o.entityId, cancelReason: "transfer_ttl" },
      dedupeKey: `tmr:${row.dedupeKey}`,
    },
  });
  await binding.timers.cancel(tx, {
    subject: { type: "billing_order", id: o.id },
    kinds: ["po.transfer_ttl"],
  });
  return "fired" as const;
}
const extras: MachineBinding = {
  companions: ["expires_at"],
  guards: {
    [rowKey("08:162", "billing_order.create")]: async (tx, f) => {
      const o = await tx.billingOrder.findUnique({
        where: { id: f.subjectId },
        include: { entity: { select: { verificationStatus: true } } },
      });
      return (
        o !== null &&
        f.ctx.actor.type === "merchant" &&
        f.ctx.actor.role === "owner" &&
        o.placedByUserId === f.ctx.actor.id &&
        o.entityId === f.ctx.entityId &&
        ["verified", "pending"].includes(o.entity.verificationStatus) &&
        o.type === "plan_new" &&
        o.channel === "bank_transfer" &&
        o.transferState === "awaiting_proof" &&
        o.bankAccountFinanceConfigRevisionId !== null &&
        (await tx.agreementConsent.count({ where: { bizType: "billing_order", bizId: o.id } })) >= 2
      );
    },
    [rowKey("08:167", "billing_order.submit_proof")]: async (tx, f) => {
      const id = (f.args as { transferProofId?: string })?.transferProofId,
        p = id ? await tx.transferProof.findUnique({ where: { id } }) : null;
      return p !== null && p.billingOrderId === f.subjectId && p.reviewStatus === "pending";
    },
    [rowKey("08:170", "billing_order.reject_proof")]: async (tx, f) => {
      const id = (f.args as { transferProofId?: string })?.transferProofId,
        p = id ? await tx.transferProof.findUnique({ where: { id } }) : null;
      return p !== null && p.billingOrderId === f.subjectId && p.reviewStatus === "rejected";
    },
    [rowKey("08:175", "billing_order.cancel")]: async (tx, f) => {
      const o = await tx.billingOrder.findUnique({ where: { id: f.subjectId } });
      return (
        o !== null &&
        o.channel === "bank_transfer" &&
        o.expiresAt <= f.now &&
        f.reasonCode === "transfer_ttl" &&
        (await tx.transferProof.count({
          where: { billingOrderId: o.id, reviewStatus: "pending" },
        })) === 0
      );
    },
  },
};
export const purchaseMachineBindings = paymentMachineBindings.map((entry) =>
  entry.key === chainKey("billing_order", "status")
    ? {
        key: entry.key,
        binding: {
          ...entry.binding,
          companions: [...(entry.binding.companions ?? []), ...(extras.companions ?? [])],
          guards: { ...entry.binding.guards, ...extras.guards },
        },
      }
    : entry,
);
function invariant(code: string, sql: string): InvariantRegistration {
  return {
    code,
    severity: "P1",
    modes: ["full"],
    heal: "none",
    run: async (tx, scope, ctx) => {
      const rows = await tx.$queryRawUnsafe<
        { id: string; entity_id: string | null; problem: string }[]
      >(
        `SELECT * FROM (${sql}) t WHERE ($1::uuid[] IS NULL OR entity_id=ANY($1::uuid[])) AND $2::timestamptz IS NOT NULL ORDER BY id LIMIT 500`,
        scope.entityIds?.length ? [...scope.entityIds] : null,
        invariantNow(ctx),
      );
      return rows.map((r) => ({
        subject: {
          type:
            code === "payment.I12"
              ? "finance_config_revision"
              : code === "payment.I14"
                ? "billing_order"
                : "transfer_proof",
          id: r.id,
        },
        ...(r.entity_id ? { entityId: r.entity_id } : {}),
        detail: { problem: r.problem },
      }));
    },
  };
}
export const purchaseInvariants = [
  invariant(
    "payment.I12",
    `SELECT f.id::text,NULL::uuid entity_id,'approval_or_effective' problem FROM finance_config_revision f JOIN approval_request a ON a.id=f.approval_request_id WHERE (f.effective_at IS NOT NULL) IS DISTINCT FROM (a.status='approved') OR (a.status='approved' AND (a.decided_by_staff_id IS NULL OR a.requester_staff_id IS NOT DISTINCT FROM a.decided_by_staff_id OR f.effective_at IS DISTINCT FROM a.decided_at+CASE WHEN f.config_key='bank_account' THEN interval '24 hours' ELSE interval '0 hours' END))`,
  ),
  invariant(
    "payment.I14",
    `SELECT o.id::text,o.entity_id,'pending_proof_count' problem FROM billing_order o CROSS JOIN LATERAL(SELECT count(*) n FROM transfer_proof p WHERE p.billing_order_id=o.id AND p.review_status='pending') p WHERE (o.status='pending_confirmation' AND p.n<>1) OR (o.status<>'pending_confirmation' AND p.n<>0)`,
  ),
  invariant(
    "payment.I15",
    `SELECT p.id::text,p.entity_id,'accepted_receipt_count' problem FROM transfer_proof p CROSS JOIN LATERAL(SELECT count(*) n FROM payment_txn t WHERE t.transfer_proof_id=p.id AND t.status='succeeded') t WHERE (p.review_status='accepted' AND t.n<>1) OR (p.review_status<>'accepted' AND t.n<>0)`,
  ),
];
