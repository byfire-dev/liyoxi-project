import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { RetentionDeps } from "./types.js";
/** 本片保守保护现有readColumns投影；历史列的精准inUse收口随sweep，不拿released冒充独立业务事实。 */
export async function assertErasable(deps: RetentionDeps, tx: Tx, id: string) {
  const blocked = new Map<string, { refType: string; refId: string }>();
  const add = (refType: string, refId: string) =>
    blocked.set(`${refType}:${refId}`, { refType, refId });
  const refs = await tx.fileRef.findMany({ where: { fileId: id } });
  const now = deps.clock.now();
  for (const ref of refs) {
    const role = deps.refTypes.get(ref.refType)?.roles[ref.role];
    if (
      ref.state === "live" ||
      !role ||
      role.retentionDays === null ||
      !ref.keepUntil ||
      ref.keepUntil > now ||
      (role.canRelease && !(await role.canRelease(tx, ref.refId)))
    )
      add(ref.refType, ref.refId);
  }
  // readColumns来自各真实拥有者；漏记file_ref也不能删除当前文件。没有规则的未来类型不伪造查询。
  for (const [refType, definition] of deps.refTypes) {
    for (const expected of (await definition.readColumns?.(tx)) ?? []) {
      if (expected.fileId !== id) continue;
      const rule = definition.roles[expected.role];
      if (!rule?.canRelease || !(await rule.canRelease(tx, expected.refId)))
        add(refType, expected.refId);
    }
  }
  if (blocked.size)
    throw new AppError("FILE_IN_USE", { details: { refs: [...blocked.values()].slice(0, 20) } });
}
