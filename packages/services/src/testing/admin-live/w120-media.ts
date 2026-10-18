import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createRuntime } from "../../runtime.js";
import type { Runtime } from "../../runtime.js";
import { uuidv7 } from "../../kernel/index.js";
import type { MediaActor } from "../../media/index.js";
import {
  assertDeliveryLiveEnvironment,
  assertDeliveryScope,
  DeliveryLiveScopeSchema,
} from "./delivery-known-media.js";
const scopeSchema = DeliveryLiveScopeSchema.extend({ dramaId: z.uuid() });
export const W120PendingSchema = z.strictObject({
  stage: z.literal("awaiting_actual_media"),
  runId: z.string().regex(/^[0-9a-f]{16}$/),
  items: z
    .array(
      z.strictObject({
        scope: scopeSchema,
        name: z.string(),
        title: z.string(),
        outcome: z.enum(["pass", "reject"]),
        merchantUserId: z.uuid(),
        memberId: z.uuid(),
        headers: z.strictObject({ authorization: z.string(), "X-Store-Id": z.uuid() }),
      }),
    )
    .length(2)
    .refine(
      (items) =>
        new Set(items.map((p) => p.outcome)).size === 2 &&
        new Set(items.map((p) => p.scope.itemId)).size === 2 &&
        new Set(items.map((p) => p.scope.storeId)).size === 2,
    ),
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function guard(ok: unknown): asserts ok {
  if (!ok) throw new Error("W120 本轮媒体事实或归属不一致");
}
/** Borrow the one live Runtime; no private Runtime, metadata write or ready-state bridge. */
export async function createW120Media(
  runtime: Runtime,
  video: { path: string; sha256: string; size: number },
  input: z.infer<typeof W120PendingSchema>,
  signal?: AbortSignal,
) {
  const actual = assertDeliveryLiveEnvironment(runtime.env),
    path = await realpath(video.path);
  guard(
    input.runId === actual.runId &&
      path.includes(`/admin-live-${actual.runId}/`) &&
      path.endsWith("/video.mp4"),
  );
  const bytes = await readFile(path);
  guard(
    bytes.length === video.size &&
      bytes.length <= 200 * 1024 * 1024 &&
      digest(bytes) === video.sha256,
  );
  for (const pending of input.items) {
    const { dramaId, ...scope } = pending.scope;
    assertDeliveryScope(runtime.env, scope);
    await runtime.tx.run(async (tx) => {
      const item = await tx.orderItem.findUniqueOrThrow({
        where: { id: scope.itemId },
        include: { dramaOrder: true, drama: true, deliveryTicket: true },
      });
      const member = await tx.entityMember.findUniqueOrThrow({ where: { id: pending.memberId } });
      guard(
        item.dramaId === dramaId &&
          item.drama.title === pending.title &&
          item.dramaOrderId === scope.orderId &&
          item.dramaOrder.entityId === scope.entityId &&
          item.dramaOrder.storeId === scope.storeId &&
          item.dramaOrder.placedByUserId === pending.merchantUserId &&
          item.deliveryTicket?.id === scope.ticketId &&
          member.entityId === scope.entityId &&
          member.merchantUserId === pending.merchantUserId &&
          member.role === "owner" &&
          member.status === "active" &&
          pending.headers["X-Store-Id"] === scope.storeId,
      );
    });
  }
  const owned = new Map<string, { itemId: string; storeId: string; token: string }>();
  async function file(fileId: string) {
    const scope = owned.get(fileId);
    guard(scope);
    return runtime.tx.run(async (tx) => {
      const f = await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } });
      const r = await tx.productionRecord.findUniqueOrThrow({ where: { fileId } });
      guard(
        f.clientToken === scope.token &&
          f.storeId === scope.storeId &&
          f.uploadClient === "admin" &&
          r.orderItemId === scope.itemId &&
          r.source === "manual_upload" &&
          r.derivedFromFileId === null,
      );
      return f;
    });
  }
  async function downloadFacts(fileId: string, watermarked = false) {
    await file(fileId);
    return runtime.tx.run(async (tx) => {
      const facts = await runtime.media.deliveryProductionFacts(tx, fileId);
      guard(facts.ready && (!watermarked || facts.playable));
      const renditions = facts.playable?.renditions as { fileId?: string }[] | null;
      const id = watermarked ? renditions?.[0]?.fileId : fileId;
      guard(id);
      const output = await tx.fileObject.findUniqueOrThrow({ where: { id } });
      guard(
        output.sha256 &&
          output.sizeBytes &&
          output.status === "stored" &&
          (!watermarked ||
            (output.category === "sample_wm" && id !== fileId && output.sha256 !== video.sha256)),
      );
      return { id, sha256: output.sha256, size: Number(output.sizeBytes) };
    });
  }
  async function finish(fileId: string, watermarked = false) {
    await file(fileId);
    const subscriber = runtime.assembly.subscriber("delivery.onProductionChecked");
    guard(subscriber);
    const deadline = performance.now() + 60_000;
    let previous = "",
      nextReportAt = 0;
    const report = async (force = false) => {
      const tick = performance.now();
      if (!force && !signal?.aborted && tick < nextReportAt) return;
      nextReportAt = tick + 1000;
      const snapshot = await runtime.tx.run(async (tx) => {
        const now = runtime.clock.now();
        const jobs = await tx.mediaJob.findMany({
          where: {
            subjectType: "file_object",
            subjectId: fileId,
            kind: { in: ["probe", "watermark_sample"] },
          },
          take: 8,
          orderBy: { id: "asc" },
          select: {
            kind: true,
            state: true,
            mode: true,
            provider: true,
            attemptNo: true,
            errorCode: true,
            nextRunAt: true,
            deadlineAt: true,
          },
        });
        const check = await tx.mediaCheck.findUnique({ where: { fileId }, select: { gate: true } });
        const record = await tx.productionRecord.findUnique({
          where: { fileId },
          select: { pipelineState: true, aigcState: true },
        });
        const asset = await tx.playableAsset.findFirst({
          where: { sourceFileId: fileId, kind: "sample" },
          select: { state: true },
        });
        const facts = await runtime.media.deliveryProductionFacts(tx, fileId);
        return {
          jobs: jobs.map(({ nextRunAt, deadlineAt, errorCode, ...job }) => ({
            ...job,
            due: nextRunAt <= now,
            unexpired: deadlineAt > now,
            errorCode: errorCode && /^[A-Z0-9_]{1,100}$/.test(errorCode) ? errorCode : null,
          })),
          gate: check?.gate ?? null,
          record,
          asset: asset?.state ?? null,
          valid: facts.valid,
          ready: facts.ready,
          playable: !!facts.playable,
        };
      });
      const signature = JSON.stringify(snapshot);
      if (signature !== previous)
        runtime.logger.info(
          { evt: "w120.production.state", watermarked, ...snapshot },
          "本轮实际制作状态",
        );
      previous = signature;
    };
    do {
      await report();
      signal?.throwIfAborted();
      const jobs = await runtime.tx.run((tx) =>
        tx.mediaJob.findMany({
          where: {
            subjectType: "file_object",
            subjectId: fileId,
            kind: { in: ["probe", "watermark_sample"] },
            state: { in: ["queued", "submitted"] },
            nextRunAt: { lte: runtime.clock.now() },
            deadlineAt: { gt: runtime.clock.now() },
          },
          take: 8,
          orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
          select: { id: true },
        }),
      );
      for (const job of jobs) await runtime.media.jobs.run({ jobId: job.id });
      if (jobs.length) await report(true);
      signal?.throwIfAborted();
      await runtime.tx.run(async (tx) => {
        const events = await tx.outboxEvent.findMany({
          where: {
            eventType: "media.production.checked",
            aggregateType: "production_record",
            aggregateId: fileId,
          },
          orderBy: { seq: "asc" },
          take: 8,
        });
        for (const event of events)
          await subscriber.handle(tx, {
            id: event.id,
            type: event.eventType,
            payload: event.payload as Readonly<Record<string, unknown>>,
          });
      });
      const facts = await runtime.tx.run((tx) => runtime.media.deliveryProductionFacts(tx, fileId));
      if (facts.ready && (!watermarked || facts.playable)) {
        await report(true);
        return;
      }
      const terminal = await runtime.tx.run((tx) =>
        tx.mediaJob.count({
          where: {
            subjectId: fileId,
            kind: { in: ["probe", "watermark_sample"] },
            state: { in: ["failed", "canceled"] },
          },
        }),
      );
      guard(terminal === 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (performance.now() < deadline);
    throw new Error("W120 真实制作未在原60秒边界完成");
  }
  return {
    runId: actual.runId,
    ids: () => [...owned.keys()],
    finish,
    downloadFacts,
    async upload(
      actor: MediaActor,
      storeId: string,
      itemId: string,
      category: "sample_video" | "final_episode",
      episodeNo: number,
    ) {
      signal?.throwIfAborted();
      guard(
        input.items.some(
          (p) =>
            p.scope.itemId === itemId &&
            p.scope.storeId === storeId &&
            p.scope.uploaderId === actor.identity.actor.id,
        ),
      );
      const token = `w120_${actual.runId}_${uuidv7().slice(-12)}`;
      const result = await runtime.media.register(actor, {
        category,
        storeId,
        production: {
          kind: category === "sample_video" ? "sample" : "final",
          orderItemId: itemId,
          episodeNo,
          aiUsage: { used: false, tools: [] },
        },
        files: [
          {
            fileName: `W120_第${episodeNo}集.mp4`,
            sizeBytes: String(bytes.length),
            clientToken: token,
          },
        ],
      });
      const entry = result.items[0];
      guard(result.items.length === 1 && entry?.post && entry.clientToken === token);
      const url = new URL(entry.post.url);
      guard(
        url.origin === "http://127.0.0.1:9100" &&
          url.pathname === "/lyx-local-media" &&
          entry.post.fields.key === entry.key &&
          entry.key.startsWith(`incoming/${entry.fileId}/`),
      );
      owned.set(entry.fileId, { itemId, storeId, token });
      const form = new FormData();
      for (const [key, value] of Object.entries(entry.post.fields)) form.append(key, value);
      form.append("file", new Blob([bytes], { type: "video/mp4" }), `W120_第${episodeNo}集.mp4`);
      guard((await fetch(url, { method: "POST", body: form, signal })).ok);
      signal?.throwIfAborted();
      await runtime.media.completeAdmin(actor, entry.fileId);
      runtime.logger.info({ evt: "w120.upload.stage", stage: "promoting" }, "本轮真实上传阶段");
      const job = await runtime.tx.run((tx) =>
        tx.mediaJob.findUniqueOrThrow({ where: { dedupeKey: `promote:${entry.fileId}` } }),
      );
      guard(job.kind === "promote" && job.subjectId === entry.fileId && job.state === "queued");
      await runtime.media.promote({ jobId: job.id });
      signal?.throwIfAborted();
      const stored = await file(entry.fileId);
      guard(stored.status === "stored" && stored.sizeBytes === BigInt(bytes.length));
      runtime.logger.info({ evt: "w120.upload.stage", stage: "stored" }, "本轮真实上传阶段");
      return entry.fileId;
    },
    cleanup: async () => {
      if (owned.size) await cleanupObjects(runtime, actual.runId, [...owned.keys()]);
    },
  };
}

/** Only exact run tokens, their real probe covers and succeeded sample-watermark outputs. */
async function cleanupObjects(runtime: Runtime, runId: string, ids: string[]) {
  const refs = await runtime.tx.run(async (tx) => {
    const result: { bucket: "media" | "asset"; key: string }[] = [];
    for (const id of ids) {
      const f = await tx.fileObject.findUniqueOrThrow({ where: { id } });
      const record = await tx.productionRecord.findUniqueOrThrow({ where: { fileId: id } });
      const item = record.orderItemId
        ? await tx.orderItem.findUniqueOrThrow({ where: { id: record.orderItemId } })
        : null;
      guard(
        item &&
          f.clientToken?.startsWith(`w120_${runId}_`) &&
          f.scopeType === "store" &&
          f.entityId === item.entityId &&
          f.storeId === item.storeId &&
          f.uploadActorType === "staff" &&
          f.uploadActorId === record.uploadedByStaffId &&
          f.uploadClient === "admin" &&
          f.bucket === "media" &&
          f.incomingBucket === "media" &&
          ["sample_video", "final_episode"].includes(f.category) &&
          record.source === "manual_upload",
      );
      const token = f.objectKey.split("/").at(-1);
      guard(
        token &&
          /^[0-9a-f-]{36}\.mp4$/.test(token) &&
          f.objectKey === `${f.category}/${f.storeId}/${token}`,
      );
      result.push(
        { bucket: "media", key: f.objectKey },
        { bucket: "media", key: `incoming/${id}/${token}` },
      );
      const info = await tx.mediaInfo.findUnique({ where: { fileId: id } });
      if (info?.coverFileId) {
        const cover = await tx.fileObject.findUniqueOrThrow({ where: { id: info.coverFileId } });
        guard(
          cover.bucket === "asset" &&
            cover.category === "video_cover" &&
            cover.objectKey === `covers/${cover.id}.jpg` &&
            cover.storeId === f.storeId &&
            cover.entityId === f.entityId,
        );
        result.push({ bucket: "asset", key: cover.objectKey });
      }
      const assets = await tx.playableAsset.findMany({
        where: { kind: "sample", sourceFileId: id, ownerType: "order_item", ownerId: item.id },
        take: 2,
      });
      for (const asset of assets) {
        const job = await tx.mediaJob.findUniqueOrThrow({
          where: { dedupeKey: `watermark_sample:${asset.id}:v${asset.specVersion}` },
        });
        if (job.state !== "succeeded") continue;
        const output = z.strictObject({ fileId: z.uuid() }).loose().parse(job.output);
        const target = await tx.fileObject.findUniqueOrThrow({ where: { id: output.fileId } });
        guard(
          target.category === "sample_wm" &&
            target.bucket === "media" &&
            target.entityId === f.entityId &&
            target.storeId === f.storeId &&
            target.objectKey === `sample/${asset.id}/${target.id}.mp4`,
        );
        result.push({ bucket: "media", key: target.objectKey });
      }
    }
    return result;
  });
  for (const ref of refs) guard((await runtime.providers.storage.delete(ref)).ok);
}
async function cleanupRun(runId: string, ids: string[]) {
  guard(
    /^[a-f0-9]{16}$/.test(runId) &&
      ids.length === 2 &&
      new Set(ids).size === 2 &&
      ids.every((id) => z.uuid().safeParse(id).success),
  );
  const runtime = createRuntime({
    entry: "api",
    version: "w120-local-cleanup",
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      DATABASE_URL: `postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/lyx_test_admin_live_${runId}?options=-c%20role%3Dlyx_app`,
      REDIS_URL: "redis://127.0.0.1:6389/0",
    },
    redisKeyPrefix: `lyx:test:admin_live_${runId}:`,
  });
  try {
    assertDeliveryLiveEnvironment(runtime.env);
    await cleanupObjects(runtime, runId, ids);
  } finally {
    await runtime.close();
  }
}
if (
  import.meta.url.endsWith("/w120-media.ts") &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [mode, runId, ...ids] = process.argv.slice(2);
  guard(mode === "--cleanup-run" && runId);
  await cleanupRun(runId, ids);
}
