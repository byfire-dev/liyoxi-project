import assert from "node:assert/strict";
import type { TxRunner } from "../kernel/index.js";
import { TIMER_LEASE_SEC } from "../timers/index.js";
import { DELIVERY_LEASE_SEC } from "../events/index.js";

/** Test transport follows the M1/M2 CAS claim. Business timestamps and rows remain untouched. */
export async function claimTakedownTimer(
  txRunner: TxRunner,
  input: {
    timerId: string;
    subjectId: string;
    now: Date;
  },
) {
  return txRunner.run(async (tx) => {
    const row = await tx.timer.findUniqueOrThrow({ where: { id: input.timerId } });
    assert.ok(["takedown.create", "takedown.overdue"].includes(row.kind));
    assert.equal(row.subjectId, input.subjectId);
    assert.equal(row.subjectType, row.kind === "takedown.create" ? "order_item" : "takedown_task");
    assert.ok(row.fireAt <= input.now && (row.retryAt ?? row.fireAt) <= input.now);
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
}
export async function claimTakedownCalendar(txRunner: TxRunner, eventId: string) {
  return txRunner.run(async (tx) => {
    const event = await tx.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(event.eventType, "calendar.imported");
    const subscriber = "publish.onCalendarImported";
    const row = await tx.outboxDelivery.findUniqueOrThrow({
      where: { outboxEventId_subscriber: { outboxEventId: eventId, subscriber } },
    });
    const claimed = await tx.$queryRawUnsafe<{ dispatchNo: number }[]>(
      `UPDATE outbox_delivery SET status='leased', dispatch_no=dispatch_no+1,
       is_enqueued=false, lease_until=now()+$4::int*interval '1 second', updated_at=now()
       WHERE outbox_event_id=$1::uuid AND subscriber=$2 AND status IN ('pending','retry')
       AND dispatch_no=$3::int RETURNING dispatch_no::int AS "dispatchNo"`,
      eventId,
      subscriber,
      row.dispatchNo,
      DELIVERY_LEASE_SEC,
    );
    assert.equal(claimed.length, 1);
    return { eventId, subscriber, dispatchNo: claimed[0]!.dispatchNo };
  });
}
