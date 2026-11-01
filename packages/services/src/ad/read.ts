import { createHash } from "node:crypto";
import {
  IdSchema,
  AdStateSchema,
  AdRevisionResultSchema,
  AdRevisionWrittenSchema,
} from "@liyoxi/contract";
import type { AdListQuery } from "@liyoxi/contract";
import type { Ad, AdVersion, AdRevision, Prisma } from "@liyoxi/db";
import type { Tx } from "../kernel/index.js";
import { paramsAt } from "../config/index.js";
import { getEntitlements, quoteHold } from "../billing/index.js";
import { storeGate, readMaterialProfile } from "../profile/index.js";
import { readAdReferenceFacts, readMaterialFileFacts } from "../media/index.js";
import type { AdActor, AdReopenChange, AdWriteDeps } from "./context.js";
import { member, merchantAd } from "./lifecycle.js";
import { adViewEvidence } from "./confirm.js";
const iso = (date: Date | null) => date?.toISOString() ?? null;
function revisionView(r: AdRevision) {
  return AdRevisionWrittenSchema.parse({
    revisionNo: r.revisionNo,
    onVersionNo: r.onVersionNo,
    source: r.source,
    isChargeable: r.isChargeable,
    chargePoints: r.chargePoints,
    segmentIndex: r.segmentIndex,
    timeStartMs: r.timeStartMs,
    timeEndMs: r.timeEndMs,
    note: r.note,
    screenshotFileIds: r.screenshotFileIds,
    actorType: r.actorType,
    createdAt: iso(r.createdAt),
    dueAt: iso(r.dueAt),
    fulfilledByVersionNo: r.fulfilledByVersionNo,
  });
}
function versionView(v: AdVersion) {
  return {
    versionNo: v.versionNo,
    uploadedAt: iso(v.uploadedAt),
    pushedAt: iso(v.pushedAt),
    durationMs: v.durationMs,
    width: v.width,
    height: v.height,
    segments: Array.isArray(v.segments) ? v.segments : [],
    previewChannels: v.previewChannels,
    offlineSentAt: iso(v.offlineSentAt),
    decision: v.decision,
    decidedAt: iso(v.decidedAt),
    confirmViewedVia: v.confirmViewedVia,
    viewedAckAt: iso(v.viewedAckAt),
  };
}
async function state(tx: Tx, ad: Ad) {
  const current = await tx.adVersion.findFirst({
      where: { adId: ad.id, pushedAt: { not: null } },
      orderBy: { versionNo: "desc" },
    }),
    gate = await storeGate(tx, ad.storeId);
  const policy =
    ad.slaSnapshot && typeof ad.slaSnapshot === "object" && !Array.isArray(ad.slaSnapshot)
      ? ad.slaSnapshot.policy
      : null;
  return AdStateSchema.parse({
    adId: ad.id,
    adNo: ad.adNo,
    status: ad.status,
    displayStatus: ["pending_assign", "producing", "returned"].includes(ad.status)
      ? "producing"
      : ad.status,
    waitingReason:
      ad.status === "returned"
        ? "materials"
        : ad.status === "pending_assign" && gate !== "full"
          ? "qualification"
          : null,
    currentVersionNo: current?.versionNo ?? null,
    confirmedVersionNo: ad.confirmedVersionNo,
    confirmedAt: iso(ad.confirmedAt),
    revisionCount: ad.revisionCount,
    freeRevisionsRemaining: Math.max(0, ad.freeRevisionQuota - ad.revisionCount),
    chargePoints: ad.chargePoints,
    isCaptured: !!ad.capturedAt,
    dueAt: iso(ad.dueAt),
    dueKind: !ad.dueAt ? null : policy === "ad.revision" ? "revision" : "first_version",
    hasOpenCancelRequest: !!ad.openCancelRequestId,
    actions: ad.openCancelRequestId
      ? []
      : ad.status === "pending_confirm"
        ? ["confirm", "request-change"]
        : ad.status === "confirmed"
          ? ["request-change"]
          : ad.status === "returned"
            ? ["submit"]
            : [],
  });
}
export async function stateResult(tx: Tx, _deps: AdWriteDeps, actor: AdActor, adId: string) {
  return state(tx, await merchantAd(tx, actor, adId));
}
export async function revisionResult(
  tx: Tx,
  deps: AdWriteDeps,
  actor: AdActor,
  change: AdReopenChange,
) {
  const revision = await tx.adRevision.findFirstOrThrow({
    where: { id: change.revisionId, adId: change.adId },
  });
  return AdRevisionResultSchema.parse({
    ad: await stateResult(tx, deps, actor, change.adId),
    revision: revisionView(revision),
  });
}
async function card(tx: Tx, deps: AdWriteDeps, ad: Ad) {
  const current = await tx.adVersion.findFirst({
    where: { adId: ad.id, pushedAt: { not: null } },
    orderBy: { versionNo: "desc" },
  });
  const confirmed = ad.confirmedVersionNo
    ? await tx.adVersion.findUnique({
        where: { adId_versionNo: { adId: ad.id, versionNo: ad.confirmedVersionNo } },
      })
    : null;
  const file = current ? (await readMaterialFileFacts(tx, [current.fileId]))[0] : null;
  const related = await deps.related(tx, {
    entityId: ad.entityId,
    storeId: ad.storeId,
    adId: ad.id,
  });
  const dicts = await tx.dictItem.findMany({
    where: { dictTypeKey: "ad_promo_point", code: { in: ad.promoPointCodes } },
    select: { code: true, name: true },
  });
  return {
    ...(await state(tx, ad)),
    type: ad.type,
    durationSec: ad.durationSec,
    returnReason: ad.returnReason,
    copy: ad.copy,
    promoPoints: ad.promoPointCodes.map((code) => ({
      code,
      name: dicts.find((d) => d.code === code)?.name ?? code,
    })),
    coverUrl: null as string | null,
    coverExpiresAt: null as string | null,
    currentPreviewChannels: current?.previewChannels ?? [],
    isSelectable:
      ad.status !== "cancelled" &&
      !ad.openCancelRequestId &&
      !!confirmed?.pushedAt &&
      confirmed.decision === "confirmed",
    freeRevisionQuota: ad.freeRevisionQuota,
    usage: related.usage,
    submittedAt: iso(ad.submittedAt)!,
    updatedAt: iso(ad.updatedAt)!,
    _coverFileId: file?.mediaInfo?.coverFileId ?? null,
    _related: related,
  };
}
export async function listAds(tx: Tx, deps: AdWriteDeps, actor: AdActor, q: AdListQuery) {
  await member(tx, actor);
  const field = q.sort === "-submittedAt" ? "submittedAt" : "updatedAt",
    scope = createHash("sha256")
      .update(
        JSON.stringify({
          ...actor.membership,
          tab: q.tab,
          type: q.type,
          isSelectable: q.isSelectable,
          sort: q.sort,
        }),
      )
      .digest("hex");
  let cursor: { at: string; id: string } | null = null;
  try {
    if (q.cursor) {
      const c = JSON.parse(Buffer.from(q.cursor, "base64url").toString());
      if (
        c.scope === scope &&
        IdSchema.safeParse(c.id).success &&
        typeof c.at === "string" &&
        Number.isFinite(Date.parse(c.at))
      )
        cursor = c;
    }
  } catch {
    /* C42 corrupt/mismatched cursors restart the page. */
  }
  const where: Prisma.AdWhereInput = {
    entityId: actor.membership.entityId,
    storeId: actor.membership.storeId,
    ...(q.type ? { type: q.type } : {}),
    ...(q.tab === "all"
      ? {}
      : q.tab === "producing"
        ? { status: { in: ["pending_assign", "producing", "returned"] } }
        : { status: q.tab }),
    ...(q.isSelectable
      ? {
          confirmedVersionNo: { not: null },
          AND: [{ status: { not: "cancelled" } }],
          openCancelRequestId: null,
        }
      : {}),
    ...(cursor
      ? {
          OR: [
            { [field]: { lt: new Date(cursor.at) } },
            { [field]: new Date(cursor.at), id: { lt: cursor.id } },
          ],
        }
      : {}),
  };
  const rows = await tx.ad.findMany({
      where,
      orderBy: [{ [field]: "desc" }, { id: "desc" }],
      take: q.limit + 1,
    }),
    page = rows.slice(0, q.limit),
    last = page.at(-1);
  const items = [];
  for (const ad of page) items.push(await card(tx, deps, ad));
  return {
    items,
    hasMore: rows.length > q.limit,
    nextCursor:
      rows.length > q.limit && last
        ? Buffer.from(
            JSON.stringify({ scope, at: last[field].toISOString(), id: last.id }),
          ).toString("base64url")
        : null,
  };
}
export async function detailAd(tx: Tx, deps: AdWriteDeps, actor: AdActor, id: string) {
  await member(tx, actor);
  const ad = await merchantAd(tx, actor, id),
    base = await card(tx, deps, ad);
  const versions = await tx.adVersion.findMany({
      where: { adId: id, pushedAt: { not: null } },
      orderBy: { versionNo: "desc" },
    }),
    current = versions[0] ?? null;
  const revisions = await tx.adRevision.findMany({
      where: { adId: id },
      orderBy: { revisionNo: "desc" },
    }),
    e = current
      ? await adViewEvidence(tx, id, current.versionNo)
      : { albumSavedAt: null, portalViewedAt: null };
  const enabled = await deps.playback(ad.entityId),
    fallback =
      current?.previewChannels.includes("weapp") &&
      !current.previewChannels.includes("album") &&
      !current.previewChannels.includes("portal") &&
      !enabled;
  const actual = current ? await deps.media.adProductionFacts(tx, current.fileId) : null;
  const references = await readAdReferenceFacts(tx, {
      entityId: ad.entityId,
      storeId: ad.storeId,
      adId: id,
    }),
    profile = await readMaterialProfile(tx, {
      entityId: ad.entityId,
      storeId: ad.storeId,
      fileIds: references.profileFileIds,
    });
  const allFiles = await readMaterialFileFacts(tx, [
    ...references.profileFileIds,
    ...references.assets.flatMap((a) => a.storeAssetFiles.map((f) => f.fileId)),
  ]);
  const refs = references.assets.map((a) => ({
    kind: "store_asset",
    storeAssetId: a.id,
    fileId: null,
    assetType: a.type,
    title: a.title,
    mediaGroup: null,
    category: null,
    thumbUrl: null as string | null,
    thumbExpiresAt: null as string | null,
    _thumbFileId:
      allFiles.find((f) => f.id === a.storeAssetFiles[0]?.fileId)?.mediaInfo?.coverFileId ??
      (a.type === "image" ? a.storeAssetFiles[0]?.fileId : null),
  }));
  const profileRefs = references.profileFileIds.map((fileId) => {
    const f = allFiles.find((f) => f.id === fileId),
      m = profile.media.find((m) => m.fileId === fileId && !m.removedAt);
    return {
      kind: "profile_media",
      storeAssetId: null,
      fileId,
      assetType: null,
      title: null,
      mediaGroup: m?.mediaGroup ?? null,
      category: f?.category ?? null,
      thumbUrl: null as string | null,
      thumbExpiresAt: null as string | null,
      _thumbFileId:
        f?.mediaInfo?.coverFileId ?? (f && ["jpg", "jpeg", "png"].includes(f.ext) ? fileId : null),
    };
  });
  const ent = await getEntitlements(tx, ad.entityId, deps.clock.now()),
    revisionQuote =
      ent.term && ent.subStatus === "active"
        ? await quoteHold(
            tx,
            { ...ent.term, id: ent.term.termId },
            { kind: "ad_revision" },
            deps.clock.now(),
          )
        : null;
  const editor = ad.editorId
    ? await tx.staff.findUnique({
        where: { id: ad.editorId },
        select: { name: true, displayName: true },
      })
    : null;
  const titles: Record<string, string> = {
    "ad.submit": "提交制作需求",
    "ad.assign": "剪辑师开始制作",
    "ad.return": "需要补充素材",
    "ad.resubmit": "已补充素材，重新提交",
    "ad.push_version": "广告版本已上传",
    "ad.confirm": "已确认使用",
    "ad.request_revision": "提出修改意见",
    "ad.cancel": "已取消",
  };
  const logs = await tx.auditLog.findMany({
    where: {
      targetType: "ad",
      targetId: id,
      stream: { in: ["activity", "ops"] },
      action: { in: Object.keys(titles).map((a) => `ad.status.${a.slice(3)}`) },
    },
    orderBy: { seq: "asc" },
  });
  // Cancellation's sole audit belongs to approval. Read this ad's real terminal history,
  // without inventing a second audit or exposing approval data to the merchant.
  const cancelled = await tx.statusTransition.findFirst({
    where: {
      machine: "ad",
      stateField: "status",
      subjectId: ad.id,
      entityId: ad.entityId,
      storeId: ad.storeId,
      event: "ad.cancel",
      toState: "cancelled",
    },
    orderBy: { seq: "desc" },
    select: { occurredAt: true, actorType: true },
  });
  return {
    ...base,
    remark: ad.remark,
    unitPricePoints: ad.unitPricePoints,
    discountBp: ad.discountBp,
    capturedAt: iso(ad.capturedAt),
    firstDueAt: iso(ad.firstDueAt),
    editorName: editor?.displayName ?? editor?.name ?? null,
    revisionUnitChargePoints: revisionQuote?.S ?? null,
    revisionScreenshotMax: (await paramsAt(tx, ["ad.revision_screenshot_max"], deps.clock.now()))[
      "ad.revision_screenshot_max"
    ],
    currentVersion: current ? versionView(current) : null,
    playable:
      actual?.ready && actual.playable
        ? {
            playableId: actual.playable.id,
            kind: "ad" as const,
            durationMs: actual.playable.durationMs,
            width: actual.playable.width,
            height: actual.playable.height,
            posterUrl: null as string | null,
            sources: [] as Awaited<ReturnType<AdWriteDeps["readPlayable"]>>["sources"],
            expiresAt: null as string | null,
            autoplay: false,
            muted: false,
          }
        : null,
    _playablePosterFileId: actual?.playable?.coverFileId ?? base._coverFileId,
    _playableId:
      actual?.ready && enabled && current?.previewChannels.includes("weapp")
        ? (actual.playable?.id ?? null)
        : null,
    alternatives: {
      canSaveToAlbum:
        ad.status !== "cancelled" &&
        !!current &&
        (current.previewChannels.includes("album") || !!fallback),
      canPreviewOnPortal: !!current && (current.previewChannels.includes("portal") || !!fallback),
      isOfflineSent: !!current?.offlineSentAt,
    },
    viewEvidence: { albumSavedAt: iso(e.albumSavedAt), portalViewedAt: iso(e.portalViewedAt) },
    confirmableVia:
      ad.status !== "pending_confirm"
        ? []
        : ["weapp", "album", "portal", "wecom"].filter(
            (c) =>
              current?.previewChannels.includes(c) &&
              (c !== "weapp" ||
                (enabled
                  ? actual?.ready && actual.playable
                  : e.albumSavedAt || e.portalViewedAt)) &&
              (c !== "album" || e.albumSavedAt) &&
              (c !== "portal" || e.portalViewedAt) &&
              (c !== "wecom" || current.offlineSentAt),
          ),
    versions: versions.map(versionView),
    revisions: revisions.map(revisionView),
    references: [...refs, ...profileRefs],
    floatingPlacements: base._related.floatingPlacements,
    relatedServiceTickets: base._related.relatedServiceTickets,
    timeline: [
      ...logs.map((log) => {
        const meta =
            log.meta && typeof log.meta === "object" && !Array.isArray(log.meta) ? log.meta : {},
          versionNo = typeof meta.versionNo === "number" ? meta.versionNo : null,
          r = revisions.find((r) => r.revisionNo === meta.revisionNo);
        const action = log.action.replace(/^ad\.status\./, "ad.");
        return {
          at: iso(log.createdAt),
          action,
          title: action === "ad.push_version" ? `第 ${versionNo} 版已上传` : titles[action]!,
          detail:
            action === "ad.submit"
              ? `${ad.type === "opening" ? "片头贴片" : "片尾贴片"} ${ad.durationSec} 秒，冻结 ${ad.chargePoints} 积分`
              : action === "ad.assign"
                ? `剪辑师${editor?.displayName ?? editor?.name ?? ""}，扣减 ${ad.chargePoints} 积分`
                : action === "ad.return"
                  ? (log.reasonText ?? ad.returnReason)
                  : action === "ad.confirm"
                    ? `第 ${versionNo} 版`
                    : action === "ad.push_version" &&
                        current?.versionNo === versionNo &&
                        current.decision === null
                      ? "待您确认"
                      : action === "ad.request_revision" && r
                        ? `${r.segmentIndex !== null ? `分段 ${r.segmentIndex}` : r.timeStartMs !== null ? `${r.timeStartMs}–${r.timeEndMs} 毫秒` : "整条广告"}：${r.note}${r.isChargeable ? `，扣减 ${r.chargePoints} 积分` : ""}`
                        : null,
          versionNo,
          actorType: log.actorType,
        };
      }),
      ...(cancelled && !logs.some((log) => log.action === "ad.status.cancel")
        ? [
            {
              at: cancelled.occurredAt.toISOString(),
              action: "ad.cancel",
              title: "已取消",
              detail: null,
              versionNo: null,
              actorType: cancelled.actorType,
            },
          ]
        : []),
    ],
  };
}
export async function signAdView<
  T extends {
    coverUrl: string | null;
    coverExpiresAt: string | null;
    _coverFileId: string | null;
    _related: unknown;
  },
>(deps: AdWriteDeps, actor: AdActor, value: T) {
  if (value._coverFileId) {
    const signed = await deps.media.signRead({ fileId: value._coverFileId });
    value.coverUrl = signed.url;
    value.coverExpiresAt = signed.expiresAt;
  }
  const { _coverFileId, _related, ...publicValue } = value;
  return publicValue;
}
