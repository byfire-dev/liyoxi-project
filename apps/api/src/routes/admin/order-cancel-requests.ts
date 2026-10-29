import {
  adminCancelRequestApprove,
  adminCancelRequestGet,
  adminCancelRequestList,
  adminCancelRequestReject,
  adminCancelRequestSummary,
  adminCancelRequestVoid,
  adminCancelRequestWithdraw,
  adminOrderCancelQuote,
  adminOrderCancelRequestCreate,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";

export const adminOrderCancelRequestHandlers = [
  defineAdminHandler(adminCancelRequestList, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.cancelRequests.list(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("query"),
      ),
    );
  }),
  defineAdminHandler(adminCancelRequestSummary, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.cancelRequests.summary(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("query"),
      ),
    );
  }),
  defineAdminHandler(adminCancelRequestGet, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.cancelRequests.get(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").cancelRequestId,
      ),
    );
  }),
  defineAdminHandler(adminOrderCancelQuote, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.cancelRequests.quote(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").orderId,
        c.req.valid("json"),
      ),
    );
  }),
  defineAdminHandler(adminOrderCancelRequestCreate, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.cancelRequests.create(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").orderId,
        c.req.valid("json"),
        idemOf(c),
      ),
    );
  }),
  defineAdminHandler(adminCancelRequestApprove, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.cancelRequests.approve(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").cancelRequestId,
        c.req.valid("json"),
        idemOf(c),
      ),
    );
  }),
  defineAdminHandler(adminCancelRequestReject, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.cancelRequests.reject(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").cancelRequestId,
        c.req.valid("json"),
        idemOf(c),
      ),
    );
  }),
  defineAdminHandler(adminCancelRequestWithdraw, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.cancelRequests.withdraw(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").cancelRequestId,
        c.req.valid("json"),
        idemOf(c),
      ),
    );
  }),
  defineAdminHandler(adminCancelRequestVoid, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.cancelRequests.void(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").cancelRequestId,
        c.req.valid("json"),
        idemOf(c),
      ),
    );
  }),
];
