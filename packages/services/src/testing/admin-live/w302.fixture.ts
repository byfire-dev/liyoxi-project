import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Prisma } from "@liyoxi/db";
import { z } from "zod";
import { DramaSnapshotSchema } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { uuidv7 } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { contextHash } from "../../media/production.js";
import type { Runtime } from "../../runtime.js";
import { createFactories } from "../data/factories/index.js";
import type { AdminLiveFixture, AdminLiveFixtureContext } from "./context.js";
import {
  assertDeliveryLiveEnvironment,
  assertDeliveryScope,
  DeliveryLiveScopeSchema,
} from "./delivery-known-media.js";

/** Order input only; uploaded final files, jobs, checks and ready states use the real workflow. */
export async function createOutputBatchLiveFixture({ runtime, make }: AdminLiveFixtureContext) {
  const scope = assertDeliveryLiveEnvironment(runtime.env);
  const staff = await runtime.tx.run(async (tx) => ({
    uploader: await tx.staff.findFirstOrThrow({
      where: { staffRoleKey: "super_admin", status: "active" },
    }),
    manager: await tx.staff.findFirstOrThrow({
      where: { name: "演练交付", staffRoleKey: "delivery_manager", status: "active" },
    }),
  }));
  const merchant = await make.subscribedMerchant();
  await runtime.tx.run((tx) =>
    tx.store.update({
      where: { id: merchant.store.id },
      data: { name: `批次演练-${scope.runId}` },
    }),
  );
  const drama = await make.drama({
    title: `批次演练二十集-${scope.runId}`,
    totalEpisodes: 20,
    dramaClass: "class_1",
    createdByStaffId: staff.uploader.id,
  });
  for (let episodeNo = 1; episodeNo <= 20; episodeNo++)
    await make.dramaEpisode({ dramaId: drama.id, episodeNo });
  const order = await make.dramaOrder({
    entityId: merchant.entity.id,
    storeId: merchant.store.id,
    placedByUserId: merchant.user.id,
    subscriptionTermId: merchant.term.id,
    status: "producing",
    subStatus: "batch_compose",
    itemCount: 1,
    totalChargePoints: 100,
  });
  const item = await make.orderItem({
    dramaOrderId: order.id,
    dramaId: drama.id,
    phase: "producing",
    episodeCount: 20,
    dramaSnapshot: DramaSnapshotSchema.parse({
      dramaId: drama.id,
      title: drama.title,
      totalEpisodes: 20,
      dramaClass: drama.dramaClass,
      genreCodes: drama.genreCodes,
      permits: [],
      licenseEndDate: addDays(calendarDate(runtime.clock.now()), 365),
      posterFileId: null,
      allowedPlacements: drama.allowedPlacements,
      isAiGenerated: drama.isAiGenerated,
    }),
  });
  const ticket = await make.deliveryTicket({
    orderItemId: item.id,
    step: "batch_compose",
    editorId: staff.uploader.id,
    deliveryManagerId: staff.manager.id,
  });
  return {
    scope: {
      ...scope,
      startedAt: runtime.clock.now().toISOString(),
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      orderId: order.id,
      itemId: item.id,
      ticketId: ticket.id,
      dramaId: drama.id,
      uploaderId: staff.uploader.id,
      managerId: staff.manager.id,
    },
    ticketNo: ticket.ticketNo,
  };
}

const optionalInt = z.number().int().nonnegative().nullable();
/** JSON evidence generated from the actual fixed MP4; not a replacement for final-file probing. */
export const OutputBatchVideoInputSchema = z.strictObject({
  path: z.string().refine(isAbsolute),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z
    .number()
    .int()
    .positive()
    .max(200 * 1024 * 1024),
  probe: z
    .strictObject({
      kind: z.literal("video"),
      container: z.literal("mp4"),
      durationMs: z.number().int().min(20_000).max(1_199_999),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
      displayWidth: z.number().int().min(720),
      displayHeight: z.number().int().positive(),
      fpsNum: z.number().int().positive(),
      fpsDen: z.number().int().positive(),
      vcodec: z.literal("h264"),
      vprofile: z.enum(["High", "Main"]),
      pixFmt: z.literal("yuv420p"),
      acodec: z.literal("aac"),
      audioSampleRate: z.number().int().positive(),
      audioChannels: z.number().int().positive(),
      audioStreamCount: z.literal(1),
      bitrateKbps: optionalInt,
      isFaststart: z.boolean(),
      avDriftMs: optionalInt,
      aigcMeta: z.record(z.string(), z.json()).nullable(),
      probeVersion: z.number().int().positive(),
      raw: z.record(z.string(), z.json()),
    })
    .refine((p) => Math.abs(p.displayWidth / p.displayHeight - 9 / 16) / (9 / 16) <= 0.01),
});
export const OutputBatchLiveInputSchema = z.strictObject({
  current: DeliveryLiveScopeSchema.extend({ dramaId: z.string().uuid() }),
  legacy: DeliveryLiveScopeSchema,
  video: OutputBatchVideoInputSchema,
  resumeVideo: OutputBatchVideoInputSchema,
});
export type OutputBatchLiveInput = z.infer<typeof OutputBatchLiveInputSchema>;

async function inputTargets(runtime: Runtime, input: OutputBatchLiveInput) {
  const actual = assertDeliveryLiveEnvironment(runtime.env);
  const { dramaId, ...currentScope } = input.current;
  for (const scope of [currentScope, input.legacy]) assertDeliveryScope(runtime.env, scope);
  return runtime.tx.run(async (tx) => {
    const rows = [];
    for (const [scope, expected] of [
      [input.current, 20],
      [input.legacy, 2],
    ] as const) {
      const item = await tx.orderItem.findUniqueOrThrow({
        where: { id: scope.itemId },
        select: {
          episodeCount: true,
          dramaId: true,
          dramaOrderId: true,
          dramaOrder: { select: { entityId: true, storeId: true } },
          drama: { select: { totalEpisodes: true, title: true } },
          deliveryTicket: { select: { id: true } },
        },
      });
      const uploader = await tx.staff.findUniqueOrThrow({
        where: { id: scope.uploaderId },
        select: { id: true, status: true },
      });
      if (
        item.episodeCount !== expected ||
        item.drama.totalEpisodes !== expected ||
        item.dramaOrderId !== scope.orderId ||
        item.dramaOrder.entityId !== scope.entityId ||
        item.dramaOrder.storeId !== scope.storeId ||
        item.deliveryTicket?.id !== scope.ticketId ||
        uploader.status !== "active" ||
        scope.runId !== actual.runId ||
        !item.drama.title.endsWith(`-${actual.runId}`)
      )
        throw new Error("W302 input target does not belong to the exact two owned fixtures");
      rows.push({ dramaId: item.dramaId, count: expected, staffId: uploader.id, scope });
    }
    if (rows[0]?.dramaId !== dramaId || rows[0]?.dramaId === rows[1]?.dramaId)
      throw new Error("W302 input dramas are inconsistent");
    return rows;
  });
}

/** Seed only already-existing master inputs. Never writes uploaded final checks/jobs/readiness. */
export async function prepareOutputBatchLiveMasters(runtime: Runtime, raw: unknown) {
  const input = OutputBatchLiveInputSchema.parse(raw),
    targets = await inputTargets(runtime, input);
  const path = await realpath(input.video.path);
  if (!path.includes(`/admin-live-${input.current.runId}/`) || !path.endsWith("/video.mp4"))
    throw new Error("W302 master bytes must be the exact owned temporary video");
  const bytes = await readFile(path);
  if (
    bytes.length !== input.video.size ||
    createHash("sha256").update(bytes).digest("hex") !== input.video.sha256
  )
    throw new Error("W302 master bytes do not match the actual probe evidence");
  const keys: string[] = [];
  const cleanup = async () => {
    for (const key of keys) {
      const result = await runtime.providers.storage.delete({ bucket: "media", key });
      if (!result.ok) throw new Error("W302 input master cleanup failed");
    }
  };
  try {
    for (const target of targets)
      for (let episodeNo = 1; episodeNo <= target.count; episodeNo++) {
        const key = `lyx-test/w302/${input.current.runId}/master/${uuidv7()}.mp4`;
        const stored = await runtime.providers.storage.putObject({
          bucket: "media",
          key,
          body: bytes,
          contentType: "video/mp4",
          ifAbsent: true,
        });
        if (!stored.ok) throw new Error("W302 real master object was not stored");
        keys.push(key);
        if (stored.value.size !== bytes.length)
          throw new Error("W302 stored master size differs from its bytes");
        await runtime.tx.run(async (tx) => {
          if (await tx.dramaEpisodeMaster.count({ where: { dramaId: target.dramaId, episodeNo } }))
            throw new Error("W302 input cannot replace an existing master");
          const now = runtime.clock.now(),
            make = createFactories({ db: tx, clock: runtime.clock });
          const episode = await tx.dramaEpisode.findUnique({
            where: { dramaId_episodeNo: { dramaId: target.dramaId, episodeNo } },
          });
          if (episode)
            await tx.dramaEpisode.update({
              where: { id: episode.id },
              data: { durationMs: input.video.probe.durationMs, updatedAt: now },
            });
          else
            await make.dramaEpisode({
              dramaId: target.dramaId,
              episodeNo,
              durationMs: input.video.probe.durationMs,
            });
          const file = await make.fileObject({
            category: "drama_master",
            bucket: "media",
            scopeType: "platform",
            uploadActorType: "staff",
            uploadActorId: target.staffId,
            uploadClient: "admin",
            objectKey: key,
            ext: "mp4",
            declaredSize: BigInt(bytes.length),
            declaredMime: "video/mp4",
            sizeBytes: BigInt(bytes.length),
            mime: "video/mp4",
            etag: stored.value.etag,
            storedAt: now,
          });
          await tx.mediaInfo.create({
            data: {
              fileId: file.id,
              ...input.video.probe,
              aigcMeta: input.video.probe.aigcMeta ?? Prisma.DbNull,
              probedAt: now,
              createdAt: now,
              updatedAt: now,
            },
          });
          const master = await tx.dramaEpisodeMaster.create({
            data: {
              id: uuidv7(),
              dramaId: target.dramaId,
              episodeNo,
              revNo: 1,
              fileId: file.id,
              state: "ready",
              isCurrent: true,
              durationMs: input.video.probe.durationMs,
              createdByStaffId: target.staffId,
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
        });
      }
    return { cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Only this run's non-unknown manual inputs and their matching derived contexts. */
async function legacyProductionFiles(tx: Tx, input: OutputBatchLiveInput) {
  const scope = input.legacy;
  const rows = await tx.productionRecord.findMany({
    where: { orderItemId: scope.itemId, variant: "common", kind: { in: ["sample", "final"] } },
    include: { file: true },
    take: 100,
  });
  const roots = rows.filter(
    (r) =>
      r.source === "manual_upload" &&
      r.derivedFromFileId === null &&
      r.uploadedByStaffId === scope.uploaderId &&
      r.file.uploadActorType === "staff" &&
      r.file.uploadActorId === scope.uploaderId &&
      r.file.uploadClient === "admin" &&
      r.file.uploadBatchId === null &&
      r.file.entityId === scope.entityId &&
      r.file.storeId === scope.storeId &&
      r.file.createdAt >= new Date(scope.startedAt) &&
      ["sample", "final_1", "final_2"].some(
        (a) => r.file.originalName === `${scope.runId}-${a}.mp4`,
      ),
  );
  return rows.filter(
    (r) =>
      roots.includes(r) ||
      roots.some(
        (source) =>
          r.derivedFromFileId === source.fileId &&
          ["normalized", "restamped"].includes(r.source) &&
          r.file.entityId === source.file.entityId &&
          r.file.storeId === source.file.storeId &&
          r.file.category === source.file.category &&
          contextHash(r) === contextHash(source),
      ),
  );
}
/** Real outbox input, same registered subscriber and business idempotence; no delivery ACK is forged. */
export async function consumeOutputBatchLiveChecked(runtime: Runtime, raw: unknown) {
  const input = OutputBatchLiveInputSchema.parse(raw);
  await inputTargets(runtime, input);
  const subscriber = runtime.assembly.subscriber("delivery.onProductionChecked");
  if (!subscriber) throw new Error("W307 checked subscriber is not registered");
  const ids = await runtime.tx.run(async (tx) => {
    const files = await legacyProductionFiles(tx, input);
    return tx.outboxEvent.findMany({
      where: {
        eventType: "media.production.checked",
        aggregateType: "production_record",
        aggregateId: { in: files.map((f) => f.fileId) },
        entityId: input.legacy.entityId,
        storeId: input.legacy.storeId,
        occurredAt: { gte: new Date(input.legacy.startedAt) },
      },
      orderBy: { seq: "asc" },
      take: 100,
      select: { id: true },
    });
  });
  for (const { id } of ids)
    await runtime.tx.run(async (tx) => {
      const event = await tx.outboxEvent.findUniqueOrThrow({ where: { id } });
      const files = await legacyProductionFiles(tx, input);
      if (!files.some((f) => f.fileId === event.aggregateId)) return;
      await subscriber.handle(tx, {
        id: event.id,
        type: event.eventType,
        payload: event.payload as Readonly<Record<string, unknown>>,
      });
    });
}

/** Own test database, exact two targets; the production runner retains all claim/lease guards. */
export async function findOutputBatchLiveJobIds(runtime: Runtime, raw: unknown) {
  const input = OutputBatchLiveInputSchema.parse(raw);
  await inputTargets(runtime, input);
  return runtime.tx.run(async (tx) => {
    const files = await tx.fileObject.findMany({
      where: {
        uploadBatch: {
          purpose: "final_release",
          targetId: { in: [input.current.itemId, input.legacy.itemId] },
          createdByStaffId: input.current.uploaderId,
          state: { in: ["uploading", "verifying"] },
        },
      },
      select: { id: true },
    });
    const legacy = await legacyProductionFiles(tx, input);
    const jobs = await tx.mediaJob.findMany({
      where: {
        subjectType: "file_object",
        subjectId: { in: [...files.map((f) => f.id), ...legacy.map((f) => f.fileId)] },
        state: { in: ["queued", "running", "submitting", "submitted"] },
        nextRunAt: { lte: runtime.clock.now() },
      },
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      take: 20,
      select: { id: true },
    });
    return jobs.map((j) => j.id);
  });
}

const fixture: AdminLiveFixture = createOutputBatchLiveFixture;
export default fixture;
