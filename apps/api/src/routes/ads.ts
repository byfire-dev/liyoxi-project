import {
  IdSchema,
  mAdList,
  mAdCreate,
  mAdQuote,
  mAdGet,
  mAdConfirm,
  mAdDownloadUrls,
  mAdRequestChange,
  mAdSubmit,
  mPlayableGet,
} from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import type { AdActor } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { merchantSessionOf } from "../http/merchant-auth.js";
import { defineHandler } from "../routing/define.js";
function actor(c: Context<ApiEnv>): AdActor {
  if (!c.var.identity || !c.var.membership) throw new AppError("NOT_A_MEMBER");
  return { ctx: c.var.identity, membership: c.var.membership, principal: merchantSessionOf(c) };
}
function privateOk<T>(c: Context<ApiEnv>, data: T) {
  c.header("Cache-Control", "no-store");
  return ok(c, data);
}
export const adHandlers = [
  defineHandler(mAdList, async (c) =>
    privateOk(c, await c.var.runtime.ads.list(actor(c), c.req.valid("query"))),
  ),
  defineHandler(mAdCreate, async (c) =>
    privateOk(
      c,
      await c.var.runtime.ads.create(actor(c), c.req.valid("json"), { idem: idemOf(c) }),
    ),
  ),
  defineHandler(mAdQuote, async (c) =>
    privateOk(c, await c.var.runtime.ads.quote(actor(c), c.req.valid("json"))),
  ),
  defineHandler(mAdGet, async (c) =>
    privateOk(c, await c.var.runtime.ads.get(actor(c), c.req.valid("param").adId)),
  ),
  defineHandler(mAdConfirm, async (c) =>
    privateOk(
      c,
      await c.var.runtime.ads.confirm(actor(c), c.req.valid("param").adId, c.req.valid("json"), {
        idem: idemOf(c),
      }),
    ),
  ),
  defineHandler(mAdDownloadUrls, async (c) =>
    privateOk(
      c,
      await c.var.runtime.ads.download(actor(c), c.req.valid("param").adId, c.req.valid("json")),
    ),
  ),
  defineHandler(mAdRequestChange, async (c) =>
    privateOk(
      c,
      await c.var.runtime.ads.requestChange(
        actor(c),
        c.req.valid("param").adId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineHandler(mAdSubmit, async (c) =>
    privateOk(
      c,
      await c.var.runtime.ads.submit(actor(c), c.req.valid("param").adId, c.req.valid("json"), {
        idem: idemOf(c),
      }),
    ),
  ),
  defineHandler(mPlayableGet, async (c) => {
    const raw = c.req.header("X-Store-Id"),
      parsed = raw ? IdSchema.safeParse(raw) : null;
    if (parsed && !parsed.success) throw new AppError("VALIDATION_FAILED");
    return privateOk(
      c,
      await c.var.runtime.playables.get(
        {
          merchantUserId: c.var.merchantSession?.merchantUserId,
          storeId: parsed?.success ? parsed.data : undefined,
        },
        c.req.valid("param").playableId,
      ),
    );
  }),
];
