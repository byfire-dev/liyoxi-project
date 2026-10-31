import {
  mLicenseLetterList,
  mLicenseLetterSummary,
  mLicenseLetterGet,
  mLicenseLetterDownloadUrls,
  LicenseLetterPageSchema,
  LicenseLetterSummarySchema,
  LicenseLetterDetailSchema,
  LicenseLetterDownloadUrlSchema,
} from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import type { LicenseViewer } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { merchantSessionOf } from "../http/merchant-auth.js";
import { defineHandler } from "../routing/define.js";
const viewer = (c: Context<ApiEnv>): LicenseViewer => {
  const identity = c.var.identity,
    membership = c.var.membership;
  if (!identity || !membership) throw new AppError("NOT_A_MEMBER");
  return {
    identity,
    merchantUserId: merchantSessionOf(c).merchantUserId,
    entityId: membership.entityId,
  };
};
const privateOk = async <T>(c: Context<ApiEnv>, read: () => Promise<T>) => {
  c.header("Cache-Control", "no-store");
  return ok(c, await read());
};
export const licenseLetterHandlers = [
  defineHandler(mLicenseLetterList, async (c) =>
    privateOk(c, async () =>
      LicenseLetterPageSchema.parse(
        await c.var.runtime.licenseRead.list(viewer(c), c.req.valid("query")),
      ),
    ),
  ),
  defineHandler(mLicenseLetterSummary, async (c) =>
    privateOk(c, async () =>
      LicenseLetterSummarySchema.parse(
        await c.var.runtime.licenseRead.summary(viewer(c), c.req.valid("query")),
      ),
    ),
  ),
  defineHandler(mLicenseLetterGet, async (c) =>
    privateOk(c, async () =>
      LicenseLetterDetailSchema.parse(
        await c.var.runtime.licenseRead.get(viewer(c), c.req.valid("param").licenseLetterId),
      ),
    ),
  ),
  defineHandler(mLicenseLetterDownloadUrls, async (c) =>
    privateOk(c, async () =>
      LicenseLetterDownloadUrlSchema.parse(
        await c.var.runtime.licenseRead.download(
          viewer(c),
          c.req.valid("param").licenseLetterId,
          c.req.valid("json"),
          {
            requestId: c.var.requestId,
            ip: c.var.clientIp,
            userAgent: c.req.header("User-Agent") ?? null,
            authMethod: "weapp",
            sessionId: c.var.sessionId ?? null,
          },
        ),
      ),
    ),
  ),
];
