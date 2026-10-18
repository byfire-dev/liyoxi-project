// W4-04：授权管线与正式幂等上下文由既有后台切片执行。
import {
  adminPaymentOrderCreate,
  adminPaymentOrderTransferProofCreate,
  adminTransferProofApproveReview,
  adminTransferProofRejectReview,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
export const adminBillingTransferReviewHandlers = [
  defineAdminHandler(adminPaymentOrderCreate, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.createAdminOrder(c.var.identity!, s.ctx, c.req.valid("json"), {
        idem: idemOf(c),
      }),
    ),
  ),
  defineAdminHandler(adminPaymentOrderTransferProofCreate, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.createAdminTransferProof(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").paymentOrderId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminTransferProofApproveReview, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.approveTransferReview(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").transferProofId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminTransferProofRejectReview, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.rejectTransferReview(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").transferProofId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
];
