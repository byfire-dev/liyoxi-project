import {
  adminUploadBatchCreate,
  adminUploadBatchGet,
  adminUploadBatchStart,
  adminUploadBatchRefreshCredentials,
  adminUploadBatchCancel,
  adminUploadBatchCommit,
  adminUploadBatchItemUpdate,
  adminUploadBatchItemComplete,
  UploadBatchDetailSchema,
  UploadBatchCommitResultSchema,
  UploadBatchItemSchema,
  BatchUploadCredentialsSchema,
} from "@liyoxi/contract";
import type { Context } from "hono";
import type { ApiEnv } from "../../context.js";
import type { AdminStaff } from "../../routing/admin.js";
import { defineAdminHandler } from "../../routing/admin.js";
import { idemOf } from "../../http/idempotency.js";
import { ok } from "../../http/errors.js";
const actor = (c: Context<ApiEnv>, staff: AdminStaff) => ({
  identity: c.var.identity!,
  staff: staff.ctx,
  audit: {
    requestId: c.var.requestId,
    ip: c.var.clientIp,
    userAgent: c.req.header("User-Agent") ?? null,
    authMethod:
      staff.principal.session.authMethod === "password+recovery"
        ? ("password+recovery" as const)
        : ("password+totp" as const),
    sessionId: staff.principal.session.id,
  },
});
export const adminUploadBatchHandlers = [
  defineAdminHandler(adminUploadBatchCreate, null, async (c, staff) =>
    ok(
      c,
      UploadBatchDetailSchema.parse(
        await c.var.runtime.media.uploadBatches.create(actor(c, staff), c.req.valid("json"), {
          idem: idemOf(c),
        }),
      ),
    ),
  ),
  defineAdminHandler(adminUploadBatchGet, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      UploadBatchDetailSchema.parse(
        await c.var.runtime.media.uploadBatches.get(
          actor(c, staff),
          c.req.valid("param").uploadBatchId,
        ),
      ),
    );
  }),
  defineAdminHandler(adminUploadBatchStart, null, async (c, staff) =>
    ok(
      c,
      UploadBatchDetailSchema.parse(
        await c.var.runtime.media.uploadBatches.start(
          actor(c, staff),
          c.req.valid("param").uploadBatchId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminUploadBatchRefreshCredentials, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      BatchUploadCredentialsSchema.parse(
        await c.var.runtime.media.uploadBatches.refreshCredentials(
          actor(c, staff),
          c.req.valid("param").uploadBatchId,
          c.req.valid("json"),
        ),
      ),
    );
  }),
  defineAdminHandler(adminUploadBatchItemUpdate, null, async (c, staff) =>
    ok(
      c,
      UploadBatchDetailSchema.parse(
        await c.var.runtime.media.uploadBatches.update(
          actor(c, staff),
          c.req.valid("param").uploadBatchItemId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminUploadBatchItemComplete, null, async (c, staff) =>
    ok(
      c,
      UploadBatchItemSchema.parse(
        await c.var.runtime.media.uploadBatches.complete(
          actor(c, staff),
          c.req.valid("param").uploadBatchItemId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminUploadBatchCancel, null, async (c, staff) =>
    ok(
      c,
      UploadBatchDetailSchema.parse(
        await c.var.runtime.media.uploadBatches.cancel(
          actor(c, staff),
          c.req.valid("param").uploadBatchId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminUploadBatchCommit, { module: "drama", need: "view" }, async (c, staff) =>
    ok(
      c,
      UploadBatchCommitResultSchema.parse(
        await c.var.runtime.media.uploadBatches.commit(
          actor(c, staff),
          c.req.valid("param").uploadBatchId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
];
