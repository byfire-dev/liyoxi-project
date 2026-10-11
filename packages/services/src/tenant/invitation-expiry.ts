// 邀请到期只认当前行期限；早到沿原 runTimer 失败短事务重试。
import type { Flow, Guard } from "../flow/index.js";
import { createIdentityContext, lockRows } from "../kernel/index.js";
import type { Clock, FiredTimer, IdentityContext, TimerOutcome, Tx } from "../kernel/index.js";

const prepared = new WeakMap<Tx, { ctx: IdentityContext; id: string; clock: Clock }>();
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
    row.entityId === facts.entityId &&
    row.storeId === facts.storeId
  );
};
export interface InvitationExpiry {
  handle(tx: Tx, timer: FiredTimer): Promise<TimerOutcome>;
}
export function createInvitationExpiry(deps: { clock: Clock; flow: Flow }): InvitationExpiry {
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
      const ctx = createIdentityContext({
        actor: { type: "system", job: "invitation.expire" },
        entityId: row.entityId,
        storeId: row.storeId,
      });
      if (prepared.has(tx)) throw new TypeError("邀请到期迁移不能重入");
      prepared.set(tx, { ctx, id: row.id, clock: deps.clock });
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
        return "fired";
      } finally {
        prepared.delete(tx);
      }
    },
  };
}
