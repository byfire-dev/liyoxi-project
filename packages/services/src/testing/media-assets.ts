import type { PrismaClient } from "@liyoxi/db";
import { createIdentityContext, createTxRunner, uuidv7 } from "../kernel/index.js";
import { standingOf } from "../authz/index.js";
import { createEvents } from "../events/index.js";
import { createTimers } from "../timers/index.js";
import { createMedia } from "../media/index.js";
import type { MediaActor } from "../media/index.js";
import {
  createMediaAssembly,
  createMediaAssetsAssembly,
  createRuntimeMediaAssets,
} from "../ops/index.js";
import { assembleForTest } from "./assembly.js";
import { createClock } from "./clock.js";
import { createFactories } from "./data/factories/index.js";
import { sampleStaffContext } from "./approval.js";
import { createFakeProviders } from "./providers/index.js";

/** Real domain assembly and owner facts, with only external provider IO replaced. */
export async function createMediaAssetsHarness(prisma: PrismaClient) {
  const clock = createClock(new Date("2026-10-10T04:00:00Z"));
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const make = createFactories({ db: prisma, clock });
  const fake = createFakeProviders({ clock });
  const mediaScope = createMediaAssembly(assembleForTest({ entry: "api" }));
  const assetsScope = createMediaAssetsAssembly(mediaScope.assembly);
  const assembly = assetsScope.assembly;
  const events = createEvents({ assembly, tx, clock });
  const timers = createTimers({ assembly });
  const assets = createRuntimeMediaAssets({ assembly, clock, timers, providers: fake });
  let permitControlledModel = false;
  // This fixture-only decision exercises model lifecycle guards; no production daily/global
  // budget is implied. Actual API/runtime composition keeps the absent-budget fallback.
  const media = createMedia({
    assembly,
    clock,
    tx,
    events,
    storage: fake.storage,
    moderation: fake.media,
    assets: { ...assets, allowModelCall: async () => permitControlledModel },
    channel: {
      enqueue: async (queue, _messageId, payload) => {
        if (queue !== "media_job" || typeof payload.jobId !== "string") return;
        const job = await prisma.mediaJob.findUniqueOrThrow({ where: { id: payload.jobId } });
        if (job.kind === "promote") await media.promote({ jobId: job.id });
      },
    },
  });
  mediaScope.attach(media.jobs);
  assetsScope.attach(media);
  const merchant = await make.merchant({ verified: true });
  const staff = await make.staff({ staffRoleKey: "super_admin" });
  const owner: MediaActor = {
    identity: createIdentityContext({
      actor: { type: "merchant", id: merchant.user.id, client: "weapp", role: "owner" },
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
    }),
    merchant: {
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      standing: standingOf("owner", "active"),
    },
  };
  const admin: MediaActor = {
    identity: createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
    staff: await sampleStaffContext(prisma, staff.id, { stepUpAt: clock.now() }),
  };
  async function stored(
    actor = owner,
    category: "store_asset" | "portrait_auth" = "store_asset",
    body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ) {
    const registered = (
      await media.register(actor, {
        category,
        ...(actor.staff ? { storeId: merchant.store.id, onBehalfStore: true } : {}),
        files: [
          { fileName: "asset.png", sizeBytes: String(body.byteLength), clientToken: uuidv7() },
        ],
      })
    ).items[0]!;
    const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: registered.fileId } });
    fake.storage.put(
      { bucket: file.bucket as "asset" | "secure", key: registered.key },
      body,
      "image/png",
    );
    await media.complete(actor, file.id);
    const job = await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${file.id}` },
    });
    await media.promote({ jobId: job.id });
    return prisma.fileObject.findUniqueOrThrow({ where: { id: file.id } });
  }
  async function drain(assetId: string) {
    for (let step = 0; step < 24; step++) {
      const files = await prisma.storeAssetFile.findMany({
        where: { storeAssetId: assetId },
        select: { fileId: true },
      });
      const jobs = await prisma.mediaJob.findMany({
        where: {
          OR: [
            { parentType: "store_asset", parentId: assetId },
            {
              parentId: null,
              subjectType: "file_object",
              subjectId: { in: files.map((row) => row.fileId) },
            },
          ],
          state: { in: ["queued", "submitted"] },
          nextRunAt: { lte: clock.now() },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      for (const job of jobs) await media.jobs.run({ jobId: job.id });
      const asset = await prisma.storeAsset.findUniqueOrThrow({ where: { id: assetId } });
      if (asset.processingState === "processed") return asset;
      if (!jobs.length) throw new Error("asset fixture has no due owned job");
      clock.advance(5_000);
    }
    throw new Error("asset fixture exceeded bounded job steps");
  }
  return {
    prisma,
    tx,
    clock,
    make,
    fake,
    assembly,
    media,
    assets,
    events,
    timers,
    merchant,
    staff,
    owner,
    admin,
    stored,
    drain,
    permitControlledModel: (value: boolean) => {
      permitControlledModel = value;
    },
    close: async () => {
      try {
        await media.jobs.shutdown();
      } finally {
        assetsScope.close();
        mediaScope.close();
      }
    },
  };
}
