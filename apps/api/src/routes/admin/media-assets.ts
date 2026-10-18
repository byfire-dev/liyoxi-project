import {
  adminAssetDemandCreate,
  adminAssetDemandList,
  adminAssetDemandCancel,
  adminAssetDemandComplete,
  adminStoreAssetCreate,
  adminStoreAssetGet,
  adminStoreAssetList,
  adminStoreAssetSummary,
  adminStoreAssetReview,
  adminStoreAssetConfirmPortraitAuth,
  adminStoreAssetPortraitAuthCreate,
  adminStoreAssetDelete,
  adminStoreAssetReprocess,
} from "@liyoxi/contract";
import type { MediaActor } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../../context.js";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
import type { AdminStaff } from "../../routing/admin.js";

function actorOf(c: Context<ApiEnv>, staff: AdminStaff): MediaActor {
  if (!c.var.identity) throw new Error("门店素材缺少身份上下文");
  return {
    identity: c.var.identity,
    staff: staff.ctx,
    audit: {
      requestId: c.var.requestId,
      ip: c.var.clientIp,
      userAgent: c.req.header("User-Agent") ?? null,
      authMethod:
        staff.principal.session.authMethod === "password+recovery"
          ? "password+recovery"
          : "password+totp",
      sessionId: staff.principal.session.id,
    },
  };
}
const view = { module: "merchant", need: "view" } as const;
export const adminMediaAssetHandlers = [
  defineAdminHandler(adminAssetDemandCreate, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.demands.create(
      actorOf(c, staff),
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    return ok(
      c,
      adminAssetDemandCreate.responses[200].content["application/json"].schema.shape.data.parse(
        result,
      ),
    );
  }),
  defineAdminHandler(adminAssetDemandList, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.demands.list(actorOf(c, staff), c.req.query());
    return ok(
      c,
      adminAssetDemandList.responses[200].content["application/json"].schema.shape.data.parse(
        result,
      ),
    );
  }),
  defineAdminHandler(adminAssetDemandCancel, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.demands.close(
      actorOf(c, staff),
      c.req.valid("param").assetDemandId,
      "cancel",
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    return ok(
      c,
      adminAssetDemandCancel.responses[200].content["application/json"].schema.shape.data.parse(
        result,
      ),
    );
  }),
  defineAdminHandler(adminAssetDemandComplete, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.demands.close(
      actorOf(c, staff),
      c.req.valid("param").assetDemandId,
      "complete",
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    return ok(
      c,
      adminAssetDemandComplete.responses[200].content["application/json"].schema.shape.data.parse(
        result,
      ),
    );
  }),
  defineAdminHandler(adminStoreAssetCreate, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.create(actorOf(c, staff), c.req.valid("json"), {
      idem: idemOf(c),
    });
    return ok(
      c,
      adminStoreAssetCreate.responses[200].content["application/json"].schema.shape.data.parse(
        result,
      ),
    );
  }),
  defineAdminHandler(adminStoreAssetSummary, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.summary(actorOf(c, staff), c.req.query());
    return ok(
      c,
      adminStoreAssetSummary.responses[200].content["application/json"].schema.shape.data.parse(
        result,
      ),
    );
  }),
  defineAdminHandler(adminStoreAssetGet, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.get(
      actorOf(c, staff),
      c.req.valid("param").storeAssetId,
    );
    return ok(
      c,
      adminStoreAssetGet.responses[200].content["application/json"].schema.shape.data.parse(result),
    );
  }),
  defineAdminHandler(adminStoreAssetList, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.list(actorOf(c, staff), c.req.query());
    return ok(
      c,
      adminStoreAssetList.responses[200].content["application/json"].schema.shape.data.parse(
        result,
      ),
    );
  }),

  defineAdminHandler(adminStoreAssetReview, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.review(
      actorOf(c, staff),
      c.req.valid("param").storeAssetId,
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    return ok(
      c,
      adminStoreAssetReview.responses[200].content["application/json"].schema.shape.data.parse(
        result,
      ),
    );
  }),
  defineAdminHandler(adminStoreAssetConfirmPortraitAuth, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.confirmPortrait(
      actorOf(c, staff),
      c.req.valid("param").storeAssetId,
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    return ok(
      c,
      adminStoreAssetConfirmPortraitAuth.responses[200].content[
        "application/json"
      ].schema.shape.data.parse(result),
    );
  }),
  defineAdminHandler(adminStoreAssetPortraitAuthCreate, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.portrait(
      actorOf(c, staff),
      c.req.valid("param").storeAssetId,
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    return ok(
      c,
      adminStoreAssetPortraitAuthCreate.responses[200].content[
        "application/json"
      ].schema.shape.data.parse(result),
    );
  }),
  defineAdminHandler(adminStoreAssetDelete, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.remove(
      actorOf(c, staff),
      c.req.valid("param").storeAssetId,
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    return ok(
      c,
      adminStoreAssetDelete.responses[200].content["application/json"].schema.shape.data.parse(
        result,
      ),
    );
  }),
  defineAdminHandler(adminStoreAssetReprocess, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.reprocess(
      actorOf(c, staff),
      c.req.valid("param").storeAssetId,
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    return ok(
      c,
      adminStoreAssetReprocess.responses[200].content["application/json"].schema.shape.data.parse(
        result,
      ),
    );
  }),
];
