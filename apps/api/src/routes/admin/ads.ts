import {
  adminAdList,
  adminAdSummary,
  adminAdGet,
  adminAdAssign,
  adminAdReturn,
  adminAdAdVersionCreate,
  adminAdRequestChange,
  adminAdRemind,
  adminAdVersionPush,
  adminAdVersionMarkSent,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";

const view = { module: "delivery", need: "view" } as const;
const edit = { module: "delivery", need: "edit" } as const;
export const adminAdHandlers = [
  defineAdminHandler(adminAdList, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.adminAds.list(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("query"),
      ),
    );
  }),
  defineAdminHandler(adminAdSummary, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.adminAds.summary(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("query"),
      ),
    );
  }),
  defineAdminHandler(adminAdGet, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.adminAds.get(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").adId,
      ),
    );
  }),
  defineAdminHandler(adminAdAssign, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.adminAds.assign(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").adId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminAdReturn, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.adminAds.return(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").adId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminAdAdVersionCreate, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.adminAds.registerVersion(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").adId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminAdVersionPush, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.adminAds.push(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").adVersionId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminAdVersionMarkSent, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.adminAds.markSent(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").adVersionId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminAdRequestChange, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.adminAds.requestChange(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").adId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminAdRemind, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.adminAds.remind(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").adId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
];
