import {
  mAssetDemandList,
  mStoreAssetCreate,
  mStoreAssetGet,
  mStoreAssetList,
  mStoreAssetSummary,
  mStoreAssetFeedbackCreate,
  mStoreAssetPortraitAuthCreate,
} from "@liyoxi/contract";
import { AppError, standingOf } from "@liyoxi/services";
import type { MediaActor } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { defineHandler } from "../routing/define.js";

function actorOf(c: Context<ApiEnv>): MediaActor {
  const membership = c.var.membership,
    identity = c.var.identity;
  if (!membership || !identity) throw new AppError("NOT_A_MEMBER");
  return {
    identity,
    merchant: {
      entityId: membership.entityId,
      storeId: membership.storeId,
      standing: standingOf(membership.role, membership.storeMode),
    },
  };
}

export const mediaAssetHandlers = [
  defineHandler(mAssetDemandList, async (c) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.demands.list(actorOf(c), c.req.query());
    return ok(
      c,
      mAssetDemandList.responses[200].content["application/json"].schema.shape.data.parse(result),
    );
  }),
  defineHandler(mStoreAssetCreate, async (c) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.create(actorOf(c), c.req.valid("json"), {
      idem: idemOf(c),
    });
    return ok(
      c,
      mStoreAssetCreate.responses[200].content["application/json"].schema.shape.data.parse(result),
    );
  }),
  defineHandler(mStoreAssetSummary, async (c) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.summary(actorOf(c), c.req.query());
    return ok(
      c,
      mStoreAssetSummary.responses[200].content["application/json"].schema.shape.data.parse(result),
    );
  }),
  defineHandler(mStoreAssetGet, async (c) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.get(
      actorOf(c),
      c.req.valid("param").storeAssetId,
    );
    return ok(
      c,
      mStoreAssetGet.responses[200].content["application/json"].schema.shape.data.parse(result),
    );
  }),
  defineHandler(mStoreAssetList, async (c) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.list(actorOf(c), c.req.query());
    return ok(
      c,
      mStoreAssetList.responses[200].content["application/json"].schema.shape.data.parse(result),
    );
  }),

  defineHandler(mStoreAssetFeedbackCreate, async (c) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.feedback(
      actorOf(c),
      c.req.valid("param").storeAssetId,
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    return ok(
      c,
      mStoreAssetFeedbackCreate.responses[200].content["application/json"].schema.shape.data.parse(
        result,
      ),
    );
  }),
  defineHandler(mStoreAssetPortraitAuthCreate, async (c) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.media.assets.portrait(
      actorOf(c),
      c.req.valid("param").storeAssetId,
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    return ok(
      c,
      mStoreAssetPortraitAuthCreate.responses[200].content[
        "application/json"
      ].schema.shape.data.parse(result),
    );
  }),
];
