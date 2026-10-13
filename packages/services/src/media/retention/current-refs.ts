import type { FileObject } from "@liyoxi/db";
import type { ExpectedFileRef, Tx } from "../../kernel/index.js";
import type { RetentionDeps } from "./types.js";

/** 独立拥有者查询每次都以当前fileId读事实，不缓存全域readColumns快照。 */
export async function currentBusinessRefs(deps: RetentionDeps, tx: Tx, id: string) {
  const refs: (ExpectedFileRef & { refType: string })[] = [];
  for (const [refType, definition] of deps.refTypes) {
    if (!definition.inUse) {
      if (definition.readColumns) throw new TypeError(`当前使用事实尚未接入：${refType}`);
      continue;
    }
    for (const fact of await definition.inUse(tx, id)) {
      if (fact.fileId !== id || !definition.roles[fact.role])
        throw new TypeError(`当前使用事实与文件/角色不符：${refType}`);
      refs.push({ ...fact, refType });
    }
  }
  return refs;
}
export async function purgeAfter(tx: Tx, file: FileObject) {
  const refs = await tx.fileRef.findMany({ where: { fileId: file.id } });
  if (refs.some((ref) => ref.state === "live" || !ref.keepUntil)) return null;
  if (refs.length) return new Date(Math.max(...refs.map((ref) => ref.keepUntil!.getTime())));
  // 从未引用的入库文件有24小时保护；历史曾被引用但记录丢失不猜释放时间。
  return file.firstLinkedAt || !file.storedAt
    ? null
    : new Date(file.storedAt.getTime() + 86_400_000);
}
export async function sweepGuard(deps: RetentionDeps, tx: Tx, file: FileObject, resumed = false) {
  const now = deps.clock.now();
  if (file.status !== "stored" && !(resumed && file.status === "deleting")) return false;
  if (!file.purgeAfter || file.purgeAfter > now || file.erasedAt) return false;
  const refs = await tx.fileRef.findMany({ where: { fileId: file.id } });
  for (const ref of refs) {
    const role = deps.refTypes.get(ref.refType)?.roles[ref.role];
    if (
      !role ||
      ref.state === "live" ||
      !ref.keepUntil ||
      ref.keepUntil > now ||
      role.retentionDays === null ||
      (role.canRelease && !(await role.canRelease(tx, ref.refId)))
    )
      return false;
  }
  if (file.uploadBatchId) {
    const batch = await tx.uploadBatch.findUnique({ where: { id: file.uploadBatchId } });
    if (!batch || !["committed", "canceled", "expired"].includes(batch.state)) return false;
  }
  return !(await currentBusinessRefs(deps, tx, file.id)).length;
}
