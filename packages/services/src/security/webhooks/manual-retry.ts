// 重置不做来源验签、外呼或 emit：由已登记的收件扫描器接着处理。
import type { Tx } from "../../kernel/index.js";
import { AppError, isUuid } from "../../kernel/index.js";
export async function retryDeadWebhook(tx: Tx, id: string, now: Date) {
  if (!isUuid(id)) throw new AppError("VALIDATION_FAILED");
  await tx.$queryRawUnsafe("SELECT id FROM webhook_event WHERE id=$1::uuid FOR UPDATE", id);
  const before = await tx.webhookEvent.findUnique({ where: { id } });
  if (!before) throw new AppError("NOT_FOUND");
  if (before.processState !== "dead") throw new AppError("STATE_NOT_ALLOWED");
  const after = await tx.webhookEvent.update({
    where: { id },
    data: { processState: "received", attempts: 0, nextAttemptAt: now, updatedAt: now },
  });
  return { before, after };
}
