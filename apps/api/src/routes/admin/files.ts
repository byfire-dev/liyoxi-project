import {
  adminFileCreate,
  adminFileGet,
  adminFileComplete,
  adminFileDownloadUrls,
  AdminFileViewSchema,
  FileRegistrationSchema,
  SignedUrlSchema,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
export const adminFileHandlers = [
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
