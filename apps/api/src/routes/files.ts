import {
  mFileCreate,
  mFileGet,
  mFileCancel,
  mFileComplete,
  mFileRefreshCredentials,
  FileRegistrationSchema,
  FileRegistrationListSchema,
  FileStatusViewSchema,
} from "@liyoxi/contract";
import { AppError, standingOf } from "@liyoxi/services";
import type { MediaActor } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { defineHandler } from "../routing/define.js";
function actorOf(c: Context<ApiEnv>): MediaActor {
  const membership = c.get("membership");
  const identity = c.get("identity");
  if (!membership || !identity) throw new AppError("NOT_A_MEMBER");
  return {
    identity,
    merchant: {
      standing: standingOf(membership.role, membership.storeMode),
      entityId: membership.entityId,
      storeId: membership.storeId,
    },
  };
}
export const merchantFileHandlers = [
  defineHandler(mFileCreate, async (c) =>
    ok(
      c,
      FileRegistrationListSchema.parse(
        await c.var.runtime.media.register(actorOf(c), c.req.valid("json"), { idem: idemOf(c) }),
      ),
    ),
  ),
  defineHandler(mFileGet, async (c) =>
    ok(
      c,
      FileStatusViewSchema.parse(
        await c.var.runtime.media.getMerchant(actorOf(c), c.req.valid("param").fileId),
      ),
    ),
  ),
  defineHandler(mFileRefreshCredentials, async (c) =>
    ok(
      c,
      FileRegistrationSchema.parse(
        await c.var.runtime.media.refresh(actorOf(c), c.req.valid("param").fileId, {
          idem: idemOf(c),
        }),
      ),
    ),
  ),
  defineHandler(mFileComplete, async (c) =>
    ok(
      c,
      FileStatusViewSchema.parse(
        await c.var.runtime.media.complete(actorOf(c), c.req.valid("param").fileId, {
          idem: idemOf(c),
        }),
      ),
    ),
  ),
  defineHandler(mFileCancel, async (c) =>
    ok(
      c,
      FileStatusViewSchema.parse(
        await c.var.runtime.media.cancel(actorOf(c), c.req.valid("param").fileId, {
          idem: idemOf(c),
        }),
      ),
    ),
  ),
];
