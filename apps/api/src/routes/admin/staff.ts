// a01 员工增查：鉴权由 defineAdminHandler，业务与读权留在 staff 服务。
import {
  adminStaffCreate,
  adminStaffGet,
  adminStaffList,
  StaffDetailSchema,
  StaffMutationResultSchema,
} from "@liyoxi/contract";
import { staff, security } from "@liyoxi/services";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
import type { Runtime } from "@liyoxi/services";

export const staffManagementOf = (runtime: Runtime) =>
  staff.createStaffManagement({
    tx: runtime.tx,
    clock: runtime.clock,
    flow: runtime.flow,
    config: runtime.config,
    keyring: () => security.loadKeyring(runtime.env),
  });

export const adminStaffHandlers = [
  defineAdminHandler(adminStaffList, null, async (c, current) => {
    const page = await staffManagementOf(c.var.runtime).list(current.ctx, c.req.valid("query"));
    c.header("Cache-Control", "no-store");
    return ok(c, page);
  }),
  defineAdminHandler(adminStaffGet, { module: "system", need: "view" }, async (c, current) => {
    const detail = await staffManagementOf(c.var.runtime).get(
      current.ctx,
      c.req.valid("param").staffId,
    );
    c.header("Cache-Control", "no-store");
    return ok(c, StaffDetailSchema.parse(detail));
  }),
  defineAdminHandler(adminStaffCreate, { module: "system", need: "view" }, async (c, current) => {
    const result = await staffManagementOf(c.var.runtime).create(
      current.ctx,
      c.var.identity!,
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return ok(c, StaffMutationResultSchema.parse(result));
  }),
];
