import type { Sample } from "@liyoxi/db";
import { hasPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import type { Tx } from "../kernel/index.js";
import { staffBriefs } from "../staff/index.js";
import type { DeliveryDeps } from "./context.js";
import { iso, dateOf } from "./repo.js";
import type { TicketRow } from "./repo.js";
import { sampleEvidence } from "./samples.js";
import {
  isLegacySampleQuality,
  isLegacySampleRecoveryCandidate,
} from "./sample-legacy-recovery.js";
import type { AdsUsed, Slots } from "./samples.js";
import { qcView } from "./quality-views.js";
const brief = async (tx: Tx, id: string | null) =>
  id ? ((await staffBriefs(tx, [id]))[0] ?? null) : null;
export async function adminSampleView(
  tx: Tx,
  deps: DeliveryDeps,
  t: TicketRow,
  s: Sample,
  staff: StaffContext,
) {
  const actual = await deps.media.deliveryProductionFacts(tx, s.fileId);
  const production = await tx.productionRecord.findUnique({ where: { fileId: s.fileId } }),
    check = await tx.mediaCheck.findUnique({ where: { fileId: s.fileId } }),
    p = await tx.playableAsset.findFirst({
      where: {
        kind: "sample",
        sourceFileId: s.fileId,
        ownerType: "order_item",
        ownerId: t.orderItemId,
        entityId: t.entityId,
        storeId: t.storeId,
      },
      orderBy: { specVersion: "desc" },
    }),
    qc = s.qcRecordId ? await tx.qcRecord.findUnique({ where: { id: s.qcRecordId } }) : null;
  const ads = await tx.ad.findMany({
    where: {
      id: { in: (s.adVersionsUsed as AdsUsed).map((a) => a.adId) },
      entityId: t.entityId,
      storeId: t.storeId,
    },
  });
  const actions: string[] = [];
  if (!t.pauseCount && t.step === "sample_making") {
    if (
      s.status === "uploaded" &&
      actual.ready &&
      s.uploadedByStaffId !== staff.staff.id &&
      hasPermission(staff, "delivery.sample.qc")
    )
      actions.push("inspect");
    if (
      s.status === "qc_passed" &&
      actual.ready &&
      actual.playable &&
      hasPermission(staff, "delivery.sample.push") &&
      (await deps.samplePlayback?.(t.entityId))
    )
      actions.push("push");
  }
  if (
    isLegacySampleRecoveryCandidate(t, s) &&
    actual.ready &&
    actual.playable &&
    isLegacySampleQuality(qc, t, s) &&
    s.uploadedByStaffId !== staff.staff.id &&
    hasPermission(staff, "delivery.sample.push") &&
    hasPermission(staff, "delivery.sample.qc") &&
    (await deps.samplePlayback?.(t.entityId))
  ) {
    const latest = await tx.sample.findFirst({
      where: { deliveryTicketId: t.id },
      orderBy: { versionNo: "desc" },
      select: { id: true },
    });
    if (
      latest?.id === s.id &&
      t.orderItem.orderItemPlacements.every((placement) => {
        const used = (s.adVersionsUsed as AdsUsed).find(
            (ad) => ad.slot === placement.slot && ad.adId === placement.adId,
          ),
          ad = ads.find((row) => row.id === placement.adId);
        return used && ad?.status === "confirmed" && ad.confirmedVersionNo === used.versionNo;
      })
    )
      actions.push("recover_legacy");
  }
  return {
    sampleId: s.id,
    deliveryTicketId: t.id,
    versionNo: s.versionNo,
    status: s.status,
    fileId: s.fileId,
    durationMs: s.durationMs,
    adSlots: s.adSlots as Slots,
    adsUsed: (s.adVersionsUsed as AdsUsed).flatMap((a) => {
      const ad = ads.find((r) => r.id === a.adId);
      return ad
        ? [
            {
              ...a,
              adNo: ad.adNo,
              isCurrentConfirmed:
                ad.status === "confirmed" && ad.confirmedVersionNo === a.versionNo,
            },
          ]
        : [];
    }),
    uploadedBy: (await brief(tx, s.uploadedByStaffId))!,
    uploadedAt: iso(s.uploadedAt)!,
    production: production
      ? {
          pipelineState: production.pipelineState,
          gate: check?.gate ?? null,
          softWarnCount: Array.isArray(check?.soft) ? check.soft.length : 0,
          aigcState: production.aigcState,
        }
      : null,
    qc: await qcView(tx, qc),
    pushedBy: await brief(tx, s.pushedByStaffId),
    pushedAt: iso(s.pushedAt),
    previewChannels: s.previewChannels,
    offlineSentAt: iso(s.offlineSentAt),
    offlineSentBy: await brief(tx, s.offlineSentByStaffId),
    firstViewedAt: iso(s.firstViewedAt),
    viewedAckAt: iso(s.viewedAckAt),
    decision: s.decidedAt
      ? {
          decidedAt: iso(s.decidedAt)!,
          decideClient: s.decideClient!,
          decidedByName: s.decidedByUserId
            ? ((
                await tx.entityMember.findFirst({
                  where: { entityId: t.entityId, merchantUserId: s.decidedByUserId },
                })
              )?.displayName ?? null)
            : null,
          onBehalfBy: await brief(tx, s.onBehalfStaffId),
          viewedVia: s.confirmViewedVia,
          feedbackKind: s.feedbackKind,
          feedbackNote: s.feedbackNote,
          feedbackTimeMs: s.feedbackTimeMs,
          feedbackImages: s.feedbackFileIds.map((fileId) => ({
            fileId,
            url: null,
            expiresAt: null,
          })),
        }
      : null,
    confirmDueRemindAt: s.pushedAt
      ? new Date(s.pushedAt.getTime() + 2 * 86400000).toISOString()
      : null,
    watermark: p
      ? {
          playableAssetId: p.id,
          state: p.state,
          fileId:
            p.state === "ready"
              ? ((p.renditions as Array<{ fileId: string }>)[0]?.fileId ?? null)
              : null,
        }
      : null,
    preview: null,
    actions,
  };
}
export async function merchantSampleView(tx: Tx, deps: DeliveryDeps, t: TicketRow, s: Sample) {
  const e = await sampleEvidence(tx, deps, t, s),
    qc = s.qcRecordId ? await tx.qcRecord.findUnique({ where: { id: s.qcRecordId } }) : null,
    q = await qcView(tx, qc);
  const p = e.production.playable,
    info = await tx.mediaInfo.findUnique({ where: { fileId: s.fileId } });
  // 地址在事务结束后签；传给签发器的内部 file id 不放入返回 DTO。
  return {
    view: {
      sampleId: s.id,
      orderItemId: t.orderItemId,
      dramaTitle: (t.orderItem.dramaSnapshot as { title: string }).title,
      versionNo: s.versionNo,
      status: s.status,
      durationMs: s.durationMs,
      pushedAt: iso(s.pushedAt)!,
      previewChannels: s.previewChannels,
      adSlots: s.adSlots as Slots,
      adsUsed: s.adVersionsUsed as AdsUsed,
      qcSummary:
        q?.items
          .filter((i) => i.merchantVisible)
          .map(({ key, label, result, note }) => ({ key, label, result, note })) ?? [],
      firstViewedAt: iso(s.firstViewedAt),
      viewEvidence: { albumSavedAt: iso(e.album), portalViewedAt: iso(e.portal) },
      offlineSentAt: iso(s.offlineSentAt),
      confirmableVia:
        s.status === "pushed" && t.step === "sample_confirm" && !t.pauseCount ? e.possible : [],
      viewedAckAt: iso(s.viewedAckAt),
      decision: s.decidedAt
        ? {
            decidedAt: iso(s.decidedAt)!,
            viewedVia: s.confirmViewedVia,
            feedbackKind: s.feedbackKind,
            feedbackNote: s.feedbackNote,
            feedbackImages: s.feedbackFileIds.map((fileId) => ({
              fileId,
              url: null,
              expiresAt: null,
            })),
            isOnBehalf: !!s.onBehalfStaffId,
          }
        : null,
      playable: p
        ? {
            playableId: p.id,
            kind: "sample" as const,
            durationMs: p.durationMs,
            width: p.width,
            height: p.height,
            posterUrl: null as string | null,
            sources: [] as Array<{
              quality: string;
              url: string;
              width: number;
              height: number;
              bitrateKbps: number | null;
            }>,
            expiresAt: null as string | null,
            autoplay: false,
            muted: false,
          }
        : null,
      ticketStep: t.step,
      isPaused: t.pauseCount > 0,
      sampleRoundNo: t.sampleRoundNo,
      agreedLaunchDate: dateOf(t.orderItem.agreedLaunchDate),
      actions:
        s.status === "pushed" && t.step === "sample_confirm" && !t.pauseCount && e.possible.length
          ? ["confirm"]
          : [],
    },
    files: {
      poster: p?.coverFileId ?? info?.coverFileId ?? null,
      renditions:
        p && e.possible.includes("weapp")
          ? (p.renditions as Array<{
              fileId: string;
              quality: string;
              width: number | null;
              height: number | null;
              bitrateKbps: number | null;
            }>)
          : [],
    },
  };
}
export async function signMerchantSample(
  deps: DeliveryDeps,
  result: Awaited<ReturnType<typeof merchantSampleView>>,
) {
  const { view, files } = result;
  if (view.playable) {
    if (files.poster)
      view.playable.posterUrl = (
        await deps.media.signRead({ fileId: files.poster, audience: "merchant" })
      ).url;
    for (const r of files.renditions) {
      // 商家仅签真实水印任务完成且读回验证的 rendition。
      if (r.width === null || r.height === null) continue;
      const s = await deps.media.signRead({ fileId: r.fileId, audience: "merchant" });
      view.playable.sources.push({
        quality: r.quality,
        url: s.url,
        width: r.width,
        height: r.height,
        bitrateKbps: r.bitrateKbps,
      });
      view.playable.expiresAt = s.expiresAt;
    }
  }
  if (view.decision)
    for (const img of view.decision.feedbackImages)
      Object.assign(img, await deps.media.signRead({ fileId: img.fileId, audience: "merchant" }));
  return view;
}

/** 签名 IO 在业务事务结束后；缓存中的 preview 保持 null。 */
export async function signAdminSample(
  deps: DeliveryDeps,
  view: Awaited<ReturnType<typeof adminSampleView>>,
) {
  const signed = await deps.media.signRead({ fileId: view.fileId, audience: "staff" });
  return { ...view, preview: { ...signed, posterUrl: null } };
}
