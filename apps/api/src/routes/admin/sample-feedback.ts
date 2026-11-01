import { adminSampleRequestChange, AdminSampleViewSchema } from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
import { deliveryOf } from "../delivery.js";

export const adminSampleFeedbackHandlers = [
  defineAdminHandler(
    adminSampleRequestChange,
    { module: "delivery", need: "edit" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        AdminSampleViewSchema.parse(
          await deliveryOf(c.var.runtime).adminSampleRequestChange(
            c.var.identity!,
            staff.ctx,
            c.req.valid("param").sampleId,
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      );
    },
  ),
];
