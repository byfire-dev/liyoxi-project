// W6-04 本轮 M1 owner 的虚拟时间运输；仅推进注入时钟，业务变化仍由正式写者完成。
import assert from "node:assert/strict";
import { alertsOf } from "../kernel/index.js";
import { createLedger } from "../billing/index.js";
import { prepareClosedBillingDays } from "./billing-daily.js";
import { createM2Background } from "./m2-background.js";
import { runTimer, TIMER_LEASE_SEC } from "../timers/index.js";
import type { M1Scope, M1Support } from "./m1-types.js";

function m6Background(support: M1Support) {
  const scope = support.sharedScope();
  const owned = () => {
    // sharedScope invokes the original owner's open/lifetime guard.
    const current = support.sharedScope();
    assert.equal(current.runId, scope.runId);
    assert.equal(current.databaseName, scope.databaseName);
    assert.equal(current.redisPrefix, scope.redisPrefix);
    assert.equal(support.runtime.env.APP_ENV, "test");
    assert.ok(scope.databaseName.startsWith("lyx_test_"));
    assert.equal(new URL(support.runtime.env.DATABASE_URL).pathname, `/${scope.databaseName}`);
  };
  // Reuse the bounded real M2 worker transport: due media handlers/expiry,
  // notify scan/delivery and event consumers; never patch a successful state.
  return createM2Background(support, new Date(scope.startedAt), owned);
}

/** Catch up this owned entity after virtual time moves, as the real worker would. */
export async function settleM6TakedownBackground(support: M1Support, scope: M1Scope) {
  const background = m6Background(support),
    { runtime } = support;
  await runtime.tx.run(async (tx) => {
    await tx.entityMember.findFirstOrThrow({
      where: {
        entityId: scope.entityId,
        merchantUserId: scope.merchantUserId,
        role: "owner",
        status: "active",
      },
    });
    await tx.orderItem.findFirstOrThrow({
      where: {
        id: scope.orderItemId,
        dramaOrderId: scope.orderId,
        entityId: scope.entityId,
        storeId: scope.storeId,
        dramaOrder: { placedByUserId: scope.merchantUserId },
      },
    });
    await tx.deliveryTicket.findFirstOrThrow({
      where: {
        id: scope.deliveryTicketId,
        orderItemId: scope.orderItemId,
        entityId: scope.entityId,
        storeId: scope.storeId,
      },
    });
  });
  const ledger = createLedger({ clock: support.clock, events: runtime.events });
  await runtime.tx.run((tx) => ledger.advance(tx, scope.entityId));
  // Source expiration/grant events precede the official closed-day projection.
  // This replays accounting facts; it neither seeds source history nor heals an invariant.
  await prepareClosedBillingDays(runtime, scope.entityId);
  await drainM6TakedownEvents(support, scope);
  return background();
}

export async function drainM6TakedownEvents(support: M1Support, scope: M1Scope) {
  assert.equal(support.runtime.env.APP_ENV, "test");
  try {
    return await support.drainEvents();
  } catch (error) {
    const failed = await support.runtime.tx.run((tx) =>
      tx.outboxDelivery.findMany({
        where: {
          status: { in: ["retry", "dead"] },
          outboxEvent: { entityId: scope.entityId, storeId: scope.storeId },
        },
        select: { subscriber: true, lastError: true },
      }),
    );
    throw new Error(`本轮下架事件未排空：${JSON.stringify(failed)}`, { cause: error });
  }
}

export async function runM6TakedownCreate(support: M1Support, scope: M1Scope) {
  assert.equal(support.runtime.env.APP_ENV, "test");
  assert.ok(support.databaseName.startsWith("lyx_test_"));
  const { runtime, clock } = support;
  // Do already-due work before the jump so elapsed wall time is not disguised as a job timeout.
  await m6Background(support)();
  const timer = await runtime.tx.run(async (tx) => {
    const owned = { entityId: scope.entityId, storeId: scope.storeId };
    await tx.entityMember.findFirstOrThrow({
      where: {
        entityId: scope.entityId,
        merchantUserId: scope.merchantUserId,
        role: "owner",
        status: "active",
      },
    });
    const order = await tx.dramaOrder.findFirstOrThrow({
      where: { id: scope.orderId, ...owned, placedByUserId: scope.merchantUserId },
    });
    const item = await tx.orderItem.findFirstOrThrow({
      where: { id: scope.orderItemId, dramaOrderId: order.id, ...owned },
    });
    await tx.deliveryTicket.findFirstOrThrow({
      where: { id: scope.deliveryTicketId, orderItemId: item.id, step: "in_service", ...owned },
    });
    const rows = await tx.timer.findMany({
      where: {
        kind: "takedown.create",
        subjectType: "order_item",
        subjectId: item.id,
        status: "scheduled",
        ...owned,
      },
    });
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.createdAt >= order.submittedAt);
    return rows[0]!;
  });
  if (timer.fireAt > clock.now()) clock.set(timer.fireAt);
  const ref = await runtime.tx.run(async (tx) => {
    const current = await tx.timer.findUniqueOrThrow({ where: { id: timer.id } });
    assert.equal(current.kind, "takedown.create");
    assert.equal(current.subjectId, scope.orderItemId);
    assert.equal(current.fireAt.getTime(), timer.fireAt.getTime());
    assert.ok((current.retryAt ?? current.fireAt) <= clock.now());
    const rows = await tx.$queryRawUnsafe<Array<{ dispatchNo: number }>>(
      `UPDATE timer SET status='dispatched', dispatch_no=dispatch_no+1,
       is_enqueued=false, lease_until=now()+$3::int*interval '1 second', updated_at=now()
       WHERE id=$1::uuid AND status='scheduled' AND dispatch_no=$2::int
       RETURNING dispatch_no::int AS "dispatchNo"`,
      timer.id,
      current.dispatchNo,
      TIMER_LEASE_SEC,
    );
    assert.equal(rows.length, 1);
    return { timerId: timer.id, kind: timer.kind, dispatchNo: rows[0]!.dispatchNo };
  });
  const outcome = await runTimer(
    {
      tx: runtime.tx,
      registry: runtime.timers.registry,
      assembly: runtime.assembly,
      clock,
      alerts: alertsOf(runtime.assembly),
    },
    ref,
  );
  const actual = await runtime.tx.run((tx) =>
    tx.timer.findUniqueOrThrow({ where: { id: timer.id } }),
  );
  assert.equal(outcome, "fired", actual.lastError ?? "下架创建必须经过真实运行器");
  assert.equal(actual.status, "fired");
  assert.equal(actual.fireAt.getTime(), timer.fireAt.getTime());
  return { fireAt: actual.fireAt, dispatchNo: actual.dispatchNo };
}
