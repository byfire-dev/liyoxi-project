import type { ApprovalDecision, ApprovalRow } from "../approval/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
const active = new WeakMap<Tx, string>();
export async function withAccountUnbind<T>(tx: Tx, id: string, fn: () => Promise<T>) {
  if (active.has(tx)) throw new TypeError("账号解绑不能重入");
  active.set(tx, id);
  try {
    return await fn();
  } finally {
    active.delete(tx);
  }
}
export async function accountUnbindWithdrawal(
  tx: Tx,
  row: ApprovalRow,
  decision: ApprovalDecision,
) {
  const id = active.get(tx);
  if (!id || row.kind !== "channel_account" || row.subjectId !== id || !decision.isDecidedBySystem)
    throw new AppError("STATE_NOT_ALLOWED");
  const current = await tx.channelAccount.findUnique({ where: { id } });
  if (
    current?.status !== "pending_verify" ||
    current.entityId !== row.entityId ||
    current.storeId !== row.storeId
  )
    throw new AppError("STATE_NOT_ALLOWED");
}
