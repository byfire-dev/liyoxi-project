import { IdSchema } from "@liyoxi/contract";
import { Prisma } from "@liyoxi/db";
import { z } from "zod";
import { paramsAt } from "../../config/index.js";
import { AppError, lockRows, uuidv7 } from "../../kernel/index.js";
import type { Clock, Tx } from "../../kernel/index.js";
import { lockCalendarImport, workHoursAt } from "../../sla/index.js";
import type { Media } from "../runtime.js";
import type { MediaAssetsDeps } from "./types.js";
import { assetTimerKey } from "./types.js";

export interface StoreAssetCopyInput {
  readonly entityId: string;
  readonly sourceStoreId: string;
  readonly targetStoreId: string;
}
/** 授权由上层负责；本域只返回共同410预锁需要的文件集合。 */
export interface StoreAssetCopyPlan {
  readonly fileIds: readonly string[];
}
export interface StoreAssetCopyDeps extends Pick<MediaAssetsDeps, "readStore" | "sla"> {
  readonly clock: Clock;
  readonly media: Pick<Media, "link">;
  readonly timers: Pick<MediaAssetsDeps["timers"], "arm">;
}
const Input = z.strictObject({
  entityId: IdSchema,
  sourceStoreId: IdSchema,
  targetStoreId: IdSchema,
});
const sorted = (ids: readonly string[]) => [...new Set(ids)].sort();
const json = (value: Prisma.JsonValue) =>
  value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
async function roots(tx: Tx, input: StoreAssetCopyInput) {
  return tx.storeAsset.findMany({
    where: { entityId: input.entityId, storeId: input.sourceStoreId, deletedAt: null },
    orderBy: { id: "asc" },
    include: {
      storeAssetFiles: { orderBy: { position: "asc" } },
      storeAssetTags: { orderBy: { id: "asc" } },
      storeAssetInsights: { orderBy: { id: "asc" } },
    },
  });
}

/** 调用前完成低序图；日历共享锁先于完整370图，之后才允许共同410。 */
export function createStoreAssetCopyOwner(deps: StoreAssetCopyDeps) {
  type State = {
    tx: Tx;
    input: StoreAssetCopyInput;
    rows: Awaited<ReturnType<typeof roots>>;
    ids: string[];
    consumed: boolean;
  };
  const plans = new WeakMap<StoreAssetCopyPlan, State>();
  async function current(tx: Tx, input: StoreAssetCopyInput) {
    const source = await deps.readStore(tx, input.sourceStoreId);
    const target = await deps.readStore(tx, input.targetStoreId);
    if (
      !source ||
      !target ||
      source.id !== input.sourceStoreId ||
      target.id !== input.targetStoreId ||
      source.entityId !== input.entityId ||
      target.entityId !== input.entityId ||
      !["active", "archived"].includes(source.lifecycle) ||
      target.lifecycle !== "active" ||
      target.isPrimary ||
      target.qualificationStatus !== "unsubmitted"
    )
      throw new AppError("VALIDATION_FAILED");
  }
  async function prepare(tx: Tx, raw: StoreAssetCopyInput): Promise<StoreAssetCopyPlan> {
    const parsed = Input.safeParse(raw);
    if (!parsed.success || parsed.data.sourceStoreId === parsed.data.targetStoreId)
      throw new AppError("VALIDATION_FAILED");
    const input = parsed.data;
    await lockRows(tx, "store", [input.sourceStoreId, input.targetStoreId]);
    await current(tx, input);
    await lockCalendarImport(tx);
    const all = await roots(tx, input);
    await lockRows(
      tx,
      "store_asset",
      all.map((row) => row.id),
    );
    const rows = await roots(tx, input);
    if (rows.some((row) => !all.some((planned) => planned.id === row.id)))
      throw new AppError("VALIDATION_FAILED");
    const chosen = rows.filter((row) =>
      row.storeAssetTags.some(
        (tag) => tag.dimension === "content" && tag.tagCode === "brand_story",
      ),
    );
    const fileIds = sorted(
      chosen.flatMap((row) => [
        ...row.storeAssetFiles.map((file) => file.fileId),
        ...row.portraitAuthFileIds,
      ]),
    );
    const plan = Object.freeze({ fileIds: Object.freeze(fileIds) });
    plans.set(plan, { tx, input, rows, ids: chosen.map(() => uuidv7()), consumed: false });
    return plan;
  }
  async function apply(tx: Tx, plan: StoreAssetCopyPlan): Promise<void> {
    const state = plans.get(plan);
    if (!state || state.tx !== tx || state.consumed)
      throw new TypeError("素材复制计划必须来自本实例、本事务且尚未消费");
    state.consumed = true;
    const { input } = state;
    await lockRows(tx, "file_object", plan.fileIds);
    const unchanged = async () => {
      if (JSON.stringify(await roots(tx, input)) !== JSON.stringify(state.rows))
        throw new AppError("VALIDATION_FAILED");
      await current(tx, input);
    };
    await unchanged();
    const chosen = state.rows.filter((row) =>
      row.storeAssetTags.some(
        (tag) => tag.dimension === "content" && tag.tagCode === "brand_story",
      ),
    );
    for (const [index, row] of chosen.entries()) {
      const id = state.ids[index]!,
        now = deps.clock.now();
      const values =
        row.reviewState === "unreviewed"
          ? await paramsAt(tx, ["sla.review.store_asset"], now)
          : null;
      const due = values
        ? await deps.sla.dueAt(tx, {
            policy: "review.store_asset",
            ...values["sla.review.store_asset"],
            from: now,
            workHours: await workHoursAt(tx, now),
          })
        : null;
      await tx.storeAsset.create({
        data: {
          id,
          entityId: input.entityId,
          storeId: input.targetStoreId,
          sourceStoreAssetId: row.id,
          idempotencyKey: `copy:${row.id}`,
          type: row.type,
          title: row.title,
          textBody: row.textBody,
          note: row.note,
          uploadActorType: row.uploadActorType,
          uploadActorId: row.uploadActorId,
          uploadClient: row.uploadClient,
          uploadActorRole: row.uploadActorRole,
          storeAssetDemandId: null,
          adoptedCount: 0,
          processingState: row.processingState,
          isInsightPartial: row.isInsightPartial,
          reviewState: row.reviewState,
          usability: row.usability,
          reviewedByStaffId: row.reviewedByStaffId,
          reviewedAt: row.reviewedAt,
          portraitAuthFileIds: [...row.portraitAuthFileIds],
          portraitAuthorizedAt: row.portraitAuthorizedAt,
          moderationState: row.moderationState,
          searchText: row.searchText,
          dueAt: due?.dueAt ?? null,
          slaSnapshot: due ? (due.snapshot as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          lockVersion: 0,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      for (const file of row.storeAssetFiles) {
        await tx.storeAssetFile.create({
          data: { storeAssetId: id, fileId: file.fileId, position: file.position, createdAt: now },
        });
        await deps.media.link(tx, {
          fileId: file.fileId,
          refType: "store_asset",
          refId: id,
          role: "main",
          entityId: input.entityId,
          storeId: input.targetStoreId,
        });
      }
      for (const fileId of row.portraitAuthFileIds)
        await deps.media.link(tx, {
          fileId,
          refType: "store_asset",
          refId: id,
          role: "portrait_auth",
          entityId: input.entityId,
          storeId: input.targetStoreId,
        });
      for (const tag of row.storeAssetTags) {
        const {
          id: _old,
          storeAssetId: _asset,
          createdAt: _created,
          updatedAt: _updated,
          ...facts
        } = tag;
        await tx.storeAssetTag.create({
          data: { ...facts, id: uuidv7(), storeAssetId: id, createdAt: now, updatedAt: now },
        });
      }
      for (const insight of row.storeAssetInsights)
        await tx.storeAssetInsight.create({
          data: {
            id: uuidv7(),
            storeAssetId: id,
            fileId: insight.fileId,
            kind: insight.kind,
            promptVersion: insight.promptVersion,
            provider: insight.provider,
            model: insight.model,
            status: insight.status,
            content: json(insight.content),
            reusedFromStoreAssetInsightId: insight.id,
            mediaJobId: null,
            createdAt: now,
            updatedAt: now,
          },
        });
      if (due)
        await deps.timers.arm(tx, {
          key: assetTimerKey(id),
          kind: "sla.breach",
          fireAt: due.dueAt,
          subject: { type: "store_asset", id },
          entityId: input.entityId,
          storeId: input.targetStoreId,
          payload: { dueAt: due.dueAt.toISOString() },
        });
    }
    await unchanged();
  }
  return { prepare, apply };
}
export type StoreAssetCopyOwner = ReturnType<typeof createStoreAssetCopyOwner>;
