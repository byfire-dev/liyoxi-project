import {
  adminDramaConfirmPermitRecheck,
  adminDramaCopyrightReplace,
  adminDramaDramaCopyrightRevisionCreate,
} from "@liyoxi/contract";
import type { ContentAdminActor } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../../context.js";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
import type { AdminStaff } from "../../routing/admin.js";
export function contentActor(c: Context<ApiEnv>, staff: AdminStaff): ContentAdminActor {
  if (!c.var.identity) throw new Error("内容管理缺少身份上下文");
  return { identity: c.var.identity, staff: staff.ctx };
}
const edit = { module: "drama", need: "edit" } as const;
export const adminDramaHandlers = [
  defineAdminHandler(adminDramaConfirmPermitRecheck, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.confirmPermit(
        contentActor(c, staff),
        c.req.valid("param").dramaId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminDramaCopyrightReplace, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.replace(
        contentActor(c, staff),
        c.req.valid("param").dramaId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(
    adminDramaDramaCopyrightRevisionCreate,
    { module: "drama", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await c.var.runtime.contentAdmin.revise(
          contentActor(c, staff),
          c.req.valid("param").dramaId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      );
    },
  ),
];
