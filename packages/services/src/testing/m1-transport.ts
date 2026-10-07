// 本轮运输夹具：虚拟到期只决定认领；业务处理仍是生产 consumeDelivery/runTimer。
import type { Runtime } from "../runtime.js";
import { alertsOf } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { claimDeliveries, consumeDelivery } from "../events/index.js";
import { runTimer, TIMER_LEASE_SEC } from "../timers/index.js";
import type { M1OrderScope } from "./m1-types.js";

function guard(ok: unknown): asserts ok {
  if (!ok) throw new Error("M1 运输认领不属于本轮业务范围或尚未虚拟到期");
}
async function ownOrder(tx: Tx, scope: M1OrderScope) {
  const [order, store, member] = await Promise.all([
    tx.dramaOrder.findUniqueOrThrow({ where: { id: scope.orderId } }),
    tx.store.findUniqueOrThrow({ where: { id: scope.storeId } }),
    tx.entityMember.findFirst({
      where: {
        entityId: scope.entityId,
        merchantUserId: scope.merchantUserId,
        role: "owner",
        status: "active",
      },
    }),
  ]);
  guard(
    member &&
      order.entityId === scope.entityId &&
      order.storeId === scope.storeId &&
      order.placedByUserId === scope.merchantUserId &&
      store.entityId === scope.entityId,
  );
  return order;
}
export function m1Transport(runtime: Runtime, assertOwned: () => void, startedAt: Date) {
  const alerts = alertsOf(runtime.assembly);
  const timerDeps = {
    tx: runtime.tx,
    assembly: runtime.assembly,
    clock: runtime.clock,
    registry: runtime.timers.registry,
    alerts,
  };
  return {
    async orderTimer(scope: M1OrderScope) {
      assertOwned();
      return runtime.tx.run(async (tx) => {
        await ownOrder(tx, scope);
        const rows = await tx.timer.findMany({
          where: { kind: "order.start", subjectType: "drama_order", subjectId: scope.orderId },
        });
        guard(rows.length === 1 && rows[0]);
        return { timerId: rows[0].id, fireAt: rows[0].fireAt };
      });
    },
    async runDueTimer(scope: M1OrderScope, timerId: string) {
      assertOwned();
      const businessNow = runtime.clock.now();
      const { ref, fireAt } = await runtime.tx.run(async (tx) => {
        const order = await ownOrder(tx, scope);
        const timer = await tx.timer.findUniqueOrThrow({ where: { id: timerId } });
        guard(
          order.status === "pending_start" &&
            timer.kind === "order.start" &&
            timer.subjectType === "drama_order" &&
            timer.subjectId === order.id &&
            timer.status === "scheduled" &&
            timer.fireAt <= businessNow &&
            timer.fireAt >= order.submittedAt &&
            timer.createdAt >= startedAt,
        );
        // 只改运输字段；不改业务 fireAt/状态/历史。租约属于基础设施，沿用数据库时间。
        const rows = await tx.$queryRawUnsafe<Array<{ dispatchNo: number }>>(
          `UPDATE timer SET status = 'dispatched', dispatch_no = dispatch_no + 1,
             is_enqueued = false, lease_until = now() + $2::int * interval '1 second', updated_at = now()
           WHERE id = $1::uuid AND status = 'scheduled'
           RETURNING dispatch_no::int AS "dispatchNo"`,
          timerId,
          TIMER_LEASE_SEC,
        );
        guard(rows.length === 1 && rows[0]);
        return {
          ref: { timerId, kind: timer.kind, dispatchNo: rows[0].dispatchNo },
          fireAt: timer.fireAt,
        };
      });
      const outcome = await runTimer(timerDeps, ref);
      if (outcome !== "fired") {
        const row = await runtime.tx.run((tx) =>
          tx.timer.findUniqueOrThrow({ where: { id: timerId } }),
        );
        throw new Error(`M1 order.start 实际执行 ${outcome}：${row.lastError ?? "无错误详情"}`);
      }
      const actual = await runtime.tx.run((tx) =>
        tx.timer.findUniqueOrThrow({ where: { id: timerId } }),
      );
      guard(
        actual.status === "fired" &&
          actual.dispatchNo === ref.dispatchNo &&
          actual.fireAt.getTime() === fireAt.getTime(),
      );
      return { outcome, dispatchNo: ref.dispatchNo, fireAt, businessNow };
    },
    async drainEvents() {
      assertOwned();
      let expanded = 0,
        consumed = 0;
      for (let round = 0; round < 32; round++) {
        expanded += (await runtime.events.expand()).events;
        const { claimed, dead } = await runtime.tx.run((tx) => claimDeliveries(tx));
        guard(dead.length === 0);
        if (claimed.length === 0) {
          const unsettled = await runtime.tx.run((tx) =>
            tx.outboxDelivery.count({ where: { status: { not: "done" } } }),
          );
          guard(unsettled === 0);
          return { expanded, consumed };
        }
        for (const ref of claimed) {
          const event = await runtime.tx.run((tx) =>
            tx.outboxEvent.findUniqueOrThrow({ where: { id: ref.eventId } }),
          );
          guard(
            event.occurredAt >= startedAt &&
              event.occurredAt <= runtime.clock.now() &&
              runtime.events.subscribers.get(ref.subscriber),
          );
          const outcome = await consumeDelivery(
            { tx: runtime.tx, subscribers: runtime.events.subscribers, alerts },
            ref,
          );
          if (outcome !== "done")
            throw new Error(`M1 实际投递 ${ref.eventType} → ${ref.subscriber}：${outcome}`);
          consumed++;
        }
      }
      throw new Error("M1 出站事件超过 32 轮，拒绝把未排空视为成功");
    },
  };
}
