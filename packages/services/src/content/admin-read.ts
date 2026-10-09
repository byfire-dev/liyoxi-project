import {
  AdminDramaDetailSchema,
  CopyrightRevisionSchema,
  DramaCopyrightSnapshotSchema,
} from "@liyoxi/contract";
import type {
  AdminDramaDetail,
  CopyrightRevision,
  StaffBrief,
  DramaPricing,
} from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { hasPermission, satisfiesLevel } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Clock, Tx } from "../kernel/index.js";
import { paramsAt } from "../config/index.js";
import type { Content } from "./service.js";
import { dateOf } from "./checks.js";
export interface ContentAdminReadDeps {
  clock: Clock;
  content: Content;
  staffBriefs(tx: Tx, ids: readonly string[]): Promise<readonly StaffBrief[]>;
  pricing(tx: Tx, staff: StaffContext, id: string, at: Date): Promise<DramaPricing>;
}
async function files(tx: Tx, ids: readonly string[]) {
  const rows = await tx.fileObject.findMany({ where: { id: { in: [...ids] } } });
  return ids.flatMap((id) => {
    const row = rows.find((v) => v.id === id);
    return row
      ? [
          {
            fileId: row.id,
            originalName: row.originalName,
            sizeBytes: row.sizeBytes?.toString() ?? null,
            mime: row.mime,
            status: row.status,
            moderationState: row.moderationState,
          },
        ]
      : [];
  });
}
async function brief(deps: ContentAdminReadDeps, tx: Tx, id: string) {
  const found = (await deps.staffBriefs(tx, [id]))[0];
  if (!found) throw new AppError("NOT_FOUND");
  return found;
}
export async function copyrightRevisionView(
  tx: Tx,
  deps: ContentAdminReadDeps,
  id: string,
): Promise<CopyrightRevision> {
  const row = await tx.dramaCopyrightRevision.findUnique({ where: { id } });
  if (!row) throw new AppError("NOT_FOUND");
  return CopyrightRevisionSchema.parse({
    dramaCopyrightRevisionId: row.id,
    changeKind: row.changeKind,
    snapshot: DramaCopyrightSnapshotSchema.parse(row.copyrightSnapshot),
    prevEndDate: dateOf(row.prevEndDate),
    newEndDate: dateOf(row.newEndDate),
    reason: row.reason,
    proofFiles: await files(tx, row.proofFileIds),
    createdBy: await brief(deps, tx, row.createdByStaffId),
    createdAt: row.createdAt.toISOString(),
  });
}
/** Snapshot contains no signed URL: safe to persist as an idempotency response. */
export async function adminDramaDetail(
  tx: Tx,
  deps: ContentAdminReadDeps,
  staff: StaffContext,
  id: string,
): Promise<AdminDramaDetail> {
  const row = await tx.drama.findUnique({
    where: { id },
    include: {
      dramaCopyrights: true,
      dramaEpisodes: true,
      dramaEpisodeMasters: true,
      dramaTrailers: { include: { targetPlayableAsset: true } },
    },
  });
  if (!row) throw new AppError("NOT_FOUND");
  const at = deps.clock.now(),
    copyright = row.dramaCopyrights[0];
  if (!copyright) throw new AppError("NOT_FOUND");
  const [createdBy, updatedBy, pricing, checks, orderability, params] = await Promise.all([
    brief(deps, tx, row.createdByStaffId),
    brief(deps, tx, row.updatedByStaffId),
    deps.pricing(tx, staff, id, at),
    deps.content.listingChecks(tx, id, at),
    deps.content.getOrderability(tx, [id]),
    paramsAt(tx, ["content.placement.open_slots", "remind.copyright.days"], at),
  ]);
  const dicts = await tx.dictItem.findMany({
    where: { dictTypeKey: { in: ["genre", "selling_tag", "industry"] } },
  });
  const refs = (type: string, codes: string[]) =>
    codes.map((code) => {
      const item = dicts.find((v) => v.dictTypeKey === type && v.code === code);
      return { code, name: item?.name ?? code };
    });
  const end = dateOf(copyright.licenseEndDate),
    today = calendarDate(at),
    stopped = orderability.get(id)?.stopDate ?? null;
  const flag =
    end && today > end
      ? "license_ended"
      : row.status !== "listed"
        ? "not_listed"
        : stopped && today >= stopped
          ? "stopped"
          : "orderable";
  const editMode = row.archivedAt ? "locked" : row.firstListedAt ? "revision" : "direct",
    canEdit = satisfiesLevel(staff.moduleLevels.drama, "edit") && !row.archivedAt;
  const pointer = row.dramaTrailers[0],
    asset = pointer?.targetPlayableAsset;
  const sourceInfo = asset
    ? await tx.mediaInfo.findUnique({
        where: { fileId: asset.sourceFileId },
        select: { durationMs: true, displayWidth: true, displayHeight: true },
      })
    : null;
  const trailer =
    pointer && asset
      ? {
          targetPlayableId: pointer.targetPlayableAssetId,
          currentPlayableId: pointer.currentPlayableAssetId,
          state: asset.state,
          sourceFile: (await files(tx, [asset.sourceFileId]))[0],
          durationMs: asset.durationMs ?? sourceInfo?.durationMs ?? null,
          width: asset.width ?? sourceInfo?.displayWidth ?? null,
          height: asset.height ?? sourceInfo?.displayHeight ?? null,
          coverUrl: null,
          error: asset.error,
          setBy: await brief(deps, tx, pointer.setByStaffId),
          setAt: pointer.setAt.toISOString(),
          readyAt: asset.readyAt?.toISOString() ?? null,
        }
      : null;
  return AdminDramaDetailSchema.parse({
    dramaId: id,
    title: row.title,
    status: row.status,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    statusChangedAt: row.statusChangedAt.toISOString(),
    firstListedAt: row.firstListedAt?.toISOString() ?? null,
    listedAt: row.listedAt?.toISOString() ?? null,
    delistedAt: row.delistedAt?.toISOString() ?? null,
    delistReasonCode: row.delistReasonCode,
    delistNote: row.delistNote,
    createdAt: row.createdAt.toISOString(),
    createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy,
    lockVersion: row.lockVersion,
    posterFileId: row.posterFileId,
    posterUrl: null,
    totalEpisodes: row.totalEpisodes,
    episodeDurationSec: row.episodeDurationSec,
    genres: refs("genre", row.genreCodes),
    sellingTags: refs("selling_tag", row.sellingTagCodes),
    producerName: row.producerName,
    castNames: row.castNames,
    synopsis: row.synopsis,
    roles: row.roles,
    dramaClass: row.dramaClass,
    isAiGenerated: row.isAiGenerated,
    heatTier: row.heatTier,
    manualBoost: row.manualBoost,
    industries: refs("industry", row.industryCodes),
    targetAudience: row.targetAudience,
    allowedPlacements: row.allowedPlacements,
    openPlacementSlots: params["content.placement.open_slots"],
    trialEpisodeCount: row.trialEpisodeCount,
    isPermitRecheckRequired: row.isPermitRecheckRequired,
    bodyEditPolicy: row.bodyEditPolicy,
    copyright: {
      ...copyright,
      licenseStartDate: dateOf(copyright.licenseStartDate),
      licenseEndDate: end,
      proofFiles: await files(tx, copyright.proofFileIds),
      currentRevisionId: copyright.currentDramaCopyrightRevisionId,
      stopOrderDate: stopped,
      licenseFlag: flag,
      isExpiringSoon: Boolean(
        end && today <= end && end <= addDays(today, params["remind.copyright.days"]),
      ),
      editMode,
      lockVersion: copyright.lockVersion,
    },
    trailer,
    episodeSummary: {
      total: row.dramaEpisodes.length,
      withCurrentMaster: row.dramaEpisodeMasters.filter((v) => v.isCurrent).length,
      processing: row.dramaEpisodeMasters.filter((v) => v.isCurrent && v.state !== "ready").length,
    },
    pricing,
    listingChecks: { ...checks, evaluatedAt: checks.evaluatedAt },
    actions: canEdit
      ? [
          ...(row.status !== "listed" && hasPermission(staff, "drama.shelf") && checks.isShelvable
            ? ["shelve"]
            : []),
          ...(row.status === "listed" && hasPermission(staff, "drama.shelf") ? ["delist"] : []),
          ...(row.isPermitRecheckRequired ? ["confirm-permit-recheck"] : []),
        ]
      : [],
    editability: {
      canEditContent: canEdit,
      copyrightEditMode: editMode,
      canManageMedia: canEdit && hasPermission(staff, "drama.media.manage"),
      canReprice:
        hasPermission(staff, "billing.price.edit") &&
        satisfiesLevel(staff.moduleLevels.billing, "view") &&
        !row.archivedAt &&
        flag !== "license_ended" &&
        flag !== "stopped",
    },
  });
}
