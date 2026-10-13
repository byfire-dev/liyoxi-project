import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { RetentionDeps } from "./types.js";
import { currentBusinessRefs } from "./current-refs.js";
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
  for (const expected of await currentBusinessRefs(deps, tx, id))
    add(expected.refType, expected.refId);
  if (blocked.size)
    throw new AppError("FILE_IN_USE", { details: { refs: [...blocked.values()].slice(0, 20) } });
}
