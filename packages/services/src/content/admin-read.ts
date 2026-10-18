import {
  AdminDramaDetailSchema,
  CopyrightRevisionSchema,
  DramaCopyrightSnapshotSchema,
  DramaListResultSchema,
  DramaSummarySchema,
  DramaPermitSchema,
  DramaEpisodeRowSchema,
  MediaReadinessSchema,
  DramaListQuerySchema,
  DramaEpisodeListQuerySchema,
  DramaPermitListQuerySchema,
  DramaPermitListResultSchema,
  DramaSummaryQuerySchema,
  TrailerBriefSchema,
} from "@liyoxi/contract";
import type {
  AdminDramaDetail,
  CopyrightRevision,
  StaffBrief,
  DramaPricing,
  DramaEpisodeRow,
  z,
} from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { hasPermission, satisfiesLevel } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Clock, Tx } from "../kernel/index.js";
import { paramsAt } from "../config/index.js";
import type { Content } from "./service.js";
import { stopDate } from "@liyoxi/shared/catalog";
import type { DramaPrices } from "./ports.js";
import { dateOf } from "./checks.js";
type TrailerBrief = z.infer<typeof TrailerBriefSchema>;
export interface ContentAdminReadDeps {
  clock: Clock;
  content: Content;
  prices: DramaPrices;
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
  const trailer = await adminTrailerView(tx, deps, id);
  const media = await deps.content.mediaReadiness(tx, id, at);
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
      withCurrentMaster: media.masters.withCurrentMaster,
      processing: media.episodes.filter((v) => v.masterState === "processing").length,
    },
    pricing,
    listingChecks: { ...checks, evaluatedAt: checks.evaluatedAt },
    actions: !row.archivedAt
      ? [
          ...(row.status !== "listed" && hasPermission(staff, "drama.shelf") && checks.isShelvable
            ? ["shelve"]
            : []),
          ...(row.status === "listed" && hasPermission(staff, "drama.shelf") ? ["delist"] : []),
          ...(row.isPermitRecheckRequired && canEdit ? ["confirm-permit-recheck"] : []),
        ]
      : [],
    editability: {
      canEditContent: canEdit,
      copyrightEditMode: editMode,
      canManageMedia: !row.archivedAt && hasPermission(staff, "drama.media.manage"),
      canReprice:
        hasPermission(staff, "billing.price.edit") &&
        satisfiesLevel(staff.moduleLevels.billing, "view") &&
        !row.archivedAt &&
        flag !== "license_ended" &&
        flag !== "stopped",
    },
  });
}

export async function adminTrailerView(
  tx: Tx,
  deps: ContentAdminReadDeps,
  id: string,
): Promise<TrailerBrief | null> {
  const facts = await deps.content.mediaReadiness(tx, id, deps.clock.now());
  if (!facts.trailer) return null;
  const { pointer, target, sourceInfo } = facts.trailer;
  return TrailerBriefSchema.parse({
    targetPlayableId: target.id,
    currentPlayableId: pointer.currentPlayableAssetId,
    state: target.state,
    sourceFile: (await files(tx, [target.sourceFileId]))[0],
    durationMs: target.durationMs ?? sourceInfo?.durationMs ?? null,
    width: target.width ?? sourceInfo?.displayWidth ?? null,
    height: target.height ?? sourceInfo?.displayHeight ?? null,
    coverUrl: null,
    error: target.error,
    setBy: await brief(deps, tx, pointer.setByStaffId),
    setAt: pointer.setAt.toISOString(),
    readyAt: target.readyAt?.toISOString() ?? null,
  });
}
export async function adminMediaReadiness(tx: Tx, deps: ContentAdminReadDeps, id: string) {
  const facts = await deps.content.mediaReadiness(tx, id, deps.clock.now());
  const people = await deps.staffBriefs(
    tx,
    facts.openUploadBatches.map((v) => v.createdByStaffId),
  );
  return MediaReadinessSchema.parse({
    trailer: await adminTrailerView(tx, deps, id),
    isTrailerReady: facts.isTrailerReady,
    poster: facts.poster
      ? {
          fileId: facts.poster.id,
          moderationState: facts.poster.moderationState,
          isBlocked: facts.poster.moderationState === "block",
        }
      : null,
    masters: facts.masters,
    openUploadBatches: facts.openUploadBatches.map((v) => ({
      uploadBatchId: v.id,
      state: v.state,
      scope: v.scope,
      createdBy: people.find((p) => p.staffId === v.createdByStaffId),
      expiresAt: v.expiresAt.toISOString(),
    })),
  });
}
export async function adminEpisodeView(
  tx: Tx,
  deps: ContentAdminReadDeps,
  id: string,
): Promise<DramaEpisodeRow> {
  const row = await tx.dramaEpisode.findUnique({ where: { id } });
  if (!row) throw new AppError("NOT_FOUND");
  const facts = await deps.content.mediaReadiness(tx, row.dramaId, deps.clock.now());
  const fact = facts.episodes.find((v) => v.episodeNo === row.episodeNo);
  if (!fact) throw new AppError("NOT_FOUND");
  const master = fact.currentMaster;
  return DramaEpisodeRowSchema.parse({
    dramaEpisodeId: row.id,
    episodeNo: row.episodeNo,
    title: row.title,
    durationMs: row.durationMs,
    masterState: fact.masterState,
    openUploadBatchId: fact.openUploadBatchId,
    currentMaster: master
      ? {
          dramaEpisodeMasterId: master.id,
          revNo: master.revNo,
          file: (await files(tx, [master.fileId]))[0],
          durationMs: master.durationMs,
          activatedAt: master.activatedAt?.toISOString() ?? null,
          replaceReason: master.replaceReason,
          isContentChanged: master.isContentChanged,
        }
      : null,
    updatedAt: row.updatedAt.toISOString(),
  });
}
export async function adminDramaEpisodes(
  tx: Tx,
  deps: ContentAdminReadDeps,
  id: string,
  raw: unknown,
) {
  const query = DramaEpisodeListQuerySchema.parse(raw);
  const facts = await deps.content.mediaReadiness(tx, id, deps.clock.now());
  const states = query.masterState?.split(",");
  const selected = facts.episodes.filter((v) => !states || states.includes(v.masterState));
  const nos = selected
    .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
    .map((v) => v.episodeNo);
  const rows = await tx.dramaEpisode.findMany({
    where: { dramaId: id, episodeNo: { in: nos } },
    orderBy: { episodeNo: "asc" },
  });
  return {
    items: await Promise.all(rows.map((v) => adminEpisodeView(tx, deps, v.id))),
    page: query.page,
    pageSize: query.pageSize,
    total: selected.length,
  };
}
export async function adminPermitView(
  tx: Tx,
  deps: ContentAdminReadDeps,
  staff: StaffContext,
  id: string,
) {
  const row = await tx.dramaPermit.findUnique({
    where: { id },
    include: { drama: { select: { firstListedAt: true, archivedAt: true } } },
  });
  if (!row) throw new AppError("NOT_FOUND");
  return DramaPermitSchema.parse({
    dramaPermitId: row.id,
    platform: row.platform,
    permitKind: row.permitKind,
    permitNo: row.permitNo,
    scanFiles: await files(tx, row.scanFileIds),
    status: row.status,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    retireReason: row.retireReason,
    note: row.note,
    isFrozen: row.drama.firstListedAt !== null,
    createdBy: await brief(deps, tx, row.createdByStaffId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    actions:
      row.status === "active" &&
      !row.drama.archivedAt &&
      satisfiesLevel(staff.moduleLevels.drama, "edit")
        ? ["retire"]
        : [],
  });
}
export async function adminDramaPermits(
  tx: Tx,
  deps: ContentAdminReadDeps,
  staff: StaffContext,
  id: string,
  raw: unknown,
) {
  const query = DramaPermitListQuerySchema.parse(raw);
  const drama = await tx.drama.findUnique({
    where: { id },
    select: { dramaClass: true, lockVersion: true },
  });
  if (!drama) throw new AppError("NOT_FOUND");
  const rows = await tx.dramaPermit.findMany({
    where: { dramaId: id },
    orderBy: [{ platform: "asc" }, { permitKind: "asc" }, { id: "asc" }],
  });
  const selected = rows.filter((v) => !query.status || query.status.split(",").includes(v.status));
  selected.sort((a, b) => Number(a.status === "retired") - Number(b.status === "retired"));
  return DramaPermitListResultSchema.parse({
    items: await Promise.all(selected.map((v) => adminPermitView(tx, deps, staff, v.id))),
    dramaClass: drama.dramaClass,
    requiredKinds:
      drama.dramaClass === "class_3"
        ? ["program_no"]
        : drama.dramaClass
          ? ["license_no", "approval_no"]
          : [],
    dramaLockVersion: drama.lockVersion,
  });
}
async function catalogueFacts(tx: Tx, deps: ContentAdminReadDeps) {
  const at = deps.clock.now(),
    today = calendarDate(at);
  const [rows, parameters, months] = await Promise.all([
    tx.drama.findMany({ include: { dramaCopyrights: true, dramaStats: true } }),
    paramsAt(tx, ["remind.copyright.days"], at),
    deps.prices.minLicenseMonths(tx, at),
  ]);
  return {
    at,
    months,
    days: parameters["remind.copyright.days"],
    rows: rows.map((row) => {
      const end = dateOf(row.dramaCopyrights[0]?.licenseEndDate ?? null);
      const stop = end ? stopDate(end, months) : null;
      const flag =
        end && today > end
          ? "license_ended"
          : row.status === "listed" && stop && today >= stop
            ? "stopped"
            : row.status !== "listed"
              ? "not_listed"
              : "orderable";
      return {
        row,
        end,
        stop,
        flag,
        expiring:
          !!end && today <= end && end <= addDays(today, parameters["remind.copyright.days"]),
      };
    }),
  };
}
export async function adminDramas(
  tx: Tx,
  deps: ContentAdminReadDeps,
  staff: StaffContext,
  raw: unknown,
) {
  const q = DramaListQuerySchema.parse(queryInput(raw)),
    all = await catalogueFacts(tx, deps);
  const text = q.q?.replace(/\s/gu, "").toLocaleLowerCase();
  const selected = all.rows.filter(
    ({ row, flag, expiring }) =>
      (!text || row.title.replace(/\s/gu, "").toLocaleLowerCase().includes(text)) &&
      (!q.status || q.status.split(",").includes(row.status)) &&
      (!q.genreCode || row.genreCodes.includes(q.genreCode)) &&
      (!q.industryCode || row.industryCodes.includes(q.industryCode)) &&
      (!q.heatTier || (row.heatTier !== null && q.heatTier.split(",").includes(row.heatTier))) &&
      (!q.dramaClass ||
        (row.dramaClass !== null && q.dramaClass.split(",").includes(row.dramaClass))) &&
      (q.isArchived === undefined || Boolean(row.archivedAt) === q.isArchived) &&
      (q.isExpiringSoon !== true || (row.status === "listed" && expiring)) &&
      (q.isOrderable !== true || (!row.archivedAt && flag === "orderable")),
  );
  const time = (value: Date | null) => value?.getTime() ?? -Infinity;
  selected.sort((a, b) => {
    let result = 0;
    switch (q.sort) {
      case "-updatedAt":
        result = time(b.row.updatedAt) - time(a.row.updatedAt);
        break;
      case "-createdAt":
        result = time(b.row.createdAt) - time(a.row.createdAt);
        break;
      case "-firstListedAt":
        result = time(b.row.firstListedAt) - time(a.row.firstListedAt);
        break;
      case "licenseEndDate":
        result = (a.end ?? "9999").localeCompare(b.end ?? "9999");
        break;
      case "-ordersMtd":
        result = (b.row.dramaStats[0]?.ordersMtd ?? -1) - (a.row.dramaStats[0]?.ordersMtd ?? -1);
        break;
      case "title":
        result = a.row.title.localeCompare(b.row.title);
        break;
    }
    return (Number.isNaN(result) ? 0 : result) || a.row.id.localeCompare(b.row.id);
  });
  const page = selected.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
  const [prices, dictionaries] = await Promise.all([
    deps.prices.priceAt(
      tx,
      page.map((v) => v.row.id),
      all.at,
    ),
    tx.dictItem.findMany({ where: { dictTypeKey: { in: ["genre", "industry"] } } }),
  ]);
  const refs = (type: string, codes: string[]) =>
    codes.map((code) => ({
      code,
      name: dictionaries.find((v) => v.dictTypeKey === type && v.code === code)?.name ?? code,
    }));
  const items = [];
  for (const { row, end, stop, flag, expiring } of page) {
    const price = prices.get(row.id),
      priced = price && typeof price !== "string" ? price : null;
    const checks =
      !row.archivedAt && row.status !== "listed" && hasPermission(staff, "drama.shelf")
        ? await deps.content.listingChecks(tx, row.id, all.at)
        : null;
    const stat = row.status === "draft" ? null : row.dramaStats[0];
    items.push({
      dramaId: row.id,
      title: row.title,
      posterUrl: null,
      genres: refs("genre", row.genreCodes),
      industries: refs("industry", row.industryCodes),
      dramaClass: row.dramaClass,
      totalEpisodes: row.totalEpisodes,
      heatTier: row.heatTier,
      listPricePoints: priced?.points ?? null,
      templatePoints: priced
        ? (await deps.pricing(tx, staff, row.id, all.at)).templatePoints
        : null,
      priceMode: priced?.source.mode ?? null,
      status: row.status,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      liveItems: stat?.liveItems ?? null,
      ordersMtd: stat?.ordersMtd ?? null,
      statRefreshedAt: stat?.refreshedAt.toISOString() ?? null,
      licenseEndDate: end,
      stopOrderDate: stop,
      licenseFlag: flag,
      isExpiringSoon: expiring,
      shelveBlockedReason: row.archivedAt
        ? "archived"
        : flag === "license_ended"
          ? "license_ended"
          : null,
      actions:
        !row.archivedAt && hasPermission(staff, "drama.shelf")
          ? row.status === "listed"
            ? ["delist"]
            : checks?.isShelvable
              ? ["shelve"]
              : []
          : [],
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return DramaListResultSchema.parse({
    items,
    page: q.page,
    pageSize: q.pageSize,
    total: selected.length,
  });
}
export async function adminDramaSummary(tx: Tx, deps: ContentAdminReadDeps, raw: unknown) {
  DramaSummaryQuerySchema.parse(queryInput(raw));
  const facts = await catalogueFacts(tx, deps),
    rows = facts.rows;
  return DramaSummarySchema.parse({
    counts: {
      draft: rows.filter((v) => v.row.status === "draft").length,
      listed: rows.filter((v) => v.row.status === "listed").length,
      delisted: rows.filter((v) => v.row.status === "delisted").length,
    },
    archived: rows.filter((v) => v.row.archivedAt).length,
    stopped: rows.filter((v) => v.row.status === "listed" && v.flag === "stopped").length,
    expiringSoon: rows.filter((v) => v.row.status === "listed" && v.expiring).length,
    expiringSoonStopped: rows.filter(
      (v) => v.row.status === "listed" && v.expiring && v.flag === "stopped",
    ).length,
    expiringWindowDays: facts.days,
    minLicenseMonths: facts.months,
  });
}

function queryInput(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      ["isArchived", "isOrderable", "isExpiringSoon"].includes(key) && typeof value === "boolean"
        ? String(value)
        : value,
    ]),
  );
}
