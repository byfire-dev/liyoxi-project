import type { PrismaClient } from "@liyoxi/db";
import type { AdStaffActor } from "../ad/index.js";
import { readMaterialFileFacts } from "../media/index.js";
import { uuidv7 } from "../kernel/index.js";
import { ok } from "../providers/types.js";
import type { prepareAdVideoForTest } from "./ad-video.fixture.js";

/** Real admin registration and storage/production writers; no historical pending/ready result. */
export async function prepareAdminAdVideoForTest(
  h: Parameters<typeof prepareAdVideoForTest>[0],
  db: PrismaClient,
  adId: string,
  actor: AdStaffActor,
) {
  if (!h.adCodec) throw new Error("广告视频夹具须启用withAdProduction");
  const ad = await db.ad.findUniqueOrThrow({ where: { id: adId } }),
    bytes = new Uint8Array(1234),
    mediaActor = { identity: actor.ctx, staff: actor.staff };
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
  const registered = await h.runtime.media.register(mediaActor, {
    category: "ad_video",
    storeId: ad.storeId,
    files: [{ fileName: "admin-ad.mp4", sizeBytes: String(bytes.length), clientToken: uuidv7() }],
    production: { kind: "ad", adId, aiUsage: { used: false, tools: [] } },
  });
  const fileId = registered.items[0]!.fileId,
    file = await db.fileObject.findUniqueOrThrow({ where: { id: fileId } });
  h.providers.storage.put({ bucket: "media", key: file.incomingKey! }, bytes, "video/mp4");
  await h.runtime.media.completeAdmin(mediaActor, fileId);
  const promote = await db.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${fileId}` },
  });
  await h.runtime.media.jobs.run({ jobId: promote.id });
  const probe = await db.mediaJob.findFirstOrThrow({ where: { kind: "probe", subjectId: fileId } }),
    original = h.adCodec.tool.probe;
  h.adCodec.tool.probe = async (work) => {
    const result = await original(work);
    if (!result.ok) return result;
    const durationMs = ad.durationSec * 1000;
    return ok({
      ...result.value,
      format: { ...result.value.format, durationMs },
      streams: result.value.streams.map((stream) => ({
        ...stream,
        durationMs,
        nbFrames: stream.codecType === "video" ? (durationMs * 30) / 1000 : stream.nbFrames,
      })),
    });
  };
  try {
    await h.runtime.media.jobs.run({ jobId: probe.id });
  } finally {
    h.adCodec.tool.probe = original;
  }
  const [production, facts] = await h.runtime.tx.run(async (tx) =>
    Promise.all([
      h.runtime.media.adProductionFacts(tx, fileId),
      readMaterialFileFacts(tx, [fileId]),
    ]),
  );
  const info = facts[0]?.mediaInfo;
  if (!production.ready || !production.durationMs || !info?.displayWidth || !info.displayHeight)
    throw new Error("真实广告probe与物理尺寸未就绪");
  return {
    fileId,
    durationMs: production.durationMs,
    width: info.displayWidth,
    height: info.displayHeight,
    segments: [],
  };
}
