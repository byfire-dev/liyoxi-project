import type { PrismaClient } from "@liyoxi/db";
import { uuidv7 } from "../kernel/index.js";
import type { Runtime } from "../runtime.js";
import type { AdStaffActor } from "../ad/index.js";
import type { AdjustableClock } from "./clock.js";
import { createFactories } from "./data/index.js";
import type { FakeProviders } from "./providers/index.js";
import type { createDeliveryProductionTools } from "./delivery-production-tools.js";
import { ok } from "../providers/types.js";
/** Only the upstream pending upload is a historical fixture; all storage and production success is real. */
export async function prepareAdVideoForTest(
  h: {
    runtime: Runtime;
    clock: AdjustableClock;
    providers: FakeProviders;
    adCodec?: ReturnType<typeof createDeliveryProductionTools>;
  },
  db: PrismaClient,
  adId: string,
  actor: AdStaffActor,
) {
  if (!h.adCodec) throw new Error("广告视频夹具须启用withAdProduction");
  const ad = await db.ad.findUniqueOrThrow({ where: { id: adId } }),
    make = createFactories({ db, clock: h.clock }),
    id = uuidv7(),
    key = `incoming/${id}/ad.mp4`,
    bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  await make.fileObject({
    id,
    category: "ad_video",
    bucket: "media",
    scopeType: "store",
    entityId: ad.entityId,
    storeId: ad.storeId,
    uploadActorType: "staff",
    uploadActorId: actor.staff.staff.id,
    uploadClient: "admin",
    status: "pending",
    uploadMode: "post",
    incomingBucket: "media",
    incomingKey: key,
    declaredSize: bytes.length,
    declaredMime: "video/mp4",
    ext: "mp4",
    originalName: "ad.mp4",
    sizeBytes: null,
    mime: null,
    etag: null,
    sha256: null,
    storedAt: null,
    uploadExpiresAt: new Date(h.clock.now().getTime() + 600_000),
  });
  h.providers.storage.put({ bucket: "media", key }, bytes, "video/mp4");
  await h.runtime.media.completeAdmin({ identity: actor.ctx, staff: actor.staff }, id);
  const promote = await db.mediaJob.findUniqueOrThrow({ where: { dedupeKey: `promote:${id}` } });
  await h.runtime.media.jobs.run({ jobId: promote.id });
  await h.runtime.tx.run((tx) =>
    h.runtime.media.prepareAdProduction(tx, {
      fileId: id,
      adId,
      entityId: ad.entityId,
      storeId: ad.storeId,
      uploadedByStaffId: actor.staff.staff.id,
      aiUsage: { used: false, tools: [] },
    }),
  );
  const probe = await db.mediaJob.findFirstOrThrow({
      where: { kind: "probe", subjectId: id },
      orderBy: { createdAt: "desc" },
    }),
    original = h.adCodec.tool.probe;
  h.adCodec.tool.probe = async (input) => {
    const value = await original(input);
    if (!value.ok) return value;
    const durationMs = ad.durationSec * 1000;
    return ok({
      ...value.value,
      format: { ...value.value.format, durationMs },
      streams: value.value.streams.map((s) => ({
        ...s,
        durationMs,
        nbFrames: s.codecType === "video" ? (durationMs * 30) / 1000 : s.nbFrames,
      })),
    });
  };
  try {
    await h.runtime.media.jobs.run({ jobId: probe.id });
  } finally {
    h.adCodec.tool.probe = original;
  }
  const result = await h.runtime.tx.run((tx) => h.runtime.media.adProductionFacts(tx, id));
  if (!result.ready) throw new Error(`真实广告probe未就绪:${result.gate}`);
  return { fileId: id, durationMs: ad.durationSec * 1000, width: 1080, height: 1920, segments: [] };
}
