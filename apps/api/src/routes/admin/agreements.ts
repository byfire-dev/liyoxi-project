import {
  adminAgreementList,
  adminAgreementGet,
  adminAgreementAgreementVersionCreate,
  adminAgreementVersionUpdate,
  adminAgreementVersionSchedule,
  adminAgreementVersionWithdraw,
  adminAgreementConsentList,
  adminAgreementConsentGet,
} from "@liyoxi/contract";
import { defineAdminHandler } from "../../routing/admin.js";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { configActor, configError } from "./system-config-context.js";
const view = { module: "ops", need: "view" } as const;
const edit = { module: "ops", need: "edit" } as const;
function actor(...args: Parameters<typeof configActor>) {
  const ctx = configActor(...args);
  if (!ctx.meta) throw new TypeError("协议操作缺少审计请求上下文");
  return { ...ctx, meta: ctx.meta };
}
async function result<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (error) {
    return configError(error);
  }
}
export const adminAgreementHandlers = [
  defineAdminHandler(adminAgreementList, view, async (c, staff) =>
    ok(c, await result(() => c.var.runtime.docsAdmin.list(actor(c, staff), c.req.valid("query")))),
  ),
  defineAdminHandler(adminAgreementGet, view, async (c, staff) =>
    ok(
      c,
      await result(() =>
        c.var.runtime.docsAdmin.get(actor(c, staff), c.req.valid("param").agreementKey),
      ),
    ),
  ),
  defineAdminHandler(adminAgreementAgreementVersionCreate, edit, async (c, staff) =>
    ok(
      c,
      await result(() =>
        c.var.runtime.docsAdmin.createVersion(
          actor(c, staff),
          c.req.valid("param").agreementKey,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminAgreementVersionUpdate, edit, async (c, staff) =>
    ok(
      c,
      await result(() =>
        c.var.runtime.docsAdmin.updateVersion(
          actor(c, staff),
          c.req.valid("param").agreementVersionId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminAgreementVersionSchedule, edit, async (c, staff) =>
    ok(
      c,
      await result(() =>
        c.var.runtime.docsAdmin.scheduleVersion(
          actor(c, staff),
          c.req.valid("param").agreementVersionId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminAgreementVersionWithdraw, edit, async (c, staff) =>
    ok(
      c,
      await result(() =>
        c.var.runtime.docsAdmin.withdrawVersion(
          actor(c, staff),
          c.req.valid("param").agreementVersionId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminAgreementConsentList, view, async (c, staff) =>
    ok(
      c,
      await result(() => c.var.runtime.docsAdmin.consents(actor(c, staff), c.req.valid("query"))),
    ),
  ),
  defineAdminHandler(adminAgreementConsentGet, view, async (c, staff) =>
    ok(
      c,
      await result(() =>
        c.var.runtime.docsAdmin.consent(actor(c, staff), c.req.valid("param").agreementConsentId),
      ),
    ),
  ),
];
