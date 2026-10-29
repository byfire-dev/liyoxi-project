import {
  MaterialDownloadResultSchema,
  MaterialListSchema,
  PlanContentSchema,
} from "@liyoxi/contract";
import type { MaterialDownloadBody } from "@liyoxi/contract";
import type { readMaterialAdVersions } from "../ad/index.js";
import { UPLOAD_CATEGORIES } from "@liyoxi/shared/uploads";
import { assertAccess, assertPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import type { readMaterialMasters } from "../content/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx, TxRunner } from "../kernel/index.js";
import {
  checkoutMaterialMaster,
  readMaterialAssetFacts,
  readMaterialCheckouts,
  readMaterialFileFacts,
  readOrderAssetReferences,
  readOrderReferenceFileIds,
} from "../media/index.js";
import type { Media } from "../media/index.js";
import type { readMaterialProfile } from "../profile/index.js";
import { downloadRecords } from "./download-records.js";
import { lifecycleAudit } from "./lifecycle-audit.js";
import { ticketOf } from "./repo.js";

export interface ProductionMaterialsDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly media: Pick<Media, "signMaterialDownload" | "adProductionFacts">;
  readonly readMasters: typeof readMaterialMasters;
  readonly readProfile: typeof readMaterialProfile;
  readonly readAdVersions: typeof readMaterialAdVersions;
}
const unavailable = (kind: MaterialDownloadBody["kind"], reason: string): never => {
  throw new AppError("MATERIAL_NOT_AVAILABLE", { details: { kind, reason } });
};
function authorize(ctx: IdentityContext, staff: StaffContext) {
  if (ctx.actor.type !== "staff" || ctx.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  assertAccess(staff, { module: { module: "delivery", need: "view" }, permission: null });
}

interface AdPlacementFact {
  slot: string;
  adId: string;
  boundVersionNo: number | null;
  ad: {
    id: string;
    entityId: string;
    storeId: string;
    adNo: string;
    confirmedVersionNo: number | null;
    status: string;
    copy: string | null;
  };
}
interface AdVersionFact {
  id: string;
  adId: string;
  entityId: string;
  storeId: string;
  versionNo: number;
  decision: string | null;
  durationMs: number;
  fileId: string;
}
/** Persisted owner facts in, actual used versions out. This does not confer upload/confirm readiness. */
export function selectMaterialAdVersions(input: {
  entityId: string;
  storeId: string;
  placements: readonly AdPlacementFact[];
  versions: readonly AdVersionFact[];
}) {
  return input.placements
    .flatMap((p) => {
      const versionNo = p.boundVersionNo ?? p.ad.confirmedVersionNo;
      if (
        versionNo === null ||
        p.ad.id !== p.adId ||
        p.ad.entityId !== input.entityId ||
        p.ad.storeId !== input.storeId ||
        p.ad.status === "cancelled"
      )
        return [];
      const v = input.versions.find(
        (v) =>
          v.adId === p.adId &&
          v.versionNo === versionNo &&
          v.entityId === input.entityId &&
          v.storeId === input.storeId &&
          (v.decision === "confirmed" ||
            (p.boundVersionNo !== null && v.decision === "superseded")),
      );
      return v
        ? [
            {
              slot: p.slot,
              adId: p.adId,
              adNo: p.ad.adNo,
              adVersionId: v.id,
              versionNo,
              durationMs: v.durationMs,
              copy: p.ad.copy,
              fileId: v.fileId,
            },
          ]
        : [];
    })
    .sort((a, b) => a.slot.localeCompare(b.slot));
}

async function collection(tx: Tx, deps: ProductionMaterialsDeps, staff: StaffContext, id: string) {
  const t = await ticketOf(tx, id, staff);
  if (
    t.orderItem.entityId !== t.entityId ||
    t.orderItem.storeId !== t.storeId ||
    t.orderItem.dramaOrderId !== t.dramaOrderId ||
    t.dramaOrder.entityId !== t.entityId ||
    t.dramaOrder.storeId !== t.storeId
  )
    throw new AppError("NOT_FOUND");
  const plan = t.dramaOrder.deliveryPlan;
  const confirmed = plan?.deliveryPlanVersions.find(
    (v) => v.versionNo === plan.confirmedVersionNo && v.decision === "confirmed",
  );
  const referenceIds = confirmed
    ? PlanContentSchema.parse(confirmed.contentSnapshot).referenceAssetIds
    : [];
  const [masters, assets, profileIds] = await Promise.all([
    deps.readMasters(tx, { dramaId: t.dramaId, episodeCount: t.orderItem.episodeCount }),
    readMaterialAssetFacts(tx, {
      entityId: t.entityId,
      storeId: t.storeId,
      ids: referenceIds.length ? referenceIds : await readOrderAssetReferences(tx, t.dramaOrderId),
    }),
    readOrderReferenceFileIds(tx, {
      orderId: t.dramaOrderId,
      entityId: t.entityId,
      storeId: t.storeId,
    }),
  ]);
  const profileFacts = await deps.readProfile(tx, {
    entityId: t.entityId,
    storeId: t.storeId,
    fileIds: profileIds,
  });
  const profile = {
    ...profileFacts,
    media: [...new Map(profileFacts.media.map((m) => [m.fileId, m])).values()],
  };
  const versions = await deps.readAdVersions(
    tx,
    t.orderItem.orderItemPlacements.map((p) => ({
      adId: p.adId,
      versionNo: p.boundVersionNo ?? p.ad.confirmedVersionNo ?? 0,
    })),
  );
  const ads = selectMaterialAdVersions({
    entityId: t.entityId,
    storeId: t.storeId,
    placements: t.orderItem.orderItemPlacements,
    versions,
  });
  const files = await readMaterialFileFacts(tx, [
    ...masters.map((m) => m.fileId),
    ...ads.map((a) => a.fileId),
    ...assets.flatMap((a) => a.storeAssetFiles.map((f) => f.fileId)),
    ...profile.media.map((m) => m.fileId),
  ]);
  return {
    t,
    masters,
    ads,
    assets,
    profile,
    files,
    confirmedVersionNo: confirmed?.versionNo ?? null,
  };
}
type Collection = Awaited<ReturnType<typeof collection>>;
type MaterialFile = Collection["files"][number];
function usable(c: Collection, fileId: string, kind: MaterialDownloadBody["kind"]) {
  const file = c.files.find((f) => f.id === fileId);
  // A copied target row retains the original file's store. Ownership comes from the
  // current order's target-store collection, including copies of copies.
  const targetOwnsFile =
    kind === "profile_media"
      ? c.profile.media.some((m) => m.fileId === fileId)
      : kind === "store_asset" &&
        c.assets.some((a) => a.storeAssetFiles.some((f) => f.fileId === fileId));
  if (
    !file ||
    file.status !== "stored" ||
    file.moderationState === "block" ||
    file.deletedAt ||
    file.erasedAt ||
    file.sizeBytes === null ||
    (kind === "master"
      ? file.category !== "drama_master" || file.scopeType !== "platform"
      : file.entityId !== c.t.entityId ||
        (file.storeId !== c.t.storeId &&
          !(
            kind !== "ad_version" &&
            targetOwnsFile &&
            UPLOAD_CATEGORIES[file.category as keyof typeof UPLOAD_CATEGORIES]?.crossStore
          ))) ||
    (kind === "ad_version" && file.category !== "ad_video") ||
    (kind === "store_asset" && file.category !== "store_asset") ||
    (kind === "profile_media" &&
      !["profile_image", "profile_video", "profile_promo"].includes(file.category)) ||
    (kind === "ad_version" && file.productionRecord?.pipelineState !== "ready")
  )
    return unavailable(kind, "file_unavailable");
  return file;
}
function select(c: Collection, body: MaterialDownloadBody) {
  const items: Array<{
    kind: MaterialDownloadBody["kind"];
    episodeNo: number | null;
    file: MaterialFile;
    fileName: string;
    masterId: string | null;
  }> = [];
  const add = (
    fileId: string,
    episodeNo: number | null,
    masterId: string | null,
    name?: string,
  ) => {
    const file = usable(c, fileId, body.kind);
    items.push({
      kind: body.kind,
      episodeNo,
      file,
      fileName: name ?? file.originalName ?? `${file.id}.${file.ext}`,
      masterId,
    });
  };
  if (body.kind === "master") {
    if (
      body.episodeNos.length < 1 ||
      body.episodeNos.length > 50 ||
      new Set(body.episodeNos).size !== body.episodeNos.length ||
      body.episodeNos.some((n) => !Number.isInteger(n) || n < 1 || n > c.t.orderItem.episodeCount)
    )
      throw new AppError("VALIDATION_FAILED");
    for (const episodeNo of body.episodeNos) {
      const master = c.masters.find((m) => m.episodeNo === episodeNo);
      if (!master) return unavailable(body.kind, "master_not_ready");
      const title = (c.t.orderItem.dramaSnapshot as { title: string }).title;
      add(
        master.fileId,
        episodeNo,
        master.id,
        `${title}_第${String(episodeNo).padStart(2, "0")}集_原片.mp4`,
      );
    }
  } else if (body.kind === "ad_version") {
    const ad = c.ads.find((a) => a.adVersionId === body.adVersionId);
    if (!ad) return unavailable(body.kind, "ad_version_not_used");
    add(ad.fileId, null, null);
  } else if (body.kind === "store_asset") {
    const asset = c.assets.find((a) => a.id === body.storeAssetId);
    if (
      !asset ||
      asset.deletedAt ||
      asset.moderationState === "block" ||
      !asset.storeAssetFiles.length
    )
      return unavailable(body.kind, "asset_unavailable");
    for (const file of asset.storeAssetFiles) add(file.fileId, null, null);
  } else {
    if (!c.profile.media.some((m) => m.fileId === body.fileId))
      return unavailable(body.kind, "profile_media_not_referenced");
    add(body.fileId, null, null);
  }
  return items;
}
function fingerprint(c: Collection, body: MaterialDownloadBody) {
  return JSON.stringify(
    {
      owner: [
        c.t.id,
        c.t.orderItemId,
        c.t.dramaOrderId,
        c.t.dramaId,
        c.t.entityId,
        c.t.storeId,
        c.t.editorId,
        c.t.publisherId,
        c.t.deliveryManagerId,
        c.t.step,
        c.t.orderItem.episodeCount,
        c.t.dramaOrder.deliveryPlan?.id,
        c.confirmedVersionNo,
      ],
      selected: select(c, body),
      source:
        body.kind === "ad_version"
          ? c.ads
          : body.kind === "store_asset"
            ? c.assets
            : body.kind === "profile_media"
              ? c.profile.media
              : c.masters,
    },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
}

async function assertProductionReady(
  tx: Tx,
  deps: ProductionMaterialsDeps,
  c: Collection,
  body: MaterialDownloadBody,
) {
  if (body.kind !== "ad_version") return;
  const ad = c.ads.find((a) => a.adVersionId === body.adVersionId);
  if (!ad) return unavailable(body.kind, "ad_version_not_used");
  const facts = await deps.media.adProductionFacts(tx, ad.fileId);
  if (
    !facts.ready ||
    facts.production?.kind !== "ad" ||
    facts.production.adId !== ad.adId ||
    facts.file.entityId !== c.t.entityId ||
    facts.file.storeId !== c.t.storeId
  )
    unavailable(body.kind, "production_not_ready");
}

export function createProductionMaterials(deps: ProductionMaterialsDeps) {
  return {
    list: async (ctx: IdentityContext, staff: StaffContext, id: string) => {
      authorize(ctx, staff);
      return deps.tx.run(async (tx) => {
        const c = await collection(tx, deps, staff, id);
        const checkouts = await readMaterialCheckouts(tx, {
          orderItemId: c.t.orderItemId,
          staffId: staff.staff.id,
        });
        return MaterialListSchema.parse({
          masters: c.masters.map((m) => {
            const last = checkouts.find((r) => r.episodeNo === m.episodeNo);
            return {
              episodeNo: m.episodeNo,
              dramaEpisodeMasterId: m.id,
              revNo: m.revNo,
              durationMs: m.durationMs,
              sizeBytes: usable(c, m.fileId, "master").sizeBytes!.toString(),
              myLastCheckout: last
                ? {
                    checkedOutAt: last.checkedOutAt.toISOString(),
                    checkoutCount: last.checkoutCount,
                    dramaEpisodeMasterId: last.dramaEpisodeMasterId,
                  }
                : null,
            };
          }),
          ads: c.ads.map(({ fileId: _fileId, ...ad }) => ad),
          storeAssets: c.assets
            .filter((a) => !a.deletedAt)
            .map((a) => ({
              storeAssetId: a.id,
              type: a.type,
              title: a.title,
              usability: a.usability,
            })),
          profileMedia: c.profile.media.map((m) => ({
            fileId: m.fileId,
            source: "profile_media",
            storeAssetId: null,
            title: null,
            usability: null,
            mediaGroup: m.mediaGroup,
            type: m.mediaKind,
            thumbnail: null,
          })),
          profileText: c.profile.text,
        });
      });
    },
    downloadUrls: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: MaterialDownloadBody,
    ) => {
      authorize(ctx, staff);
      assertPermission(staff, "delivery.download", deps.clock.now());
      const initial = await deps.tx.run(async (tx) => {
        const c = await collection(tx, deps, staff, id);
        select(c, body);
        await assertProductionReady(tx, deps, c, body);
        return c;
      });
      const selected = select(initial, body),
        before = fingerprint(initial, body);
      const signed = await Promise.all(
        selected.map((item) =>
          deps.media.signMaterialDownload({
            fileId: item.file.id,
            fileName: item.fileName,
          }),
        ),
      );
      await deps.tx.run(async (tx) => {
        // These owner locks also protect current-master, placement and confirmed-plan pointers.
        await lockRows(tx, "store", [initial.t.storeId], "share");
        await lockRows(tx, "store_profile", [initial.t.storeId], "share");
        await lockRows(tx, "drama", [initial.t.dramaId], "share");
        await lockRows(
          tx,
          "ad",
          initial.t.orderItem.orderItemPlacements.map((p) => p.adId),
          "share",
        );
        await lockRows(tx, "drama_order", [initial.t.dramaOrderId], "share");
        await lockRows(tx, "order_item", [initial.t.orderItemId], "share");
        await lockRows(tx, "delivery_ticket", [id], "share");
        if (initial.t.dramaOrder.deliveryPlan)
          await lockRows(tx, "delivery_plan", [initial.t.dramaOrder.deliveryPlan.id], "share");
        await lockRows(
          tx,
          "production_record",
          selected.map((s) => s.file.id),
          "share",
        );
        await lockRows(
          tx,
          "store_asset",
          initial.assets.map((a) => a.id),
          "share",
        );
        await lockRows(
          tx,
          "file_object",
          selected.map((s) => s.file.id),
          "share",
        );
        const current = await collection(tx, deps, staff, id);
        if (before !== fingerprint(current, body)) unavailable(body.kind, "material_changed");
        await assertProductionReady(tx, deps, current, body);
        const now = deps.clock.now();
        if (signed.some((s) => new Date(s.expiresAt) <= now))
          unavailable(body.kind, "signature_expired");
        // A caller may request [2,1], but the composite checkout rows always lock by episode.
        const auditOrder =
          body.kind === "master"
            ? [...selected].sort((a, b) => a.episodeNo! - b.episodeNo!)
            : selected;
        for (const item of auditOrder) {
          if (item.masterId)
            await checkoutMaterialMaster(tx, {
              orderItemId: current.t.orderItemId,
              episodeNo: item.episodeNo!,
              staffId: staff.staff.id,
              dramaEpisodeMasterId: item.masterId,
              now,
            });
          await lifecycleAudit(tx, ctx, {
            stream: "access",
            category: "file_access",
            action: "files.url.sign",
            summary: "签发制作素材下载地址",
            target: { type: "file_object", id: item.file.id },
            entityId: current.t.entityId,
            storeId: current.t.storeId,
            meta: {
              fileCategory: item.file.category,
              urlTtlSec: 1800,
              purpose: "production_material",
              deliveryTicketId: id,
              orderItemId: current.t.orderItemId,
              kind: body.kind,
            },
          });
        }
      });
      return MaterialDownloadResultSchema.parse({
        items: selected.map((item, i) => ({
          kind: item.kind,
          episodeNo: item.episodeNo,
          fileId: item.file.id,
          fileName: item.fileName,
          sizeBytes: item.file.sizeBytes!.toString(),
          ...signed[i],
        })),
      });
    },
    downloadRecords: (
      ctx: IdentityContext,
      staff: StaffContext,
      orderItemId: string,
      query: Parameters<typeof downloadRecords>[4],
    ) => {
      authorize(ctx, staff);
      return deps.tx.run((tx) => downloadRecords(tx, deps.clock.now(), staff, orderItemId, query));
    },
  };
}
export type ProductionMaterials = ReturnType<typeof createProductionMaterials>;
