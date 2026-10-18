import {
  EVENT_PAYLOAD_SCHEMAS,
  StoreAssetCreateBodySchema,
  AdminStoreAssetCreateBodySchema,
  AdminStoreAssetReviewBodySchema,
  AdminStoreAssetConfirmPortraitBodySchema,
  AdminStoreAssetDeleteBodySchema,
  AdminStoreAssetReprocessBodySchema,
  PortraitAuthBodySchema,
  AssetFeedbackBodySchema,
} from "@liyoxi/contract";
import type { StoreAsset } from "@liyoxi/db";
import type { Prisma } from "@liyoxi/db";
import { dayRange, calendarDate } from "@liyoxi/shared/time";
import { paramsAt } from "../../config/index.js";
import { workHoursAt } from "../../sla/index.js";
import { record } from "../../audit/index.js";
import type { AuditEntry } from "../../audit/index.js";
import { AppError, uuidv7, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { MediaActor } from "../context.js";
import { link, release } from "../refs.js";
import {
  assetActor,
  assetOf,
  assetStore,
  assetFiles,
  assetDict,
  lockAssetFiles,
  rebuildAssetSearch,
} from "./repo.js";
import { assetView, attachAssetUrls } from "./views.js";
import { advanceAsset } from "./pipeline.js";
import type { AssetDeps } from "./context.js";
import type { AssetWriteOptions } from "./types.js";
import { assetTimerKey } from "./types.js";
import { createSigner } from "../read.js";

export function parseAssetInput<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError("VALIDATION_FAILED");
  return result.data;
}
export async function assetAudit(
  tx: Tx,
  actor: MediaActor,
  asset: Pick<StoreAsset, "id" | "entityId" | "storeId">,
  action: string,
  reason?: string,
  change?: { before: object | null; after: object | null; fields: string[] },
) {
  const entry: AuditEntry = {
    stream: "activity",
    category: action === "review" || action === "confirm_portrait" ? "review" : "profile_edit",
    action: `media.asset.${action}`,
    target: { type: "store_asset", id: asset.id },
    summary: `门店素材：${action}`,
    entityId: asset.entityId,
    storeId: asset.storeId,
    ...(reason ? { reason: { code: action, text: reason } } : {}),
  };
  await record(
    tx,
    actor.identity.actor,
    actor.audit ?? {
      requestId: actor.identity.requestId,
      ip: null,
      userAgent: null,
      authMethod: null,
      sessionId: null,
    },
    change ? { ...entry, ...change } : entry,
  );
}
async function emitReviewed(tx: Tx, deps: AssetDeps, actor: MediaActor, asset: StoreAsset) {
  await deps.events.emit(tx, actor.identity, {
    type: "asset.reviewed",
    aggregate: { type: "store_asset", id: asset.id },
    entityId: asset.entityId,
    storeId: asset.storeId,
    payload: EVENT_PAYLOAD_SCHEMAS["asset.reviewed"].parse({
      v: 1,
      storeAssetId: asset.id,
      storeId: asset.storeId,
      usability: asset.usability,
      uploadActorType: asset.uploadActorType,
      ...(asset.uploadActorType === "merchant" ? { uploaderUserId: asset.uploadActorId } : {}),
    }),
    dedupeKey: `asset.reviewed:${asset.id}:v${asset.lockVersion}`,
  });
}
async function suppliedFiles(
  tx: Tx,
  actor: MediaActor,
  asset: { storeId: string; entityId: string },
  ids: readonly string[],
  category: "store_asset" | "portrait_auth",
) {
  if (new Set(ids).size !== ids.length)
    throw new AppError("FILE_NOT_USABLE", { details: { fileIds: [...ids], reason: "duplicate" } });
  const rows = await tx.fileObject.findMany({
    where: { id: { in: [...ids] } },
    include: { mediaInfo: true },
  });
  for (const id of ids) {
    const file = rows.find((row) => row.id === id);
    if (
      !file ||
      file.category !== category ||
      file.status !== "stored" ||
      file.moderationState === "block" ||
      file.scopeType !== "store" ||
      file.entityId !== asset.entityId ||
      file.storeId !== asset.storeId ||
      file.uploadActorType !== actor.identity.actor.type ||
      file.uploadActorId !== actor.identity.actor.id ||
      (actor.staff && (file.uploadClient !== "admin" || file.onBehalfStoreId !== asset.storeId))
    )
      throw new AppError("FILE_NOT_USABLE", {
        details: {
          fileIds: [id],
          reason:
            !file || file.status !== "stored"
              ? "not_stored"
              : file.moderationState === "block"
                ? "blocked"
                : file.category !== category
                  ? "category_mismatch"
                  : "scope_mismatch",
        },
      });
  }
  return ids.map((id) => rows.find((row) => row.id === id)!);
}
function checkFileTypes(type: string, files: Awaited<ReturnType<typeof suppliedFiles>>) {
  const allowed: Record<string, readonly string[]> = {
    image: ["jpg", "jpeg", "png"],
    video: ["mp4", "mov"],
    recording: ["m4a", "mp3", "wav", "aac"],
    audio: ["m4a", "mp3", "wav", "aac"],
    document: ["pdf", "docx", "txt"],
    text: [],
  };
  const wrong = files.filter((file) => !allowed[type]?.includes(file.ext));
  if (wrong.length)
    throw new AppError("FILE_NOT_USABLE", {
      details: { fileIds: wrong.map((file) => file.id), reason: "ext_mismatch" },
    });
  if (
    type === "recording" &&
    (files.length !== 1 || files.some((file) => (file.mediaInfo?.durationMs ?? 0) > 300000))
  )
    throw new AppError("VALIDATION_FAILED");
}
const dateValue = (value?: string) => (value ? new Date(`${value}T00:00:00Z`) : null);

export function createAssetWrites(deps: AssetDeps) {
  const signer = createSigner(deps);
  const decorate = <T extends { storeAssetId: string; thumbnail: unknown }>(
    actor: MediaActor,
    value: T,
    options: AssetWriteOptions,
  ) =>
    attachAssetUrls(
      deps,
      actor,
      value,
      async (input) => (await signer(input)).signed,
      options.idem?.replayed,
    );
  return {
    async create(actor: MediaActor, value: unknown, options: AssetWriteOptions = {}) {
      const input = parseAssetInput(
        actor.staff ? AdminStoreAssetCreateBodySchema : StoreAssetCreateBodySchema,
        value,
      );
      assetActor(actor, "upload", deps.clock.now());
      const storeId = "storeId" in input ? String(input.storeId) : actor.merchant!.storeId;
      const raw = await deps.tx.run(async (tx) => {
        await lockRows(tx, "store", [storeId]);
        const store = await assetStore(tx, deps, actor, storeId, true),
          now = deps.clock.now();
        const key = options.idem?.key ?? uuidv7();
        const old = await tx.storeAsset.findUnique({
          where: { storeId_idempotencyKey: { storeId, idempotencyKey: key } },
        });
        if (old) throw new AppError("IDEMPOTENCY_KEY_REUSED");
        if (
          input.assetDemandId &&
          !(await tx.storeAssetDemand.findFirst({ where: { id: input.assetDemandId, storeId } }))
        )
          throw new AppError("VALIDATION_FAILED");
        await assetDict(tx, input.contentTagCodes ?? [], "content");
        const values = await paramsAt(tx, ["sla.review.store_asset"], now);
        const due = await deps.assets.sla.dueAt(tx, {
          policy: "review.store_asset",
          ...values["sla.review.store_asset"],
          from: now,
          workHours: await workHoursAt(tx, now),
        });
        const asset = await tx.storeAsset.create({
          data: {
            id: uuidv7(),
            entityId: store.entityId,
            storeId,
            type: input.type,
            textBody: input.textBody ?? null,
            note: input.note ?? null,
            uploadActorType: actor.identity.actor.type,
            uploadActorId: actor.identity.actor.id!,
            uploadClient: actor.identity.actor.client!,
            uploadActorRole:
              actor.identity.actor.type === "merchant" ? actor.identity.actor.role : null,
            storeAssetDemandId: input.assetDemandId ?? null,
            processingState: "pending",
            reviewState: "unreviewed",
            moderationState: "none",
            dueAt: due.dueAt,
            slaSnapshot: due.snapshot as unknown as Prisma.InputJsonValue,
            idempotencyKey: key,
            createdAt: now,
            updatedAt: now,
          },
        });
        await lockRows(tx, "store_asset", [asset.id]);
        await lockAssetFiles(tx, input.fileIds ?? []);
        const files = await suppliedFiles(tx, actor, asset, input.fileIds ?? [], "store_asset");
        checkFileTypes(input.type, files);
        for (const [index, file] of files.entries()) {
          await tx.storeAssetFile.create({
            data: { storeAssetId: asset.id, fileId: file.id, position: index + 1, createdAt: now },
          });
          await link(deps, tx, {
            fileId: file.id,
            refType: "store_asset",
            refId: asset.id,
            role: "main",
            entityId: asset.entityId,
            storeId,
          });
        }
        for (const code of input.contentTagCodes ?? [])
          await tx.storeAssetTag.create({
            data: {
              id: uuidv7(),
              storeAssetId: asset.id,
              dimension: "content",
              tagCode: code,
              source: "uploader",
              createdAt: now,
              updatedAt: now,
            },
          });
        await deps.assets.timers.arm(tx, {
          kind: "sla.breach",
          key: assetTimerKey(asset.id),
          subject: { type: "store_asset", id: asset.id },
          fireAt: due.dueAt,
          payload: { dueAt: due.dueAt.toISOString() },
          entityId: asset.entityId,
          storeId,
        });
        await rebuildAssetSearch(tx, deps, asset);
        await advanceAsset(tx, deps, asset.id);
        await deps.assets.recordUpload(tx, actor, {
          assetId: asset.id,
          storeId,
          entityId: asset.entityId,
          type: asset.type,
          fileCount: files.length,
          hasDemand: !!input.assetDemandId,
        });
        await assetAudit(tx, actor, asset, "create");
        return assetView(tx, deps, actor, await assetOf(tx, actor, asset.id), false);
      }, options);
      const response = await decorate(actor, raw, options);
      return actor.staff ? response : { ...response, replayed: options.idem?.replayed ?? false };
    },
    async review(actor: MediaActor, id: string, value: unknown, options: AssetWriteOptions = {}) {
      const input = parseAssetInput(AdminStoreAssetReviewBodySchema, value);
      assetActor(actor, "review", deps.clock.now());
      const raw = await deps.tx.run(async (tx) => {
        const asset = await assetOf(tx, actor, id, true),
          now = deps.clock.now();
        if (asset.lockVersion !== input.lockVersion)
          throw new AppError("VERSION_CONFLICT", { details: { lockVersion: asset.lockVersion } });
        if (asset.processingState !== "processed") throw new AppError("ASSET_NOT_PROCESSED");
        if (asset.moderationState === "block") throw new AppError("STATE_NOT_ALLOWED");
        if (
          asset.adoptedCount > 0 &&
          ["need_reshoot", "need_portrait_auth"].includes(input.usability)
        )
          throw new AppError("ASSET_ALREADY_ADOPTED");
        await assetDict(tx, input.contentTagCodes, "content");
        await assetDict(tx, input.usageTagCodes, "usage");
        const time = (await assetDict(tx, [input.timeliness.tagCode], "timeliness"))[0]!;
        // The reviewed dictionary owns only ext.dimension; paired interval validity is in the contract.
        void time;
        await tx.storeAssetTag.deleteMany({ where: { storeAssetId: id, source: "reviewer" } });
        const tags = [
          ...input.contentTagCodes.map((tagCode) => ({ dimension: "content", tagCode })),
          ...input.usageTagCodes.map((tagCode) => ({ dimension: "usage", tagCode })),
          { dimension: "timeliness", tagCode: input.timeliness.tagCode },
        ];
        for (const tag of tags)
          await tx.storeAssetTag.create({
            data: {
              id: uuidv7(),
              storeAssetId: id,
              ...tag,
              source: "reviewer",
              isConfirmed: true,
              validStartDate:
                tag.dimension === "timeliness" ? dateValue(input.timeliness.validStartDate) : null,
              validEndDate:
                tag.dimension === "timeliness" ? dateValue(input.timeliness.validEndDate) : null,
              createdAt: now,
              updatedAt: now,
            },
          });
        const updated = await tx.storeAsset.update({
          where: { id },
          data: {
            title: input.title,
            usability: input.usability,
            reviewState: "reviewed",
            reviewedAt: now,
            reviewedByStaffId: actor.staff!.staff.id,
            lockVersion: { increment: 1 },
            ...(input.usability === "need_portrait_auth" ? { portraitAuthorizedAt: null } : {}),
            updatedAt: now,
          },
        });
        if (asset.reviewState === "unreviewed")
          await deps.assets.timers.cancel(tx, {
            subject: { type: "store_asset", id },
            kinds: ["sla.breach"],
          });
        await rebuildAssetSearch(tx, deps, updated);
        await assetAudit(tx, actor, asset, "review", undefined, {
          before: asset,
          after: updated,
          fields: ["title", "usability", "reviewState", "lockVersion"],
        });
        await emitReviewed(tx, deps, actor, updated);
        return assetView(tx, deps, actor, updated, true);
      }, options);
      return decorate(actor, raw, options);
    },
    async confirmPortrait(
      actor: MediaActor,
      id: string,
      value: unknown,
      options: AssetWriteOptions = {},
    ) {
      const input = parseAssetInput(AdminStoreAssetConfirmPortraitBodySchema, value);
      assetActor(actor, "review", deps.clock.now());
      const raw = await deps.tx.run(async (tx) => {
        const asset = await assetOf(tx, actor, id, true);
        if (asset.lockVersion !== input.lockVersion)
          throw new AppError("VERSION_CONFLICT", { details: { lockVersion: asset.lockVersion } });
        if (
          asset.processingState !== "processed" ||
          asset.moderationState === "block" ||
          asset.usability !== "need_portrait_auth" ||
          !asset.portraitAuthFileIds.length
        )
          throw new AppError("STATE_NOT_ALLOWED");
        await lockAssetFiles(tx, asset.portraitAuthFileIds);
        const rows = await tx.fileObject.findMany({
          where: {
            id: { in: asset.portraitAuthFileIds },
            status: "stored",
            category: "portrait_auth",
            entityId: asset.entityId,
            moderationState: { not: "block" },
          },
        });
        if (rows.length !== asset.portraitAuthFileIds.length) throw new AppError("FILE_NOT_USABLE");
        const updated = await tx.storeAsset.update({
          where: { id },
          data: {
            portraitAuthorizedAt: deps.clock.now(),
            usability: input.usability,
            reviewedByStaffId: actor.staff!.staff.id,
            reviewedAt: deps.clock.now(),
            lockVersion: { increment: 1 },
            updatedAt: deps.clock.now(),
          },
        });
        await assetAudit(tx, actor, asset, "confirm_portrait", input.note);
        await emitReviewed(tx, deps, actor, updated);
        return assetView(tx, deps, actor, updated, true);
      }, options);
      return decorate(actor, raw, options);
    },
    async portrait(actor: MediaActor, id: string, value: unknown, options: AssetWriteOptions = {}) {
      const input = parseAssetInput(PortraitAuthBodySchema, value);
      assetActor(actor, "upload", deps.clock.now());
      const raw = await deps.tx.run(async (tx) => {
        const asset = await assetOf(tx, actor, id, true),
          now = deps.clock.now();
        if (asset.usability !== "need_portrait_auth") throw new AppError("STATE_NOT_ALLOWED");
        if (
          !actor.staff &&
          actor.identity.actor.type === "merchant" &&
          actor.identity.actor.role !== "owner" &&
          actor.identity.actor.id !== asset.uploadActorId
        )
          throw new AppError("PERMISSION_DENIED");
        const merged = [...new Set([...asset.portraitAuthFileIds, ...input.fileIds])];
        if (merged.length > 20) throw new AppError("VALIDATION_FAILED");
        await lockAssetFiles(tx, input.fileIds);
        await suppliedFiles(tx, actor, asset, input.fileIds, "portrait_auth");
        for (const fileId of input.fileIds)
          await link(deps, tx, {
            fileId,
            refType: "store_asset",
            refId: id,
            role: "portrait_auth",
            entityId: asset.entityId,
            storeId: asset.storeId,
          });
        const updated = await tx.storeAsset.update({
          where: { id },
          data: { portraitAuthFileIds: merged, updatedAt: now },
        });
        await assetAudit(tx, actor, asset, "portrait_append");
        return assetView(tx, deps, actor, updated, true);
      }, options);
      const response = await decorate(actor, raw, options);
      return actor.staff ? response : { ...response, replayed: options.idem?.replayed ?? false };
    },
    async remove(actor: MediaActor, id: string, value: unknown, options: AssetWriteOptions = {}) {
      const input = parseAssetInput(AdminStoreAssetDeleteBodySchema, value);
      assetActor(actor, "review", deps.clock.now());
      return deps.tx.run(async (tx) => {
        const asset = await assetOf(tx, actor, id, true),
          now = deps.clock.now(),
          files = await assetFiles(tx, id);
        await lockAssetFiles(tx, [...files.map((row) => row.fileId), ...asset.portraitAuthFileIds]);
        await tx.storeAsset.update({ where: { id }, data: { deletedAt: now, updatedAt: now } });
        for (const row of files)
          await release(deps, tx, {
            fileId: row.fileId,
            refType: "store_asset",
            refId: id,
            role: "main",
            entityId: asset.entityId,
            storeId: asset.storeId,
            keepUntil: new Date(now.getTime() + 7 * 86400000),
          });
        const portraitKeepUntil = new Date(now);
        if (asset.adoptedCount > 0)
          portraitKeepUntil.setUTCFullYear(portraitKeepUntil.getUTCFullYear() + 3);
        else portraitKeepUntil.setUTCDate(portraitKeepUntil.getUTCDate() + 7);
        for (const fileId of asset.portraitAuthFileIds)
          await release(deps, tx, {
            fileId,
            refType: "store_asset",
            refId: id,
            role: "portrait_auth",
            entityId: asset.entityId,
            storeId: asset.storeId,
            keepUntil: portraitKeepUntil,
          });
        await deps.assets.timers.cancel(tx, {
          subject: { type: "store_asset", id },
          kinds: ["sla.breach"],
        });
        await assetAudit(tx, actor, asset, "delete", input.reasonText);
        return null;
      }, options);
    },
    async reprocess(
      actor: MediaActor,
      id: string,
      value: unknown,
      options: AssetWriteOptions = {},
    ) {
      const input = parseAssetInput(AdminStoreAssetReprocessBodySchema, value);
      assetActor(actor, "review", deps.clock.now());
      const raw = await deps.tx.run(async (tx) => {
        const asset = await assetOf(tx, actor, id, true);
        if (asset.processingState !== "processed" || asset.moderationState === "block")
          throw new AppError("STATE_NOT_ALLOWED");
        await tx.storeAsset.update({
          where: { id },
          data: {
            processingState: "pending",
            isInsightPartial: false,
            updatedAt: deps.clock.now(),
          },
        });
        await advanceAsset(tx, deps, id, { runId: uuidv7(), selected: input.kinds ?? [] });
        await assetAudit(tx, actor, asset, "reprocess");
        return assetView(tx, deps, actor, await assetOf(tx, actor, id), false);
      }, options);
      return decorate(actor, raw, options);
    },
    async feedback(actor: MediaActor, id: string, value: unknown, options: AssetWriteOptions = {}) {
      const input = parseAssetInput(AssetFeedbackBodySchema, value);
      assetActor(actor, "feedback", deps.clock.now());
      return deps.tx.run(async (tx) => {
        const asset = await assetOf(tx, actor, id, true);
        const caller = actor.identity.actor;
        if (caller.type !== "merchant" || (caller.role !== "owner" && caller.role !== "clerk"))
          throw new AppError("ROLE_FORBIDDEN");
        const range = dayRange(calendarDate(deps.clock.now()));
        const count = await tx.auditLog.count({
          where: {
            targetType: "store_asset",
            targetId: id,
            action: "media.asset.feedback",
            actorId: caller.id,
            createdAt: { gte: range.start, lt: range.end },
          },
        });
        if (count >= 5) throw new AppError("ASSET_FEEDBACK_DAILY_LIMIT");
        await assetAudit(tx, actor, asset, "feedback", input.content);
        await deps.events.emit(tx, actor.identity, {
          type: "asset.feedback_submitted",
          aggregate: { type: "store_asset", id },
          entityId: asset.entityId,
          storeId: asset.storeId,
          payload: {
            v: 1,
            storeAssetId: id,
            entityId: asset.entityId,
            storeId: asset.storeId,
            actorRole: caller.role,
          },
          dedupeKey: `asset.feedback:${id}:${options.idem?.key ?? uuidv7()}`,
        });
        return null;
      }, options);
    },
  };
}
