// M1 DB/API codec fixture. Native probing and watermark pixels have separate W307 evidence.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createIdempotencyContext } from "../kernel/index.js";
import { loadCliStaffContext } from "../staff/index.js";
import type { ContentDemoDeps } from "../content/index.js";
import type { ProbeReport, StorageProvider, PresignedPost } from "../providers/types.js";
import type { Runtime } from "../runtime.js";
import type { FakeProviders } from "./providers/index.js";
import type { AdjustableClock } from "./clock.js";
import type { M1MediaScope, M1Support } from "./m1-types.js";

const VIDEO_SHA = "55290244d31b267a68d47cfe26e443f527b255d4254c759dd98bd10fd935bbc3";
const REPORT_SHA = "5b21c91d18607c0c0834df19977ffbfa1b12d424ec7b623f6ab073bd606c829f";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function m1ProductionVideo() {
  const [bytes, raw] = await Promise.all([
    readFile(new URL("./m1-production.mp4", import.meta.url)),
    readFile(new URL("./m1-production.probe.json", import.meta.url)),
  ]);
  if (sha(bytes) !== VIDEO_SHA || sha(raw) !== REPORT_SHA || bytes.length > 500 * 1024)
    throw new Error("M1 固定制作输入的字节或实测报告不匹配");
  // Fixed, SHA-bound report from the pinned image's public probe operation; no runtime probing claim.
  const report = (JSON.parse(raw.toString("utf8")) as { report: ProbeReport }).report;
  const video: M1Support["video"] = {
    bytes: new Uint8Array(bytes),
    sha256: VIDEO_SHA,
    sizeBytes: bytes.length,
    durationMs: 20_000,
    width: 720,
    height: 1280,
    videoCodec: "h264",
    hasAudio: true,
  };
  return { video, report };
}

export function createM1ProductionMasterPreparer(
  runtime: Runtime,
  providers: FakeProviders,
  video: M1Support["video"],
  otherDemoMasters: ContentDemoDeps["prepareMasters"],
  external?: {
    readonly storage: StorageProvider;
    upload(post: PresignedPost, bytes: Uint8Array): Promise<number>;
  },
  waitForBatch?: (read: () => Promise<boolean>) => Promise<void>,
): NonNullable<ContentDemoDeps["prepareMasters"]> {
  return async (target) => {
    // The original M1 order explicitly selects the 20-episode demo. Other seed fixtures remain models.
    if (target.totalEpisodes !== 20 && !external) {
      if (!otherDemoMasters) throw new Error("M1 其他演示原片缺实际准备器");
      return otherDemoMasters(target);
    }
    const staff = await runtime.tx.run((tx) => loadCliStaffContext(tx, target.staffId));
    const actor = {
      identity: target.identity,
      staff,
      audit: {
        requestId: target.identity.requestId,
        ip: target.identity.ip,
        userAgent: target.identity.userAgent,
        authMethod: null,
        sessionId: null,
        jobName: "cli.demo_seed",
      },
    };
    const body = {
      purpose: "drama_master",
      targetId: target.dramaId,
      scope: "full",
      replaceReason: null,
      isContentChanged: false,
      note: "M1 固定20秒输入，经真实媒体任务处理；codec外呼为替身",
      files: Array.from({ length: target.totalEpisodes }, (_, index) => ({
        clientToken: `m1-master-${index + 1}`,
        originalName: `第${index + 1}集.mp4`,
        sizeBytes: String(video.sizeBytes),
      })),
    };
    const idem = createIdempotencyContext({
      mode: "required",
      scope: "admin.uploadBatch.create",
      actor: target.identity.actor,
      key: `m1-master:${target.dramaId}:${video.sha256}`,
      request: { method: "POST", body },
    });
    let batch = await runtime.media.uploadBatches.create(actor, body, { idem });
    batch = await runtime.media.uploadBatches.start(actor, batch.uploadBatchId, {});
    for (const item of batch.items) {
      if (!item.uploadKey || !item.uploadKey.startsWith(batch.prefix))
        throw new Error("M1 原片上传目标不属于本批次");
      const signed = await (external?.storage ?? providers.storage).presignPost({
        bucket: "media",
        key: item.uploadKey,
        mime: "video/mp4",
        maxBytes: video.sizeBytes,
        expiresSec: 600,
      });
      if (
        !signed.ok ||
        (await (external?.upload ?? providers.storage.upload)(signed.value, video.bytes)) !== 204
      )
        throw new Error("M1 原片固定字节未被对象替身接受");
      await runtime.media.uploadBatches.complete(actor, item.uploadBatchItemId, {});
    }
    if (waitForBatch) {
      await waitForBatch(async () => {
        batch = await runtime.media.uploadBatches.get(actor, batch.uploadBatchId);
        if (
          batch.items.some((item) => item.state === "rejected") ||
          ["failed", "expired", "canceled"].includes(batch.state)
        )
          throw new Error("M1 原片任务明确失败");
        return batch.state === "ready";
      });
      await runtime.media.uploadBatches.commit(actor, batch.uploadBatchId, {});
      return;
    }
    for (;;) {
      batch = await runtime.media.uploadBatches.get(actor, batch.uploadBatchId);
      if (batch.state === "ready") {
        await runtime.media.uploadBatches.commit(actor, batch.uploadBatchId, {});
        return;
      }
      if (
        batch.items.some((item) => item.state === "rejected") ||
        ["failed", "expired", "canceled"].includes(batch.state)
      )
        throw new Error("M1 原片任务明确失败");
      const jobs = await runtime.tx.run((tx) =>
        tx.mediaJob.findMany({
          where: {
            parentType: "upload_batch",
            parentId: batch.uploadBatchId,
            state: "queued",
            nextRunAt: { lte: runtime.clock.now() },
          },
          select: { id: true },
          orderBy: { id: "asc" },
        }),
      );
      if (!jobs.length) throw new Error("M1 原片尚未就绪且无本批次到期任务");
      for (const job of jobs) await runtime.media.jobs.run({ jobId: job.id });
    }
  };
}

export async function finishM1Production(
  runtime: Runtime,
  providers: FakeProviders,
  clock: AdjustableClock,
  video: M1Support["video"],
  fileId: string,
  scope: M1MediaScope,
  drain: () => Promise<unknown>,
  external?: { readonly storage: StorageProvider; waitUntil(at: Date): Promise<void> },
) {
  const file = await runtime.tx.run(async (tx) => {
    const file = await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } });
    const record = await tx.productionRecord.findUniqueOrThrow({ where: { fileId } });
    const ticket = await tx.deliveryTicket.findUniqueOrThrow({
      where: { id: scope.deliveryTicketId },
    });
    if (
      file.entityId !== scope.entityId ||
      file.storeId !== scope.storeId ||
      file.category !== scope.category ||
      file.uploadActorId !== scope.uploaderId ||
      file.status !== "stored" ||
      record.orderItemId !== scope.orderItemId ||
      record.episodeNo !== scope.episodeNo ||
      ticket.orderItemId !== scope.orderItemId ||
      ticket.dramaOrderId !== scope.orderId
    )
      throw new Error("M1 制作任务不属于本轮交付范围");
    return file;
  });
  const bucket = file.bucket;
  if (bucket !== "secure" && bucket !== "asset" && bucket !== "media" && bucket !== "pub")
    throw new Error("M1 制作输入桶不合法");
  const read = external
    ? await external.storage.readObject({
        bucket,
        key: file.objectKey,
        maxBytes: video.sizeBytes,
        ...(file.etag ? { ifMatchEtag: file.etag } : {}),
      })
    : undefined;
  const object = external
    ? read?.ok
      ? { body: read.value }
      : undefined
    : providers.storage.objects.get(`${file.bucket}/${file.objectKey}`);
  if (!object || object.body.length !== video.sizeBytes || sha(object.body) !== video.sha256)
    throw new Error("M1 制作输入字节不匹配");
  const jobId = await runtime.tx.run((tx) => runtime.media.enqueueProbe(tx, fileId));
  await runtime.media.jobs.run({ jobId });
  await drain();
  if (scope.category === "sample_video") {
    const watermark = await runtime.tx.run((tx) =>
      tx.mediaJob.findFirstOrThrow({
        where: { subjectId: fileId, kind: "watermark_sample" },
      }),
    );
    await runtime.media.jobs.run({ jobId: watermark.id });
    if (external) {
      const submitted = await runtime.tx.run((tx) =>
        tx.mediaJob.findUniqueOrThrow({ where: { id: watermark.id } }),
      );
      await external.waitUntil(submitted.nextRunAt);
    } else clock.advance(5000); // The existing remote job's public five-second poll becomes due.
    await runtime.media.jobs.run({ jobId: watermark.id });
    await drain();
  }
  const facts = await runtime.tx.run((tx) => runtime.media.deliveryProductionFacts(tx, fileId));
  if (!facts.ready) throw new Error("M1 真实制作任务尚未提供完整交付事实");
}
