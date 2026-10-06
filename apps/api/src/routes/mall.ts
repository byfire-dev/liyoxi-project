import {
  IdSchema,
  mHomeGet,
  mMallConfigGet,
  mDramaList,
  mDramaGet,
  HomeOwnerSchema,
  HomeClerkSchema,
  HomeGuestSchema,
  DramaPageOwnerSchema,
  DramaPageClerkSchema,
  DramaPageGuestSchema,
  DramaDetailOwnerSchema,
  DramaDetailClerkSchema,
  DramaDetailGuestSchema,
} from "@liyoxi/contract";
import type { HomeView, DramaPage, DramaDetail } from "@liyoxi/contract";
import { createMall, cropMerchantView } from "@liyoxi/services";
import type { Runtime, Mall, MallViewer } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";
import { ok } from "../http/errors.js";
const built = new WeakMap<Runtime, Mall>();
function mallOf(runtime: Runtime): Mall {
  let service = built.get(runtime);
  if (!service) {
    service = createMall({
      tx: runtime.tx,
      clock: runtime.clock,
      content: runtime.content,
      config: runtime.config,
      media: runtime.media,
    });
    built.set(runtime, service);
  }
  return service;
}
/** optional 只接受本次请求指明门店的关系；不能借账号另一家门店提升角色。 */
async function viewerOf(c: Context<ApiEnv>): Promise<MallViewer> {
  const session = c.get("merchantSession"),
    store = IdSchema.safeParse(c.req.header("X-Store-Id"));
  if (!session || !store.success) return { role: "guest", storeId: null, entityId: null };
  const membership = await c.var.runtime.tx.run((tx) =>
    merchantServicesOf(c.var.runtime).tenant.resolveMembership(tx, {
      merchantUserId: session.merchantUserId,
      storeId: store.data,
    }),
  );
  return membership
    ? { role: membership.role, storeId: membership.storeId, entityId: membership.entityId }
    : { role: "guest", storeId: null, entityId: null };
}
export const mallHandlers = [
  defineHandler(mMallConfigGet, async (c) => ok(c, await mallOf(c.var.runtime).config())),
  defineHandler(mHomeGet, async (c) => {
    c.header("Cache-Control", "no-store");
    const viewer = await viewerOf(c),
      raw = await mallOf(c.var.runtime).home(viewer, c.req.valid("query").cityCode);
    return ok(
      c,
      cropMerchantView<HomeView>(
        viewer.role,
        { owner: HomeOwnerSchema, clerk: HomeClerkSchema, guest: HomeGuestSchema },
        raw,
      ),
    );
  }),
  defineHandler(mDramaList, async (c) => {
    c.header("Cache-Control", "no-store");
    const viewer = await viewerOf(c),
      raw = await mallOf(c.var.runtime).list(viewer, c.req.valid("query"));
    return ok(
      c,
      cropMerchantView<DramaPage>(
        viewer.role,
        { owner: DramaPageOwnerSchema, clerk: DramaPageClerkSchema, guest: DramaPageGuestSchema },
        raw,
      ),
    );
  }),
  defineHandler(mDramaGet, async (c) => {
    c.header("Cache-Control", "no-store");
    const viewer = await viewerOf(c),
      raw = await mallOf(c.var.runtime).detail(viewer, c.req.valid("param").dramaId);
    return ok(
      c,
      cropMerchantView<DramaDetail>(
        viewer.role,
        {
          owner: DramaDetailOwnerSchema,
          clerk: DramaDetailClerkSchema,
          guest: DramaDetailGuestSchema,
        },
        raw,
      ),
    );
  }),
];
