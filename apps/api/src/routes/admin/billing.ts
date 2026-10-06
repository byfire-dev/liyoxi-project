import {
  adminPaymentOrderGet,
  adminTransferProofList,
  adminTransferProofSummary,
  adminTransferProofGet,
  adminTransferProofConfirm,
  adminTransferProofReject,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
export const adminBillingHandlers = [
  defineAdminHandler(adminPaymentOrderGet, { module: "order", need: "view" }, async (c, s) =>
    ok(c, await c.var.runtime.billing.getAdminOrder(s.ctx, c.req.valid("param").paymentOrderId)),
  ),
  defineAdminHandler(adminTransferProofList, { module: "order", need: "view" }, async (c) =>
    ok(c, await c.var.runtime.billing.listProofs(c.req.valid("query"))),
  ),
  defineAdminHandler(adminTransferProofSummary, { module: "order", need: "view" }, async (c) =>
    ok(c, await c.var.runtime.billing.proofSummary(c.req.valid("query").q)),
  ),
  defineAdminHandler(adminTransferProofGet, null, async (c, s) =>
    ok(c, await c.var.runtime.billing.getProof(s.ctx, c.req.valid("param").transferProofId)),
  ),
  defineAdminHandler(adminTransferProofConfirm, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.confirmProof(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").transferProofId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminTransferProofReject, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.rejectProof(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").transferProofId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
];
