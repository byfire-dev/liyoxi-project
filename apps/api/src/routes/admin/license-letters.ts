import {
  adminOrderItemLicenseLetterList,
  adminLicenseLetterCorrect,
  adminLicenseLetterVoid,
  adminLicenseLetterRevisionRerender,
  LicenseLetterListSchema,
  AdminLicenseLetterViewSchema,
  LicenseLetterVoidResultSchema,
  LicenseLetterRevisionViewSchema,
} from "@liyoxi/contract";
import type { Context } from "hono";
import type { ApiEnv } from "../../context.js";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
import { configActor } from "./system-config-context.js";
const view = { module: "order", need: "view" } as const;
function actor(...args: Parameters<typeof configActor>) {
  const context = configActor(...args);
  if (!context.meta) throw new TypeError("授权书操作缺少审计请求上下文");
  return { ...context, meta: context.meta };
}
const privateOk = async <T>(c: Context<ApiEnv>, read: () => Promise<T>) => {
  c.header("Cache-Control", "no-store");
  return ok(c, await read());
};
export const adminLicenseLetterHandlers = [
  defineAdminHandler(adminOrderItemLicenseLetterList, view, async (c, staff) =>
    privateOk(c, async () =>
      LicenseLetterListSchema.parse(
        await c.var.runtime.licenseAdmin.list(
          actor(c, staff),
          c.req.valid("param").orderItemId,
          c.req.valid("query"),
        ),
      ),
    ),
  ),
  defineAdminHandler(adminLicenseLetterCorrect, view, async (c, staff) =>
    privateOk(c, async () =>
      AdminLicenseLetterViewSchema.parse(
        await c.var.runtime.licenseAdmin.correct(
          actor(c, staff),
          c.req.valid("param").licenseLetterId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminLicenseLetterVoid, view, async (c, staff) =>
    privateOk(c, async () =>
      LicenseLetterVoidResultSchema.parse(
        await c.var.runtime.licenseAdmin.void(
          actor(c, staff),
          c.req.valid("param").licenseLetterId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminLicenseLetterRevisionRerender, view, async (c, staff) =>
    privateOk(c, async () =>
      LicenseLetterRevisionViewSchema.parse(
        await c.var.runtime.licenseAdmin.rerender(
          actor(c, staff),
          c.req.valid("param").licenseLetterRevisionId,
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
];
