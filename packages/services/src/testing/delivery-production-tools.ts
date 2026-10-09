import type { PrismaClient } from "@liyoxi/db";
import { createHash } from "node:crypto";
import { assertNotInTransaction, uuidv7 } from "../kernel/index.js";
import type { Env } from "../kernel/index.js";
import type {
  MediaToolClient,
  MediaWorkspace,
  ProbeReport,
  ProductionMediaTools,
} from "../providers/types.js";
import { failed, ok } from "../providers/types.js";
import type { FakeProviders, FakeStorage } from "./providers/index.js";
import type { Runtime } from "../runtime.js";
import type { AdjustableClock } from "./clock.js";
import { createFactories } from "./data/index.js";

type Video = { bytes: Uint8Array; label: string | null; width: number; height: number };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const jpeg = new Uint8Array([255, 216, 255, 217]);
/** Codec/cloud IO doubles only; callers still execute real claims, checks, refs and subscribers. */
export function createDeliveryProductionTools(providers: Pick<FakeProviders, "storage" | "media">) {
  const paths = new Map<string, Video>(),
    objects = new Map<string, Omit<Video, "bytes">>();
  let failStamp = false;
  const report = (video: Video): ProbeReport => {
    const common = {
      profile: "High",
      pixFmt: "yuv420p",
      bitsPerRawSample: 8,
      width: video.width,
      height: video.height,
      rotation: 0,
      displayWidth: video.width,
      displayHeight: video.height,
      sampleAspectRatio: "1:1",
      rFrameRate: "30/1",
      avgFrameRate: "30/1",
      nbFrames: 1800,
      startTimeMs: 0,
      durationMs: 60_000,
      bitRate: 6_000_000,
      sampleRate: null,
      channels: null,
      attachedPic: false,
    };
    return {
      demuxer: "mov",
      format: {
        formatName: "mov,mp4,m4a",
        majorBrand: "isom",
        durationMs: 60_000,
        sizeBytes: video.bytes.length,
        bitRate: 6_000_000,
        tags: {},
      },
      streams: [
        { ...common, index: 0, codecType: "video", codecName: "h264" },
        {
          ...common,
          index: 1,
          codecType: "audio",
          codecName: "aac",
          profile: null,
          pixFmt: null,
          width: null,
          height: null,
          displayWidth: null,
          displayHeight: null,
          sampleRate: 48_000,
          channels: 2,
        },
      ],
      boxes: ["ftyp", "moov", "mdat"],
      moovBeforeMdat: true,
      aigc: video.label,
    };
  };
  const tool: MediaToolClient = {
    probe: async ({ path }) => {
      assertNotInTransaction("delivery-test-probe");
      const video = paths.get(path);
      return video ? ok(report(video)) : failed("rejected", "missing owned source");
    },
    poster: async ({ outPath, atMs }) => {
      assertNotInTransaction("delivery-test-poster");
      paths.set(outPath, { bytes: jpeg, label: null, width: 720, height: 1280 });
      return ok({ bytes: jpeg, sizeBytes: jpeg.length, width: 720, height: 1280, atMs });
    },
    stampAigc: async ({ path, outPath, aigcJson }) => {
      assertNotInTransaction("delivery-test-stamp");
      if (failStamp) return failed("rejected", "owned stamp failure");
      const original = paths.get(path);
      if (!original) return failed("rejected", "missing owned source");
      const extra = new TextEncoder().encode(aigcJson),
        bytes = new Uint8Array(original.bytes.length + extra.length);
      bytes.set(original.bytes);
      bytes.set(extra, original.bytes.length);
      const stamped = { ...original, bytes, label: aigcJson };
      paths.set(outPath, stamped);
      return ok({
        report: report(stamped),
        inputSizeBytes: original.bytes.length,
        outputSizeBytes: bytes.length,
      });
    },
    watermarkPng: async ({ outPath }) => {
      assertNotInTransaction("delivery-test-watermark");
      paths.set(outPath, { bytes: jpeg, label: null, width: 720, height: 96 });
      return ok({ sizeBytes: jpeg.length, sha256: sha(jpeg), width: 720, height: 96 });
    },
    health: async () => ok({ ffmpeg: "typed codec double", ffprobe: "typed codec double" }),
  };
  const workspace: MediaWorkspace = {
    close: async () => {
      paths.clear();
    },
    run: async (job, signal, action) => {
      assertNotInTransaction("delivery-test-workspace");
      const prefix = `${job.id}/${job.attemptNo}/`;
      try {
        return await action({
          path: (name) => `${prefix}${name}`,
          download: async (input) => {
            const object = providers.storage.objects.get(`${input.bucket}/${input.key}`);
            if (signal.aborted) return failed("unavailable", "canceled");
            if (!object || object.etag !== input.etag || object.body.length !== input.size)
              return failed("rejected", "source changed");
            paths.set(`${prefix}source.mp4`, {
              bytes: object.body,
              ...(objects.get(`${input.bucket}/${input.key}`) ?? {
                label: null,
                width: 1080,
                height: 1920,
              }),
            });
            return ok({ size: object.body.length, sha256: sha(object.body) });
          },
          publish: async (input) => {
            const output = paths.get(`${prefix}${input.name}`);
            if (signal.aborted) return failed("unavailable", "canceled");
            if (
              !output ||
              (input.expectedSize !== undefined && output.bytes.length !== input.expectedSize) ||
              (input.expectedSha256 !== undefined && sha(output.bytes) !== input.expectedSha256)
            )
              return failed("rejected", "owned output mismatch");
            const etag = providers.storage.put(
              input.dst,
              output.bytes,
              input.name === "poster.jpg"
                ? "image/jpeg"
                : input.name === "watermark.png"
                  ? "image/png"
                  : "video/mp4",
            );
            objects.set(`${input.dst.bucket}/${input.dst.key}`, {
              label: output.label,
              width: output.width,
              height: output.height,
            });
            return ok({ size: output.bytes.length, sha256: sha(output.bytes), etag });
          },
        });
      } finally {
        for (const path of paths.keys()) if (path.startsWith(prefix)) paths.delete(path);
      }
    },
  };
  const transcode = providers.media.transcode;
  providers.media.transcode = async (input) => {
    assertNotInTransaction("delivery-test-cloud");
    const source = providers.storage.objects.get(`${input.src.bucket}/${input.src.key}`);
    if (!source) return failed("rejected", "missing source");
    providers.storage.put(input.dst, source.body, "video/mp4");
    objects.set(`${input.dst.bucket}/${input.dst.key}`, {
      ...(objects.get(`${input.src.bucket}/${input.src.key}`) ?? { label: null }),
      width: 720,
      height: 1280,
    });
    return transcode(input);
  };
  let closed = false;
  const tools: ProductionMediaTools = {
    client: tool,
    workspace,
    async close() {
      if (closed) return;
      closed = true;
      providers.media.transcode = transcode;
      await workspace.close();
      objects.clear();
    },
  };
  const env: NonNullable<Env["MEDIA_PRODUCTION"]> = {
    workDir: "/tmp/lyx-delivery-codec-double",
    socketPath: "/tmp/lyx-delivery-codec-double.sock",
    aigc: {
      Label: "1",
      ContentProducer: "TEST-SYSTEM",
      ReservedCode1: "",
      ContentPropagator: "",
      ReservedCode2: "",
    },
    templates: {
      normalize: "normalize",
      sample: "sample",
      sd: "sd",
      hd: "hd",
      brand: "brand",
      ai: "ai",
    },
  };
  return {
    tools,
    env,
    tool,
    workspace,
    failStamp: (value: boolean) => {
      failStamp = value;
    },
  };
}
export type DeliveryProductionTools = ReturnType<typeof createDeliveryProductionTools>;

/** Drives the registered production subscriber, using only the actual emitted checked event. */
export async function finishDeliveryProductionForTest(
  runtime: Runtime,
  clock: AdjustableClock,
  fileId: string,
  watermark = false,
) {
  const jobId = await runtime.tx.run((tx) => runtime.media.enqueueProbe(tx, fileId));
  await runtime.media.jobs.run({ jobId });
  const event = await runtime.tx.run((tx) =>
    tx.outboxEvent.findFirstOrThrow({
      where: { eventType: "media.production.checked", aggregateId: fileId },
      orderBy: { id: "desc" },
    }),
  );
  const subscriber = runtime.assembly.subscriber("delivery.onProductionChecked");
  if (!subscriber) throw new TypeError("Delivery production subscriber is absent");
  await runtime.tx.run((tx) =>
    subscriber.handle(tx, {
      id: event.id,
      type: event.eventType,
      payload: event.payload as Record<string, unknown>,
    }),
  );
  if (watermark) {
    const job = await runtime.tx.run((tx) =>
      tx.mediaJob.findFirstOrThrow({
        where: { subjectId: fileId, kind: "watermark_sample" },
      }),
    );
    await runtime.media.jobs.run({ jobId: job.id });
    clock.advance(5000);
    await runtime.media.jobs.run({ jobId: job.id });
  }
}
/** Master input fixture; its technical facts are produced by the real probe handler too. */
export async function prepareDeliveryMasterForTest(
  runtime: Runtime,
  prisma: PrismaClient,
  input: { dramaId: string; episodeNo: number; staffId: string },
) {
  const now = runtime.clock.now();
  const old = await prisma.dramaEpisodeMaster.findFirst({
    where: { dramaId: input.dramaId, episodeNo: input.episodeNo, isCurrent: true },
  });
  if (old) return old;
  const bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
  const file = await createFactories({ db: prisma, clock: runtime.clock }).fileObject({
    category: "drama_master",
    bucket: "media",
    ext: "mp4",
    mime: "video/mp4",
    declaredMime: "video/mp4",
    sizeBytes: bytes.length,
    declaredSize: bytes.length,
  });
  const etag = (runtime.providers.storage as FakeStorage).put(
    { bucket: "media", key: file.objectKey },
    bytes,
    "video/mp4",
  );
  await prisma.fileObject.update({ where: { id: file.id }, data: { etag } });
  const jobId = await runtime.tx.run((tx) => runtime.media.enqueueProbe(tx, file.id));
  await runtime.media.jobs.run({ jobId });
  return runtime.tx.run(async (tx) => {
    const master = await tx.dramaEpisodeMaster.create({
      data: {
        id: uuidv7(),
        dramaId: input.dramaId,
        episodeNo: input.episodeNo,
        revNo: 1,
        fileId: file.id,
        state: "ready",
        isCurrent: true,
        durationMs: 60_000,
        createdByStaffId: input.staffId,
        activatedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await runtime.media.link(tx, {
      fileId: file.id,
      entityId: null,
      storeId: null,
      refType: "drama_episode_master",
      refId: master.id,
      role: "main",
    });
    return master;
  });
}
