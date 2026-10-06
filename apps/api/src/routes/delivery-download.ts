import {
  mSampleDownloadUrls,
  mOrderItemReleaseGet,
  mOrderItemDownloadUrls,
  adminDeliveryReleaseGet,
  DownloadUrlSchema,
  EpisodeDownloadUrlSchema,
  ReleaseViewSchema,
  DeliveryReleaseDetailSchema,
} from "@liyoxi/contract";
import { AppError, createDeliveryDownloads } from "@liyoxi/services";
import type { DeliveryDownloads, DeliveryViewer, Runtime } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { defineHandler } from "../routing/define.js";
import { defineAdminHandler } from "../routing/admin.js";
const built = new WeakMap<Runtime, DeliveryDownloads>();
function downloadsOf(runtime: Runtime) {
  let service = built.get(runtime);
  if (!service) {
    const { tx, clock, assembly, media } = runtime;
    service = createDeliveryDownloads({
      tx,
      clock,
      assembly,
      media,
      samplePlayback: (entityId) =>
        runtime.config.flags.isEnabled("weapp.video.sample.enabled", { entityId }),
    });
    built.set(runtime, service);
  }
  return service;
}
const viewer = (c: Context<ApiEnv>): DeliveryViewer => {
  if (!c.var.identity || !c.var.membership) throw new AppError("NOT_A_MEMBER");
  return { ctx: c.var.identity, membership: c.var.membership };
};
const meta = (c: Context<ApiEnv>): Parameters<DeliveryDownloads["sampleUrl"]>[2] => ({
  requestId: c.var.requestId,
  ip: c.var.clientIp,
  userAgent: c.req.header("User-Agent") ?? null,
  sessionId: c.var.sessionId ?? null,
  authMethod: "weapp",
});
const privateOk = <T>(c: Context<ApiEnv>, data: T) => {
  c.header("Cache-Control", "no-store");
  return ok(c, data);
};
export const deliveryDownloadHandlers = [
  defineHandler(mSampleDownloadUrls, async (c) => {
    const result = await downloadsOf(c.var.runtime).sampleUrl(
      viewer(c),
      c.req.valid("param").sampleId,
      meta(c),
    );
    return privateOk(c, DownloadUrlSchema.parse(result));
  }),
  defineHandler(mOrderItemReleaseGet, async (c) =>
    privateOk(
      c,
      ReleaseViewSchema.parse(
        await downloadsOf(c.var.runtime).release(viewer(c), c.req.valid("param").orderItemId),
      ),
    ),
  ),
  defineHandler(mOrderItemDownloadUrls, async (c) => {
    const result = await downloadsOf(c.var.runtime).episodeUrl(
      viewer(c),
      c.req.valid("param").orderItemId,
      c.req.valid("json"),
      meta(c),
    );
    return privateOk(c, EpisodeDownloadUrlSchema.parse(result));
  }),
  defineAdminHandler(
    adminDeliveryReleaseGet,
    { module: "publish", need: "view" },
    async (c, staff) =>
      privateOk(
        c,
        DeliveryReleaseDetailSchema.parse(
          await downloadsOf(c.var.runtime).adminRelease(
            staff.taskScope,
            c.req.valid("param").deliveryReleaseId,
          ),
        ),
      ),
  ),
];
