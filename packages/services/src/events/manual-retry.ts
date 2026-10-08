// 人工重投已有 event×subscriber，既不新增投递，也不重发业务事件。
import { SUBSCRIBERS } from "@liyoxi/contract/registry";
import type { Tx } from "../kernel/index.js";
import { AppError, isUuid } from "../kernel/index.js";
export async function retryDeadDelivery(
  tx: Tx,
  outboxEventId: string,
  subscriber: string,
  now: Date,
) {
  if (!isUuid(outboxEventId) || !SUBSCRIBERS.some((row) => row.name === subscriber))
    throw new AppError("VALIDATION_FAILED");
  await tx.$queryRawUnsafe(
    "SELECT outbox_event_id FROM outbox_delivery WHERE outbox_event_id=$1::uuid AND subscriber=$2 FOR UPDATE",
    outboxEventId,
    subscriber,
  );
  const key = { outboxEventId_subscriber: { outboxEventId, subscriber } };
  const before = await tx.outboxDelivery.findUnique({ where: key });
  if (!before) throw new AppError("NOT_FOUND");
  if (before.status !== "dead") throw new AppError("STATE_NOT_ALLOWED");
  const after = await tx.outboxDelivery.update({
    where: key,
    data: { status: "retry", attempts: 0, nextAttemptAt: now, updatedAt: now },
  });
  return { before, after };
}
export const countDead = (tx: Tx, entityId?: string) =>
  tx.outboxDelivery.count({
    where: { status: "dead", ...(entityId ? { outboxEvent: { entityId } } : {}) },
  });
