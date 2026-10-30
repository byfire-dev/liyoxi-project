import {
  adminFileCreate,
  adminFileGet,
  adminFileComplete,
  adminFileDownloadUrls,
  adminFileRefreshCredentials,
  adminFileCancel,
  adminFileList,
  adminFileRestore,
  adminFileErase,
  AdminFilePageSchema,
  AdminFileViewSchema,
  FileRegistrationSchema,
  SignedUrlSchema,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
import { fileRetentionActor } from "./file-retention-context.js";
export const adminFileHandlers = [
  defineAdminHandler(adminFileList, { module: "system", need: "view" }, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      AdminFilePageSchema.parse(
        await c.var.runtime.media.retention.listFiles(
          fileRetentionActor(c.var.identity!, staff),
          c.req.valid("query"),
        ),
      ),
    );
  }),
  defineAdminHandler(adminFileRestore, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      AdminFileViewSchema.parse(
        await c.var.runtime.media.retention.restore(
          fileRetentionActor(c.var.identity!, staff),
          c.req.valid("param").fileId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    );
  }),
  defineAdminHandler(adminFileErase, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      AdminFileViewSchema.parse(
        await c.var.runtime.media.retention.erase(
          fileRetentionActor(c.var.identity!, staff),
          c.req.valid("param").fileId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    );
  }),
  defineAdminHandler(adminFileRefreshCredentials, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      FileRegistrationSchema.parse(
        await c.var.runtime.media.refresh(
          { identity: c.var.identity!, staff: staff.ctx },
          c.req.valid("param").fileId,
        ),
      ),
    );
  }),
  defineAdminHandler(adminFileCancel, null, async (c, staff) =>
    ok(
      c,
      AdminFileViewSchema.parse(
        await c.var.runtime.media.cancelAdmin(
          { identity: c.var.identity!, staff: staff.ctx },
          c.req.valid("param").fileId,
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminFileCreate, null, async (c, staff) => {
    const body = c.req.valid("json");
    const result = await c.var.runtime.media.register(
      { identity: c.var.identity!, staff: staff.ctx },
      {
        ...body,
        files: [
          { fileName: body.fileName, sizeBytes: body.sizeBytes, clientToken: body.clientToken },
        ],
      },
      { idem: idemOf(c) },
    );
    return ok(c, FileRegistrationSchema.parse(result.items[0]));
  }),
  defineAdminHandler(adminFileGet, null, async (c, staff) =>
    ok(
      c,
      AdminFileViewSchema.parse(
        await c.var.runtime.media.getAdmin(
          { identity: c.var.identity!, staff: staff.ctx },
          c.req.valid("param").fileId,
        ),
      ),
    ),
  ),
  defineAdminHandler(adminFileComplete, null, async (c, staff) =>
    ok(
      c,
      AdminFileViewSchema.parse(
        await c.var.runtime.media.completeAdmin(
          { identity: c.var.identity!, staff: staff.ctx },
          c.req.valid("param").fileId,
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminFileDownloadUrls, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const signed = await c.var.runtime.media.downloadUrls(
      { identity: c.var.identity!, staff: staff.ctx },
      { fileId: c.req.valid("param").fileId, ...c.req.valid("json") },
      {
        requestId: c.var.requestId,
        ip: c.var.clientIp,
        userAgent: c.req.header("User-Agent") ?? null,
        authMethod:
          staff.principal.session.authMethod === "password+recovery"
            ? "password+recovery"
            : "password+totp",
        sessionId: staff.principal.session.id,
      },
      { idem: idemOf(c) },
    );
    return ok(c, SignedUrlSchema.parse(signed));
  }),
];
