// 人工只恢复失败的运输行，业务 fireAt 不在此入口可写。
import type { Tx } from "../kernel/index.js";
import { AppError, isUuid } from "../kernel/index.js";
export async function recoverFailedTimer(
  tx: Tx,
  id: string,
  action: "reschedule" | "cancel",
  now: Date,
) {
  if (!isUuid(id) || (action !== "reschedule" && action !== "cancel"))
    throw new AppError("VALIDATION_FAILED");
  await tx.$queryRawUnsafe("SELECT id FROM timer WHERE id=$1::uuid FOR UPDATE", id);
  const before = await tx.timer.findUnique({ where: { id } });
  if (!before) throw new AppError("NOT_FOUND");
  if (before.status !== "failed") throw new AppError("STATE_NOT_ALLOWED");
  const after = await tx.timer.update({
    where: { id },
    data: {
      status: action === "reschedule" ? "scheduled" : "cancelled",
      ...(action === "reschedule" ? { attempts: 0, retryAt: null } : {}),
      updatedAt: now,
    },
  });
  return { before, after };
}
export const countFailed = (tx: Tx, entityId?: string) =>
  tx.timer.count({ where: { status: "failed", ...(entityId ? { entityId } : {}) } });
