import {
  portalOrderItemList,
  portalOrderItemReleaseGet,
  portalOrderItemDownloadUrls,
  portalAdList,
  portalAdGet,
  portalAdPlaybackUrls,
  portalLicenseVerificationGet,
  portalClientErrorCreate,
  PortalOrderItemPageSchema,
  PortalReleaseViewSchema,
  PortalDownloadResultSchema,
  PortalAdPageSchema,
  PortalAdDetailSchema,
  PlayableSchema,
  LicenseVerificationViewSchema,
} from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import type { audit } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { portalPrincipalOf, portalRequestMeta } from "../http/portal-auth.js";
import { defineHandler } from "../routing/define.js";

const accessMeta = (c: Context<ApiEnv>): audit.AuditRequestMeta => ({
  ...portalRequestMeta(c),
  sessionId: portalPrincipalOf(c).sessionId,
  authMethod: "portal",
});

// The existing portal middleware owns fixed session scope, no-store and CSRF.
export const portalContentHandlers = [
  defineHandler(portalOrderItemList, async (c) =>
    ok(
      c,
      PortalOrderItemPageSchema.parse(
        await c.var.runtime.portalDeliveryDownloads.list(
          portalPrincipalOf(c),
          c.req.valid("query"),
        ),
      ),
    ),
  ),
  defineHandler(portalOrderItemReleaseGet, async (c) =>
    ok(
      c,
      PortalReleaseViewSchema.parse(
        await c.var.runtime.portalDeliveryDownloads.release(
          portalPrincipalOf(c),
          c.req.valid("param").orderItemId,
        ),
      ),
    ),
  ),
  defineHandler(portalOrderItemDownloadUrls, async (c) =>
    ok(
      c,
      PortalDownloadResultSchema.parse(
        await c.var.runtime.portalDeliveryDownloads.downloadUrls(
          portalPrincipalOf(c),
          c.req.valid("param").orderItemId,
          c.req.valid("json"),
          accessMeta(c),
        ),
      ),
    ),
  ),
  defineHandler(portalAdList, async (c) =>
    ok(
      c,
      PortalAdPageSchema.parse(
        await c.var.runtime.portalAds.list(portalPrincipalOf(c), c.req.valid("query")),
      ),
    ),
  ),
  defineHandler(portalAdGet, async (c) =>
    ok(
      c,
      PortalAdDetailSchema.parse(
        await c.var.runtime.portalAds.get(portalPrincipalOf(c), c.req.valid("param").adId),
      ),
    ),
  ),
  defineHandler(portalAdPlaybackUrls, async (c) =>
    ok(
      c,
      PlayableSchema.parse(
        await c.var.runtime.portalAds.playbackUrls(
          portalPrincipalOf(c),
          c.req.valid("param").adId,
          c.req.valid("json"),
          accessMeta(c),
        ),
      ),
    ),
  ),
  defineHandler(portalLicenseVerificationGet, async (c) =>
    ok(
      c,
      LicenseVerificationViewSchema.parse(
        await c.var.runtime.licenseVerification.get(c.req.valid("query")),
      ),
    ),
  ),
  defineHandler(portalClientErrorCreate, async (c) => {
    if (
      c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/x-sentry-envelope"
    )
      throw new AppError("VALIDATION_FAILED");
    c.var.runtime.clientErrors.accept(new Uint8Array(await c.req.arrayBuffer()));
    return c.json({ code: 0 as const, message: "ok" as const, data: null }, 202);
  }),
];
