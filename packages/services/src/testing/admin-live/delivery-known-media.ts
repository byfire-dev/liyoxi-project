// W1-19 PR2 本域测试窄桥：只后置本轮真实已上传文件的已知事实，不替代业务 QC 或媒体探测。
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Runtime } from "../../runtime.js";
import type { Env, Tx } from "../../kernel/index.js";
import { lockRows } from "../../kernel/index.js";

const uuid = z.string().uuid();
export const DeliveryLiveScopeSchema = z.strictObject({
  runId: z.string().regex(/^[0-9a-f]{16}$/),
  name: z.string(),
  prefix: z.string(),
  startedAt: z.iso.datetime(),
  entityId: uuid,
  storeId: uuid,
  orderId: uuid,
  itemId: uuid,
  ticketId: uuid,
  uploaderId: uuid,
  managerId: uuid,
});
export type DeliveryLiveScope = z.infer<typeof DeliveryLiveScopeSchema>;
export const ArtifactSchema = z.enum(["sample", "unknown_sample", "final_1", "final_2"]);
export type DeliveryArtifact = z.infer<typeof ArtifactSchema>;
export const KNOWN_VIDEO = {
  bytes: 17947,
  md5: "34c29d311e15d7237c9c0f5ee3c8e720",
  sha256: "ec2241dc139935e36df522d7eb246e16cf335685e933e4c7b44b09295ab46693",
  durationMs: 1000,
  width: 160,
  height: 90,
} as const;
function fail(): never {
  throw new Error("W119B 本轮文件归属或已知事实不一致");
}
export function assertDeliveryLiveEnvironment(
  env: Pick<Env, "APP_ENV" | "DATABASE_URL" | "REDIS_URL">,
) {
  if (env.APP_ENV !== "test") fail();
  const database = new URL(env.DATABASE_URL),
    redis = new URL(env.REDIS_URL);
  const name = decodeURIComponent(database.pathname.slice(1)),
    runId = /^lyx_test_admin_live_([0-9a-f]{16})$/.exec(name)?.[1];
  if (
    !runId ||
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !["localhost", "127.0.0.1"].includes(database.hostname) ||
    database.port !== "5442" ||
    database.username !== "liyoxi" ||
    database.password !== "lyx-local-dev" ||
    [...database.searchParams.keys()].some((k) => k !== "options") ||
    database.searchParams.getAll("options").length !== 1 ||
    database.searchParams.get("options") !== "-c role=lyx_app" ||
    redis.protocol !== "redis:" ||
    !["localhost", "127.0.0.1"].includes(redis.hostname) ||
    redis.port !== "6389" ||
    redis.pathname !== "/0" ||
    redis.username ||
    redis.password ||
    redis.search ||
    redis.hash ||
    database.hash
  )
    fail();
  return { runId, name, prefix: `lyx:test:admin_live_${runId}:` };
}
export function assertDeliveryScope(env: Env, raw: unknown): DeliveryLiveScope {
  const scope = DeliveryLiveScopeSchema.parse(raw),
    current = assertDeliveryLiveEnvironment(env);
  if (
    scope.runId !== current.runId ||
    scope.name !== current.name ||
    scope.prefix !== current.prefix
  )
    fail();
  return scope;
}
export async function knownVideoBytes() {
  const bytes = await readFile(new URL("./w119-known.mp4", import.meta.url));
  if (
    bytes.length !== KNOWN_VIDEO.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== KNOWN_VIDEO.sha256
  )
    fail();
  return bytes;
}
export interface KnownMediaInput {
  scope: DeliveryLiveScope;
  fileId: string;
  clientToken: string;
  artifact: DeliveryArtifact;
}
async function ownedFile(tx: Tx, runtime: Runtime, input: KnownMediaInput, cleanup = false) {
  const { scope, fileId, clientToken, artifact } = input;
  assertDeliveryScope(runtime.env, scope);
  if (!uuid.safeParse(fileId).success || !/^[A-Za-z0-9_-]{1,64}$/.test(clientToken)) fail();
  await lockRows(tx, "staff", [scope.uploaderId, scope.managerId].sort());
  await lockRows(tx, "entity", [scope.entityId]);
  await lockRows(tx, "store", [scope.storeId]);
  await lockRows(tx, "drama_order", [scope.orderId]);
  await lockRows(tx, "order_item", [scope.itemId]);
  await lockRows(tx, "delivery_ticket", [scope.ticketId]);
  await lockRows(tx, "production_record", [fileId]);
  const jobs = await tx.mediaJob.findMany({ where: { subjectId: fileId, kind: "promote" } });
  if (jobs.length > 1) fail();
  if (jobs[0]) await lockRows(tx, "media_job", [jobs[0].id]);
  await lockRows(tx, "file_object", [fileId]);
  const file = await tx.fileObject.findUnique({ where: { id: fileId } });
  const record = await tx.productionRecord.findUnique({ where: { fileId } });
  const ticket = await tx.deliveryTicket.findUnique({ where: { id: scope.ticketId } });
  const item = await tx.orderItem.findUnique({ where: { id: scope.itemId } });
  const order = await tx.dramaOrder.findUnique({ where: { id: scope.orderId } });
  const store = await tx.store.findUnique({ where: { id: scope.storeId } });
  const drama = item ? await tx.drama.findUnique({ where: { id: item.dramaId } }) : null;
  const uploader = await tx.staff.findUnique({ where: { id: scope.uploaderId } });
  const manager = await tx.staff.findUnique({ where: { id: scope.managerId } });
  const episode = artifact.startsWith("final_") ? Number(artifact.slice(-1)) : 1;
  const kind = artifact.startsWith("final_") ? "final" : "sample";
  const category = kind === "final" ? "final_episode" : "sample_video";
  if (
    !file ||
    !record ||
    !ticket ||
    !item ||
    !order ||
    !store ||
    !drama ||
    !uploader ||
    !manager ||
    uploader.staffRoleKey !== "super_admin" ||
    uploader.status !== "active" ||
    manager.name !== "演练交付" ||
    manager.staffRoleKey !== "delivery_manager" ||
    manager.status !== "active" ||
    store.name !== `制作演练-${scope.runId}` ||
    store.entityId !== scope.entityId ||
    order.storeId !== scope.storeId ||
    order.entityId !== scope.entityId ||
    item.dramaOrderId !== order.id ||
    item.entityId !== scope.entityId ||
    item.storeId !== scope.storeId ||
    item.episodeCount !== 2 ||
    ticket.orderItemId !== item.id ||
    ticket.dramaOrderId !== order.id ||
    ticket.entityId !== scope.entityId ||
    ticket.storeId !== scope.storeId ||
    drama.title !== `制作演练短剧-${scope.runId}` ||
    drama.isAiGenerated ||
    file.uploadActorType !== "staff" ||
    file.uploadActorId !== uploader.id ||
    file.uploadClient !== "admin" ||
    file.scopeType !== "store" ||
    file.entityId !== scope.entityId ||
    file.storeId !== scope.storeId ||
    file.onBehalfStoreId !== null ||
    file.category !== category ||
    file.bucket !== "media" ||
    file.incomingBucket !== "media" ||
    file.uploadMode !== "post" ||
    file.uploadBatchId !== null ||
    file.clientToken !== clientToken ||
    file.originalName !== `${scope.runId}-${artifact}.mp4` ||
    file.ext !== "mp4" ||
    file.declaredMime !== "video/mp4" ||
    file.declaredSize !== BigInt(KNOWN_VIDEO.bytes) ||
    file.createdAt < new Date(scope.startedAt) ||
    file.createdAt > runtime.clock.now() ||
    file.moderationState !== "none" ||
    record.kind !== kind ||
    record.orderItemId !== item.id ||
    record.episodeNo !== episode ||
    record.variant !== "common" ||
    record.source !== "manual_upload" ||
    record.uploadedByStaffId !== uploader.id ||
    record.aigcState !== "not_required" ||
    (record.aiUsage as { used?: unknown }).used !== false
  )
    fail();
  const objectToken = file.objectKey.split("/").at(-1)!;
  if (
    !/^[0-9a-f-]{36}\.mp4$/.test(objectToken) ||
    file.objectKey !== `${category}/${scope.storeId}/${objectToken}` ||
    (file.incomingKey !== null && file.incomingKey !== `incoming/${fileId}/${objectToken}`)
  )
    fail();
  const job = jobs[0];
  if (
    job &&
    (job.subjectType !== "file_object" ||
      job.dedupeKey !== `promote:${fileId}` ||
      job.provider !== "local" ||
      job.mode !== "local")
  )
    fail();
  if (!cleanup) {
    if (
      !["promoting", "stored"].includes(file.status) ||
      !job ||
      file.incomingEtag?.replaceAll('"', "") !== KNOWN_VIDEO.md5 ||
      (file.status === "stored" &&
        (job.state !== "succeeded" ||
          file.sizeBytes !== BigInt(KNOWN_VIDEO.bytes) ||
          file.etag?.replaceAll('"', "") !== KNOWN_VIDEO.md5))
    )
      fail();
  }
  return { file, job, incomingKey: `incoming/${fileId}/${objectToken}` };
}
export async function prepareDeliveryKnownMedia(runtime: Runtime, input: KnownMediaInput) {
  await knownVideoBytes();
  const before = await runtime.tx.run((tx) => ownedFile(tx, runtime, input));
  if (before.file.status === "promoting") {
    if (before.job?.state !== "queued") fail();
    await runtime.media.promote({ jobId: before.job.id });
  }
  return runtime.tx.run(async (tx) => {
    const { file } = await ownedFile(tx, runtime, input);
    if (file.status !== "stored") fail();
    const existing = await tx.mediaInfo.findUnique({ where: { fileId: file.id } });
    if (input.artifact === "unknown_sample") {
      if (existing) fail();
      return { fileId: file.id, status: "stored", known: false };
    }
    const raw = {
      fixture: "W119B",
      runId: input.scope.runId,
      artifact: input.artifact,
      sha256: KNOWN_VIDEO.sha256,
    };
    const facts = {
      kind: "video",
      container: "mp4",
      durationMs: KNOWN_VIDEO.durationMs,
      width: KNOWN_VIDEO.width,
      height: KNOWN_VIDEO.height,
      rotation: 0,
      displayWidth: KNOWN_VIDEO.width,
      displayHeight: KNOWN_VIDEO.height,
      fpsNum: 25,
      fpsDen: 1,
      vcodec: "h264",
      vprofile: "Constrained Baseline",
      pixFmt: "yuv420p",
      isFaststart: true,
      audioStreamCount: 0,
      probeVersion: 1,
    };
    if (existing) {
      const oldRaw = existing.raw as Record<string, unknown>;
      if (
        Object.entries(facts).some(
          ([key, value]) => existing[key as keyof typeof existing] !== value,
        ) ||
        !oldRaw ||
        Object.keys(oldRaw).length !== 4 ||
        Object.entries(raw).some(([key, value]) => oldRaw[key] !== value)
      )
        fail();
    } else {
      const now = runtime.clock.now();
      await tx.mediaInfo.create({
        data: { fileId: file.id, ...facts, raw, probedAt: now, createdAt: now, updatedAt: now },
      });
    }
    return { fileId: file.id, status: "stored", known: true };
  });
}
export async function cleanupDeliveryFile(runtime: Runtime, input: KnownMediaInput) {
  const owned = await runtime.tx.run((tx) => ownedFile(tx, runtime, input, true));
  for (const key of [owned.incomingKey, owned.file.objectKey]) {
    const result = await runtime.providers.storage.delete({ bucket: "media", key });
    if (!result.ok) throw new Error("W119B 本轮对象清理失败");
  }
  return { cleaned: input.fileId };
}
