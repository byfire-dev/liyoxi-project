import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "./runtime.js";
import { createIdentityContext, loadEnv, uuidv7 } from "./kernel/index.js";
import { createMall } from "./workbench/index.js";
import {
  createClock,
  createFactories,
  createFakeProviders,
  sampleStaffContext,
  useSeededDatabase,
  useTestRedis,
} from "./testing/index.js";

const handle = useSeededDatabase("services"),
  redis = useTestRedis();
const roots: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await root.close();
});

async function fixture() {
  const db = await handle.prisma(),
    clock = createClock(),
    providers = createFakeProviders({ clock });
  const runtime = createRuntime({
    entry: "api",
    env: loadEnv({
      APP_ENV: "test",
      DATABASE_URL: await handle.url(),
      REDIS_URL: process.env.REDIS_URL,
    }),
    version: "fictional-moderation",
    clock,
    providers,
    redisKeyPrefix: redis.prefix,
  });
  roots.push(runtime);
  const make = createFactories({ db, clock }),
    staff = await make.staff({ staffRoleKey: "super_admin" });
  const actor = {
    staff: await sampleStaffContext(db, staff.id),
    identity: createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
  };
  async function banner(enabled: boolean) {
    const id = uuidv7(),
      key = `test/${id}.png`,
      bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    providers.storage.put({ bucket: "pub", key }, bytes, "image/png");
    // Explicit stored/pass rows are input facts for the public configuration guard,
    // not evidence of image decoding or a genuine upstream moderation verdict.
    const file = await make.fileObject({
      id,
      category: "banner",
      ext: "png",
      bucket: "pub",
      objectKey: key,
      scopeType: "platform",
      entityId: null,
      storeId: null,
      uploadActorType: "staff",
      uploadActorId: staff.id,
      uploadClient: "admin",
      moderationState: "pass",
      declaredSize: bytes.length,
      sizeBytes: bytes.length,
      mime: "image/png",
      declaredMime: "image/png",
    });
    const item = await runtime.siteAdmin.banners.create(actor, {
      title: "虚构审核横幅",
      imageFileId: file.id,
      jumpKind: "none",
      jumpTarget: null,
      startAt: new Date(clock.now().getTime() - 1000).toISOString(),
      isEnabled: enabled,
    });
    return { file, item };
  }
  return { db, runtime, providers, actor, banner, clock };
}

describe("public Banner moderation guards", () => {
  it("enabling the unchanged image rechecks block in the write TX and rolls back", async () => {
    const h = await fixture(),
      { file, item } = await h.banner(false);
    await h.db.fileObject.update({ where: { id: file.id }, data: { moderationState: "block" } });
    const refs = await h.db.fileRef.findMany({
      where: { fileId: file.id, refId: item.homeBannerId },
    });
    await expect(
      h.runtime.siteAdmin.banners.update(h.actor, item.homeBannerId, {
        lockVersion: item.lockVersion,
        isEnabled: true,
      }),
    ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
    expect(
      await h.db.homeBanner.findUniqueOrThrow({ where: { id: item.homeBannerId } }),
    ).toMatchObject({ isEnabled: false, imageFileId: file.id, lockVersion: item.lockVersion });
    expect(
      await h.db.fileRef.findMany({ where: { fileId: file.id, refId: item.homeBannerId } }),
    ).toEqual(refs);
  });
  it("a current block hides a cached public Banner without changing the configured row", async () => {
    const h = await fixture(),
      { file, item } = await h.banner(true);
    const mall = createMall({
      tx: h.runtime.tx,
      clock: h.clock,
      content: h.runtime.content,
      config: h.runtime.config,
      media: h.runtime.media,
      homeNotice: h.runtime.siteAdmin.homeNotice,
    });
    const viewer = { role: "guest" as const, entityId: null, storeId: null };
    expect((await mall.home(viewer)).banners.map((row) => row.homeBannerId)).toContain(
      item.homeBannerId,
    );
    const version = await h.runtime.config.cache.version("site");
    await h.db.fileObject.update({ where: { id: file.id }, data: { moderationState: "block" } });
    expect((await mall.home(viewer)).banners.map((row) => row.homeBannerId)).not.toContain(
      item.homeBannerId,
    );
    expect(await h.runtime.config.cache.version("site")).toBe(version);
    expect(
      await h.db.homeBanner.findUniqueOrThrow({ where: { id: item.homeBannerId } }),
    ).toHaveProperty("isEnabled", true);
  });
});
