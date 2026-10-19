import {
  adminPointAccountList,
  adminPointAccountSummary,
  adminPointAccountGet,
  adminPointAccountPointLedgerEntryList,
  adminPointAccountAdjustmentQuote,
  adminPointAdjustmentRequestCreate,
  adminPointAdjustmentRequestGet,
  adminPointAdjustmentRequestApprove,
  adminPointAdjustmentRequestReject,
  adminPointAdjustmentRequestWithdraw,
  adminSubscriptionTermExtensionQuote,
  adminTermExtensionRequestCreate,
  adminTermExtensionRequestGet,
  adminTermExtensionRequestApprove,
  adminTermExtensionRequestReject,
  adminTermExtensionRequestWithdraw,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";

const view = { module: "billing", need: "view" } as const;
export const adminBillingAdjustmentHandlers = [
  defineAdminHandler(adminPointAccountList, view, async (c, s) =>
    ok(c, await c.var.runtime.billing.accounts.list(s.ctx, c.req.valid("query"))),
  ),
  defineAdminHandler(adminPointAccountSummary, view, async (c, s) =>
    ok(c, await c.var.runtime.billing.accounts.summary(s.ctx, c.req.valid("query"))),
  ),
  defineAdminHandler(adminPointAccountGet, view, async (c, s) =>
    ok(c, await c.var.runtime.billing.accounts.get(s.ctx, c.req.valid("param").pointAccountId)),
  ),
  defineAdminHandler(adminPointAccountPointLedgerEntryList, view, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.accounts.adminLedger(
        s.ctx,
        c.req.valid("param").pointAccountId,
        c.req.valid("query"),
      ),
    ),
  ),
  defineAdminHandler(adminPointAccountAdjustmentQuote, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.adjustments.adjustmentQuote(
        { identity: c.var.identity!, staff: s.ctx },
        c.req.valid("param").pointAccountId,
        c.req.valid("json"),
      ),
    ),
  ),
  defineAdminHandler(adminPointAdjustmentRequestCreate, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.adjustments.points.create(
        { identity: c.var.identity!, staff: s.ctx },
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminPointAdjustmentRequestGet, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.adjustments.points.get(
        s.ctx,
        c.req.valid("param").pointAdjustmentRequestId,
      ),
    ),
  ),
  defineAdminHandler(adminPointAdjustmentRequestApprove, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.adjustments.points.approve(
        { identity: c.var.identity!, staff: s.ctx },
        c.req.valid("param").pointAdjustmentRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminPointAdjustmentRequestReject, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.adjustments.points.reject(
        { identity: c.var.identity!, staff: s.ctx },
        c.req.valid("param").pointAdjustmentRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminPointAdjustmentRequestWithdraw, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.adjustments.points.withdraw(
        { identity: c.var.identity!, staff: s.ctx },
        c.req.valid("param").pointAdjustmentRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminSubscriptionTermExtensionQuote, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.adjustments.extensionQuote(
        { identity: c.var.identity!, staff: s.ctx },
        c.req.valid("param").subscriptionTermId,
        c.req.valid("json").days,
      ),
    ),
  ),
  defineAdminHandler(adminTermExtensionRequestCreate, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.adjustments.extensions.create(
        { identity: c.var.identity!, staff: s.ctx },
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminTermExtensionRequestGet, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.adjustments.extensions.get(
        s.ctx,
        c.req.valid("param").termExtensionRequestId,
      ),
    ),
  ),
  defineAdminHandler(adminTermExtensionRequestApprove, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.adjustments.extensions.approve(
        { identity: c.var.identity!, staff: s.ctx },
        c.req.valid("param").termExtensionRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminTermExtensionRequestReject, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.adjustments.extensions.reject(
        { identity: c.var.identity!, staff: s.ctx },
        c.req.valid("param").termExtensionRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminTermExtensionRequestWithdraw, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.adjustments.extensions.withdraw(
        { identity: c.var.identity!, staff: s.ctx },
        c.req.valid("param").termExtensionRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
];
