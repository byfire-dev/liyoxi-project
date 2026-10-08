import { assertAccess, satisfiesLevel } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { SignedUrl, MessageItem } from "@liyoxi/contract";
import type { Tx } from "../kernel/index.js";
import type { ConfigActor, ConfigAdminDeps } from "./admin-context.js";
export interface SiteAdminDeps extends ConfigAdminDeps {
  readonly files: {
    link(tx: Tx, fileId: string, bannerId: string): Promise<void>;
    release(tx: Tx, fileId: string, bannerId: string, keepUntil: Date): Promise<void>;
    sign(fileId: string): Promise<SignedUrl | null>;
  };
  readonly noticeLink: (
    tx: Tx,
    notice: { id: string; kind: string; refId: string; status: string; link: unknown },
  ) => Promise<MessageItem["link"] | null>;
  readonly clicks: (tx: Tx, ids: readonly string[]) => Promise<ReadonlyMap<string, number>>;
}
export function siteActor(ctx: ConfigActor, edit = false, notices = false) {
  if (notices) {
    if (
      !satisfiesLevel(ctx.staff.moduleLevels.ops, "view") &&
      !satisfiesLevel(ctx.staff.moduleLevels.billing, "view")
    )
      throw new AppError("PERMISSION_DENIED");
  } else {
    if (edit && ctx.staff.moduleLevels.ops !== "e") throw new AppError("PERMISSION_DENIED");
    assertAccess(ctx.staff, {
      module: { module: "ops", need: edit ? "edit" : "view" },
      permission: null,
    });
  }
  if (ctx.identity.actor.type !== "staff" || ctx.identity.actor.id !== ctx.staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  return ctx.staff.staff.id;
}
