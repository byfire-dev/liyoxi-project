import { standingOf } from "../authz/index.js";
import type { MediaActor } from "../media/index.js";
import { AppError, merchantFactsOf } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { ProfileDeps, ProfileViewer } from "./context.js";
import { dictRef, snapshot } from "./repo.js";
import { instant } from "./views.js";

export function assetOverviewActor(viewer: ProfileViewer): MediaActor {
  return {
    identity: viewer.ctx,
    merchant: {
      entityId: viewer.membership.entityId,
      storeId: viewer.membership.storeId,
      standing: standingOf(viewer.membership.role, viewer.membership.storeMode),
    },
  };
}

export async function overview(tx: Tx, deps: ProfileDeps, viewer: ProfileViewer) {
  const s = await snapshot(tx, viewer.membership.storeId),
    p = s.profile;
  const now = deps.clock.now();
  const facts = await merchantFactsOf(deps.assembly).read(tx, {
    entityId: s.store.entityId,
    storeIds: [s.store.id],
    viewerRole: viewer.membership.role,
    merchantUserId: viewer.principal.merchantUserId,
    now,
  });
  const members = await deps.tenant.readStoreMembersBrief(tx, {
    entityId: s.store.entityId,
    storeId: s.store.id,
    now,
  });
  if (!members) throw new AppError("NOT_FOUND");
  const [basic, media, service, qualification] = s.completeness.steps;
  const docTypes = [];
  for (const doc of s.current?.qualificationDocs ?? [])
    docTypes.push({
      docType: doc.docType,
      permitType: await dictRef(tx, "permit_type", doc.permitType),
    });
  const ad = facts.ad.stores[s.store.id]!;
  return {
    viewerRole: "owner" as const,
    store: {
      storeId: s.store.id,
      name: s.store.name,
      isPrimary: s.store.isPrimary,
      qualificationStatus: s.store.qualificationStatus,
      isChangeInReview: s.open?.kind === "change" && s.open.submittedAt !== null,
      isFinalRejected: p?.finalRejectedAt != null,
      industry: await dictRef(tx, "industry", p?.industryCode),
      category: await dictRef(tx, "industry", p?.categoryCode),
    },
    entityName: s.store.entity.name,
    completeness: s.completeness,
    steps: {
      basic: { state: basic!.state },
      media: {
        state: media!.state,
        doorCount: s.media.filter((m) => m.mediaGroup === "door").length,
        interiorCount: s.media.filter((m) => m.mediaGroup === "interior").length,
        productCount: s.media.filter((m) => m.mediaGroup === "product").length,
        promoCount: s.media.filter((m) => m.mediaGroup === "promo").length,
      },
      service: {
        state: service!.state,
        serviceItemCount: s.services.length,
        sellingPointCount: p?.sellingPointCodes.length ?? 0,
        hasPromoText: !!p?.promoText,
      },
      qualification: { state: qualification!.state, docTypes },
    },
    qualification: {
      status: s.store.qualificationStatus,
      submittedAt: instant(s.open?.submittedAt),
      dueAt: instant(s.open?.approvalRequest?.dueAt),
      lastDecidedAt: instant(p?.lastDecidedAt),
    },
    members,
    assets: {
      total: facts.asset.stores[s.store.id]!.assetCount,
      recent7dCount: facts.asset.stores[s.store.id]!.recent7dCount ?? 0,
      recent: deps.media.assets
        ? await deps.media.assets.recent(tx, assetOverviewActor(viewer))
        : [],
    },
    ads: {
      confirmedCount: ad.readyCount,
      pendingConfirmCount: ad.pendingConfirmCount,
      producingCount: ad.producingCount,
      revisingCount: 0,
    },
  };
}
