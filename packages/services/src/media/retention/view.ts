import { AdminFileViewSchema } from "@liyoxi/contract";
import type { FileObject } from "@liyoxi/db";
import { hasPermission } from "../../authz/index.js";
import type { Tx } from "../../kernel/index.js";
import { adminView } from "../views.js";
import type { RetentionActor } from "./types.js";
export async function retentionFileView(
  tx: Tx,
  actor: RetentionActor,
  file: FileObject,
  now: Date,
) {
  const value = await adminView(tx, actor, file);
  const actions = [...value.actions];
  if (
    file.status === "deleted" &&
    !file.erasedAt &&
    file.deletedAt &&
    now.getTime() <= file.deletedAt.getTime() + (file.bucket === "secure" ? 90 : 30) * 86_400_000 &&
    hasPermission(actor.staff, "files.restore")
  )
    actions.push("restore");
  if (
    ["stored", "deleted"].includes(file.status) &&
    !file.erasedAt &&
    hasPermission(actor.staff, "files.erase")
  )
    actions.push("erase");
  return AdminFileViewSchema.parse({ ...value, actions });
}
