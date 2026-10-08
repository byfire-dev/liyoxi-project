import { runSeed, SEED_MODULES, uuidv7 } from "@liyoxi/services";
import { createNotifyMessageFixture } from "@liyoxi/services/testing";
import type { TestApi } from "../../src/testing/index.js";
import type { SignedInMerchant } from "../../src/testing/merchant.js";
type ClerkSampleContext = { clerk: SignedInMerchant; storeId: string };

const prepared = new WeakMap<TestApi, Promise<string>>();
function prepare(api: TestApi, ctx: ClerkSampleContext): Promise<string> {
  let pending = prepared.get(api);
  if (!pending) {
    pending = (async () => {
      await runSeed({
        tx: api.runtime.tx,
        clock: api.clock,
        modules: SEED_MODULES.filter((seed) => seed.module === "notify"),
      });
      return api.runtime.tx.run(async (tx) => {
        const store = await tx.store.findUniqueOrThrow({ where: { id: ctx.storeId } });
        const message = await createNotifyMessageFixture(tx, api.clock, {
          merchantUserId: ctx.clerk.merchantUserId,
          entityId: store.entityId,
          storeId: ctx.storeId,
          category: "service",
          link: { route: "store.members", params: { storeId: ctx.storeId } },
        });
        return message.id;
      });
    })();
    prepared.set(api, pending);
  }
  return pending;
}
export const messageClerkSamples = [
  ...(
    [
      ["m.message.list", "/m/messages"],
      ["m.message.summary", "/m/messages/summary"],
      ["m.notifySetting.list", "/m/notify-settings"],
    ] as const
  ).map(([operationId, path]) => ({
    operationId,
    play: async (api: TestApi, ctx: ClerkSampleContext) => {
      await prepare(api, ctx);
      return api.request(`/api/v1${path}`, { headers: ctx.clerk.withStore(ctx.storeId) });
    },
  })),
  {
    operationId: "m.message.read",
    play: async (api: TestApi, ctx: ClerkSampleContext) => {
      const id = await prepare(api, ctx);
      return api.request(`/api/v1/m/messages/${id}/read`, {
        method: "POST",
        headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
      });
    },
  },
  {
    operationId: "m.message.batchRead",
    play: async (api: TestApi, ctx: ClerkSampleContext) => {
      const id = await prepare(api, ctx);
      return api.request("/api/v1/m/messages/read", {
        method: "POST",
        json: { upToMessageId: id },
        headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
      });
    },
  },
];
