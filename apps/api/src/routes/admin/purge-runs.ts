import {
  adminPurgeRunList,
  adminPurgeRunApprove,
  adminPurgeRunReject,
  PurgeRunPageSchema,
  PurgeRunViewSchema,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
import { fileRetentionActor } from "./file-retention-context.js";

export const adminPurgeRunHandlers = [
  defineAdminHandler(adminPurgeRunList, { module: "system", need: "view" }, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      PurgeRunPageSchema.parse(
        await c.var.runtime.media.retention.listRuns(
          fileRetentionActor(c.var.identity!, staff),
          c.req.valid("query"),
        ),
      ),
    );
  }),
  defineAdminHandler(adminPurgeRunApprove, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      PurgeRunViewSchema.parse(
        await c.var.runtime.media.retention.approveRun(
          fileRetentionActor(c.var.identity!, staff),
          c.req.valid("param").purgeRunId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    );
  }),
  defineAdminHandler(adminPurgeRunReject, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      PurgeRunViewSchema.parse(
        await c.var.runtime.media.retention.rejectRun(
          fileRetentionActor(c.var.identity!, staff),
          c.req.valid("param").purgeRunId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    );
  }),
];
