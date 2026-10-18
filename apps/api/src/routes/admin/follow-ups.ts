import {
  adminFollowUpList,
  adminFollowUpCreate,
  adminFollowUpUpdate,
  adminFollowUpComplete,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";

// 对象决定模块；真实模块/范围及负责人守卫由staff拥有者在当前事务内判定。
export const adminFollowUpHandlers = [
  defineAdminHandler(adminFollowUpList, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.followUps.list(staff.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminFollowUpCreate, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.followUps.create(staff.ctx, c.var.identity!, c.req.valid("json"), {
        idem: idemOf(c),
      }),
    );
  }),
  defineAdminHandler(adminFollowUpUpdate, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.followUps.update(
        staff.ctx,
        c.var.identity!,
        c.req.valid("param").followUpId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminFollowUpComplete, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.followUps.complete(
        staff.ctx,
        c.var.identity!,
        c.req.valid("param").followUpId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
];
