// 邀请到期只认当前行期限；早到沿原 runTimer 失败短事务重试。
import type { Flow, Guard } from "../flow/index.js";
import { createIdentityContext, lockRows } from "../kernel/index.js";
import type {
  Clock,
  FiredTimer,
  IdentityContext,
  InvariantScope,
  InvariantViolation,
  TimerOutcome,
  Tx,
} from "../kernel/index.js";
import type { Timers } from "../timers/index.js";
import { TENANT_INVARIANT_LIMIT } from "./invariants.js";

const prepared = new WeakMap<
  Tx,
  { ctx: IdentityContext; id: string; clock: Clock; cutoff?: Date }
>();
export const guardInvitationExpiry: Guard = async (tx, facts) => {
  const bound = prepared.get(tx);
  if (
    !bound ||
    bound.ctx !== facts.ctx ||
    bound.id !== facts.subjectId ||
    facts.event !== "invitation.expire" ||
    facts.ctx.actor.type !== "system"
  )
    return false;
  const row = await tx.invitation.findUnique({ where: { id: bound.id } });
  return (
    row !== null &&
    row.status === "pending" &&
    row.expiresAt <= bound.clock.now() &&
    (bound.cutoff === undefined || row.expiresAt < bound.cutoff) &&
    row.entityId === facts.entityId &&
    row.storeId === facts.storeId
  );
};
export interface InvitationExpiry {
  handle(tx: Tx, timer: FiredTimer): Promise<TimerOutcome>;
  checkI30(tx: Tx, scope: InvariantScope, now: Date): Promise<readonly InvariantViolation[]>;
}
export function createInvitationExpiry(deps: {
  clock: Clock;
  flow: Flow;
  timers: Pick<Timers, "cancel">;
}): InvitationExpiry {
  async function expireLocked(
    tx: Tx,
    row: { id: string; entityId: string; storeId: string },
    cutoff?: Date,
  ) {
    const ctx = createIdentityContext({
      actor: { type: "system", job: "invitation.expire" },
      entityId: row.entityId,
      storeId: row.storeId,
    });
    if (prepared.has(tx)) throw new TypeError("邀请到期迁移不能重入");
    prepared.set(tx, { ctx, id: row.id, clock: deps.clock, cutoff });
    try {
      await deps.flow.transition(tx, ctx, {
        machine: "invitation",
        stateField: "status",
        id: row.id,
        entityId: row.entityId,
        storeId: row.storeId,
        event: "invitation.expire",
        set: { token_enc: null },
        audit: {
          stream: "activity",
          category: "member",
          action: "tenant.invitation.expire",
          summary: "店员邀请到期",
          target: { type: "invitation", id: row.id },
          entityId: row.entityId,
          storeId: row.storeId,
        },
        emit: {
          type: "invitation.expired",
          dedupeKey: `tmr:invitation.expire:invitation:${row.id}`,
          payload: { v: 1, invitationId: row.id, entityId: row.entityId, storeId: row.storeId },
        },
      });
      await deps.timers.cancel(tx, {
        subject: { type: "invitation", id: row.id },
        kinds: ["invitation.expire"],
      });
    } finally {
      prepared.delete(tx);
    }
  }
  return {
    async handle(tx, timer) {
      if (
        timer.kind !== "invitation.expire" ||
        timer.subjectType !== "invitation" ||
        !timer.subjectId
      )
        throw new TypeError("邀请到期任务的主体不合法");
      const candidate = await tx.invitation.findUnique({
        where: { id: timer.subjectId },
        select: { entityId: true },
      });
      if (!candidate) return "skipped";
      await lockRows(tx, "entity", [candidate.entityId]);
      await lockRows(tx, "invitation", [timer.subjectId]);
      const row = await tx.invitation.findUnique({ where: { id: timer.subjectId } });
      if (!row) return "skipped";
      if (row.entityId !== candidate.entityId) throw new TypeError("邀请到期任务的归属已变化");
      if (row.status !== "pending") return "skipped";
      if (row.expiresAt > deps.clock.now()) throw new Error("邀请当前尚未到期，沿原定时器重试");
      await expireLocked(tx, row);
      return "fired";
    },
    async checkI30(tx, scope, now) {
      if (!Number.isFinite(now.getTime())) throw new TypeError("I30需要有效业务时间");
      const cutoff = new Date(now.getTime() - 3_600_000);
      if (scope.entityIds?.length === 0) return [];
      const candidates = await tx.invitation.findMany({
        where: {
          status: "pending",
          expiresAt: { lt: cutoff },
          ...(scope.entityIds === undefined ? {} : { entityId: { in: [...scope.entityIds] } }),
        },
        select: { id: true, entityId: true, storeId: true },
        orderBy: { id: "asc" },
        take: TENANT_INVARIANT_LIMIT,
      });
      if (candidates.length === 0) return [];
      await lockRows(tx, "entity", [...new Set(candidates.map((row) => row.entityId))].sort());
      await lockRows(tx, "invitation", candidates.map((row) => row.id).sort());
      const violations: InvariantViolation[] = [];
      for (const candidate of candidates) {
        const row = await tx.invitation.findUnique({ where: { id: candidate.id } });
        if (!row) continue;
        if (row.entityId !== candidate.entityId || row.storeId !== candidate.storeId)
          throw new TypeError("I30邀请锁图归属已变化");
        if (row.status !== "pending" || row.expiresAt >= cutoff) continue;
        if (row.expiresAt > deps.clock.now()) continue;
        await expireLocked(tx, row, cutoff);
        violations.push({
          subject: { type: "invitation", id: row.id },
          entityId: row.entityId,
          detail: { expiresAt: row.expiresAt.toISOString() },
          healed: { action: "invitation.expire", at: deps.clock.now() },
        });
      }
      return violations;
    },
  };
}
