// 只桥接本轮已到期运输认领；失败/死信/次数/业务变化全部由生产运行器写入。
import assert from "node:assert/strict";
import { alertsOf, isUuid } from "../kernel/index.js";
import { consumeDelivery, DELIVERY_LEASE_SEC } from "../events/index.js";
import { runTimer, TIMER_LEASE_SEC } from "../timers/index.js";
import type { M1Support } from "./m1-types.js";

export function createM2Transport(base: M1Support, startedAt: Date, owned: () => void) {
  const { runtime, clock } = base,
    alerts = alertsOf(runtime.assembly);
  const due = (at: Date) => {
    if (at > clock.now()) clock.set(at);
  };
  return {
    async invitationTimer(entityId: string, invitationId: string) {
      owned();
      assert.ok(isUuid(entityId) && isUuid(invitationId));
      return runtime.tx.run(async (tx) => {
        const invitation = await tx.invitation.findFirstOrThrow({
          where: { id: invitationId, entityId, createdAt: { gte: startedAt } },
        });
        const rows = await tx.timer.findMany({
          where: {
            kind: "invitation.expire",
            subjectType: "invitation",
            subjectId: invitation.id,
            entityId,
            createdAt: { gte: startedAt },
          },
        });
        assert.equal(rows.length, 1);
        return rows[0]!;
      });
    },
    async runInvitationTimer(entityId: string, invitationId: string, fail = false) {
      owned();
      assert.ok(isUuid(entityId) && isUuid(invitationId));
      const row = await runtime.tx.run(async (tx) => {
        const invitation = await tx.invitation.findFirstOrThrow({
          where: { id: invitationId, entityId, createdAt: { gte: startedAt } },
        });
        const timer = await tx.timer.findFirstOrThrow({
          where: {
            kind: "invitation.expire",
            subjectType: "invitation",
            subjectId: invitation.id,
            entityId,
            createdAt: { gte: startedAt },
          },
        });
        assert.equal(invitation.status, "pending");
        assert.equal(timer.fireAt.getTime(), invitation.expiresAt.getTime());
        return timer;
      });
      due(row.retryAt ?? row.fireAt);
      assert.ok(row.fireAt <= clock.now());
      assert.ok((row.retryAt ?? row.fireAt) <= clock.now());
      const ref = await runtime.tx.run(async (tx) => {
        const claimed = await tx.$queryRawUnsafe<{ dispatchNo: number }[]>(
          `UPDATE timer SET status='dispatched', dispatch_no=dispatch_no+1,
           is_enqueued=false, lease_until=now()+$3::int*interval '1 second', updated_at=now()
           WHERE id=$1::uuid AND status='scheduled' AND dispatch_no=$2::int
           RETURNING dispatch_no::int AS "dispatchNo"`,
          row.id,
          row.dispatchNo,
          TIMER_LEASE_SEC,
        );
        assert.equal(claimed.length, 1);
        return { timerId: row.id, kind: row.kind, dispatchNo: claimed[0]!.dispatchNo };
      });
      const handler = runtime.assembly.timerHandler(row.kind);
      assert.ok(handler && !runtime.timers.registry.timer(row.kind)?.critical);
      const outcome = await runTimer(
        {
          tx: runtime.tx,
          registry: runtime.timers.registry,
          clock,
          alerts,
          assembly: {
            timerHandler: (kind) =>
              kind === row.kind && fail
                ? {
                    ...handler,
                    handle: async () => {
                      throw new Error("M2 explicit timer fault");
                    },
                  }
                : runtime.assembly.timerHandler(kind),
          },
        },
        ref,
      );
      return {
        outcome,
        timer: await runtime.tx.run((tx) => tx.timer.findUniqueOrThrow({ where: { id: row.id } })),
      };
    },
    async joinedDelivery(entityId: string, memberId: string) {
      owned();
      assert.ok(isUuid(entityId) && isUuid(memberId));
      await runtime.events.expand();
      return runtime.tx.run(async (tx) => {
        await tx.entityMember.findFirstOrThrow({ where: { id: memberId, entityId } });
        const event = await tx.outboxEvent.findFirstOrThrow({
          where: {
            eventType: "entity_member.joined",
            aggregateId: memberId,
            entityId,
            occurredAt: { gte: startedAt },
          },
        });
        const subscriber = runtime.events.subscribers.get("notify.onEvent");
        assert.ok(subscriber);
        assert.ok(subscriber.events.includes(event.eventType));
        return tx.outboxDelivery.findUniqueOrThrow({
          where: {
            outboxEventId_subscriber: { outboxEventId: event.id, subscriber: subscriber.name },
          },
        });
      });
    },
    async runJoinedDelivery(entityId: string, memberId: string, eventId: string, fail = false) {
      owned();
      assert.ok([entityId, memberId, eventId].every(isUuid));
      const subscriber = runtime.events.subscribers.get("notify.onEvent");
      assert.ok(subscriber);
      const row = await runtime.tx.run(async (tx) => {
        await tx.entityMember.findFirstOrThrow({ where: { id: memberId, entityId } });
        await tx.outboxEvent.findFirstOrThrow({
          where: {
            id: eventId,
            eventType: "entity_member.joined",
            aggregateId: memberId,
            entityId,
            occurredAt: { gte: startedAt },
          },
        });
        return tx.outboxDelivery.findUniqueOrThrow({
          where: {
            outboxEventId_subscriber: { outboxEventId: eventId, subscriber: subscriber.name },
          },
        });
      });
      due(row.nextAttemptAt);
      const ref = await runtime.tx.run(async (tx) => {
        const claimed = await tx.$queryRawUnsafe<{ dispatchNo: number }[]>(
          `UPDATE outbox_delivery SET status='leased', dispatch_no=dispatch_no+1,
           is_enqueued=false, lease_until=now()+$4::int*interval '1 second', updated_at=now()
           WHERE outbox_event_id=$1::uuid AND subscriber=$2 AND status IN ('pending','retry')
           AND dispatch_no=$3::int RETURNING dispatch_no::int AS "dispatchNo"`,
          eventId,
          subscriber.name,
          row.dispatchNo,
          DELIVERY_LEASE_SEC,
        );
        assert.equal(claimed.length, 1);
        return { eventId, subscriber: subscriber.name, dispatchNo: claimed[0]!.dispatchNo };
      });
      const outcome = await consumeDelivery(
        {
          tx: runtime.tx,
          alerts,
          subscribers: {
            ...runtime.events.subscribers,
            get: (name) =>
              name === subscriber.name && fail
                ? {
                    ...subscriber,
                    handle: async () => {
                      throw new Error("M2 explicit subscriber fault");
                    },
                  }
                : runtime.events.subscribers.get(name),
          },
        },
        ref,
      );
      return {
        outcome,
        delivery: await runtime.tx.run((tx) =>
          tx.outboxDelivery.findUniqueOrThrow({
            where: {
              outboxEventId_subscriber: { outboxEventId: eventId, subscriber: subscriber.name },
            },
          }),
        ),
      };
    },
    async transportFacts(
      timerIds: readonly string[],
      delivery: { outboxEventId: string; subscriber: string },
    ) {
      owned();
      assert.ok(timerIds.length > 0 && timerIds.length <= 8 && timerIds.every(isUuid));
      assert.ok(isUuid(delivery.outboxEventId) && delivery.subscriber === "notify.onEvent");
      // 生产 recorder 把 UUID 主体写 targetId，复合自然键写 targetKey。
      const deliveryKey = `${delivery.outboxEventId}:${delivery.subscriber}`;
      return runtime.tx.run(async (tx) => ({
        alerts: await tx.alertEvent.findMany({
          where: {
            OR: [
              { rule: "timer.failed", fingerprint: "timer.failed:invitation.expire" },
              { rule: "outbox.exhausted" },
            ],
          },
          select: { rule: true, status: true },
          take: 32,
        }),
        audits: await tx.auditLog.findMany({
          where: {
            OR: [{ targetId: { in: [...timerIds] } }, { targetKey: deliveryKey }],
            createdAt: { gte: startedAt },
          },
          select: { action: true, targetId: true, targetKey: true },
          take: 64,
        }),
      }));
    },
  };
}
