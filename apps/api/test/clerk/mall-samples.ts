import { runSeed, seedDemoContent } from "@liyoxi/services";
import { createFactories } from "@liyoxi/services/testing";
import type { TestApi } from "../../src/testing/index.js";
import type { SignedInMerchant } from "../../src/testing/merchant.js";
type ClerkSampleContext = { clerk: SignedInMerchant; storeId: string };
const prepared = new WeakMap<TestApi, Promise<string>>();
function prepare(api: TestApi) {
  let ready = prepared.get(api);
  if (!ready) {
    ready = (async () => {
      await runSeed({ tx: api.runtime.tx, clock: api.clock });
      const staff = await api.runtime.tx.run((tx) =>
        createFactories({ db: tx, clock: api.clock }).staff({ staffRoleKey: "content_ops" }),
      );
      await seedDemoContent(
        {
          tx: api.runtime.tx,
          clock: api.clock,
          content: api.runtime.content,
          media: api.runtime.media,
          appEnv: "test",
        },
        staff.id,
      );
      await api.runtime.config.cache.bump("dict");
      await api.runtime.config.cache.bump("site");
      return api.runtime.tx.run(
        async (tx) =>
          (await tx.drama.findFirstOrThrow({ where: { status: "listed" }, orderBy: { id: "asc" } }))
            .id,
      );
    })();
    prepared.set(api, ready);
  }
  return ready;
}
export const mallClerkSamples = [
  {
    operationId: "m.home.get",
    play: async (api: TestApi, ctx: ClerkSampleContext) => {
      await prepare(api);
      return api.request("/api/v1/m/home", { headers: ctx.clerk.withStore(ctx.storeId) });
    },
  },
  {
    operationId: "m.mallConfig.get",
    play: async (api: TestApi, ctx: ClerkSampleContext) => {
      await prepare(api);
      return api.request("/api/v1/m/mall-config", { headers: ctx.clerk.withStore(ctx.storeId) });
    },
  },
  {
    operationId: "m.drama.list",
    play: async (api: TestApi, ctx: ClerkSampleContext) => {
      await prepare(api);
      return api.request("/api/v1/m/dramas", { headers: ctx.clerk.withStore(ctx.storeId) });
    },
  },
  {
    operationId: "m.drama.get",
    play: async (api: TestApi, ctx: ClerkSampleContext) => {
      const id = await prepare(api);
      return api.request(`/api/v1/m/dramas/${id}`, { headers: ctx.clerk.withStore(ctx.storeId) });
    },
  },
];
