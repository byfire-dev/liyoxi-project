import { createHash } from "node:crypto";
import type { PrismaClient } from "@liyoxi/db";
import type { Clock } from "../../kernel/index.js";
import type { Runtime } from "../../runtime.js";
import type { Keyring } from "../../security/index.js";
import { createLedgerHarness, openTerm } from "../billing.js";
import { createFactories } from "../data/factories/index.js";
import { fakeUscc } from "../data/factories/context.js";
import { sealerOf } from "../data/seal.js";
import { createDeliveryProductionTools } from "../delivery-production-tools.js";
import { loadM5AdMedia } from "../m5-media.js";
import { prepareOrderAgreement, prepareOrderDrama, prepareOrderProfile } from "../order.fixture.js";
import type { FakeProviders } from "../providers/index.js";
import { preparePortalPreviewAd } from "./preview-ads.js";
import { preparePortalPreviewLicense } from "./preview-license.js";
import { createPortalPreviewMedia } from "./preview-media.js";
import { assertPreviewScopes, previewOwner } from "./preview-scope.js";
import type {
  PortalLivePreviewAction,
  PortalLivePreviewFacts,
  PortalLivePreviewScopes,
} from "./preview-types.js";

/** Constructed once, before the original runtime; reading the SHA-bound fixture remains lazy. */
export function createPortalPreviewTools(input: {
  providers: FakeProviders;
  clock: Clock;
  runId: string;
  portalOrigin: string;
}) {
  let source: Awaited<ReturnType<typeof loadM5AdMedia>> | undefined;
  const transport = createPortalPreviewMedia({ ...input, storage: input.providers.storage });
  const codec = createDeliveryProductionTools(input.providers, (bytes) => {
    if (!source || createHash("sha256").update(bytes).digest("hex") !== source.video.sha256)
      throw new Error("PREVIEW_MEDIA_PROOF_MISMATCH");
    return source.report;
  });
  return {
    transport,
    codec,
    async load() {
      return (source ??= await loadM5AdMedia());
    },
  };
}

export function createPortalPreview(input: {
  db: PrismaClient;
  runtime: Runtime;
  clock: Clock;
  keyring: Keyring;
  tools: ReturnType<typeof createPortalPreviewTools>;
  providers: FakeProviders;
  expireMedia(): void;
  enableReadTables(): void;
}) {
  const { db, runtime: r, clock, tools } = input;
  const seal = sealerOf(input.keyring),
    make = createFactories({ db, clock, seal });
  let closed = false,
    scopeKey: string | undefined;
  let preparing: Promise<PortalLivePreviewFacts> | undefined;
  let active: Promise<PortalLivePreviewFacts> | undefined;
  let ad: Awaited<ReturnType<typeof preparePortalPreviewAd>> | undefined;
  let license: Awaited<ReturnType<typeof preparePortalPreviewLicense>> | undefined;
  const assertOpen = () => {
    if (closed) throw new Error("PREVIEW_CLOSED");
  };
  const facts = async (): Promise<PortalLivePreviewFacts> => {
    assertOpen();
    if (!ad || !license) throw new Error("PREVIEW_NOT_PREPARED");
    const value = ad.facts();
    const playbackAuditCount = await db.auditLog.count({
      where: {
        action: "ad.version.portal_preview",
        targetId: {
          in: (
            await db.adVersion.findMany({
              where: { adId: value.adId },
              select: { id: true },
            })
          ).map((row) => row.id),
        },
      },
    });
    return { ad: value, license: await license.facts(), playbackAuditCount };
  };
  const prepare = async (scopes: PortalLivePreviewScopes) => {
    const actor = await previewOwner(db, clock, seal, scopes);
    assertOpen();
    const source = await tools.load();
    const uscc = seal.uscc("entity.uscc_enc", fakeUscc(800001));
    const now = clock.now();
    // Historical qualified profile and subscription are explicit inputs, not reconstructed auth.
    await db.entity.update({
      where: { id: actor.membership.entityId },
      data: {
        name: "电脑预览测试主体",
        entityType: "enterprise",
        verificationStatus: "verified",
        verifiedAt: now,
        usccEnc: uscc.enc,
        usccBidx: uscc.bidx,
        usccMask: uscc.mask,
        updatedAt: now,
      },
    });
    await db.store.update({
      where: { id: actor.membership.storeId },
      data: {
        name: "电脑预览测试门店",
        qualificationStatus: "verified",
        updatedAt: now,
      },
    });
    const fixedAdvance = () => {
      throw new Error("PREVIEW_CLOCK_ACTION_FORBIDDEN");
    };
    const h = {
      ...createLedgerHarness(db, {
        clock: { now: () => clock.now(), advance: fixedAdvance, set: fixedAdvance },
      }),
      make,
    };
    await prepareOrderProfile(db, h, actor);
    const { term } = await openTerm(h, { entityId: actor.membership.entityId, planCode: "pro" });
    const drama = await prepareOrderDrama(h);
    await db.dramaCopyright.update({
      where: { dramaId: drama.id },
      data: { territory: "中国大陆" },
    });
    await prepareOrderAgreement(h);
    assertOpen();
    ad = await preparePortalPreviewAd({
      db,
      runtime: r,
      clock,
      make,
      actor,
      storage: input.providers.storage,
      media: source,
      transport: tools.transport,
    });
    assertOpen();
    license = await preparePortalPreviewLicense({
      db,
      runtime: r,
      clock,
      make,
      keyring: input.keyring,
      ...scopes.owner,
      termId: term.id,
      dramaId: drama.id,
    });
    assertOpen();
    input.enableReadTables();
    return facts();
  };
  return {
    preparePreview(scopes: PortalLivePreviewScopes): Promise<PortalLivePreviewFacts> {
      assertOpen();
      assertPreviewScopes(scopes);
      const key = [scopes.owner, scopes.clerk, scopes.otherOwner]
        .map((scope) => [scope.merchantUserId, scope.entityId, scope.storeId].join(":"))
        .join("|");
      if (scopeKey && scopeKey !== key) throw new Error("PREVIEW_SCOPE_CHANGED");
      scopeKey = key;
      return (preparing ??= prepare(structuredClone(scopes)).catch(() => {
        throw new Error("PREVIEW_PREPARE_FAILED");
      }));
    },
    previewFacts: facts,
    previewAction(action: PortalLivePreviewAction): Promise<PortalLivePreviewFacts> {
      assertOpen();
      if (active || !ad || !license) throw new Error("PREVIEW_ACTION_UNAVAILABLE");
      const currentAd = ad,
        currentLicense = license;
      active = (async () => {
        switch (action) {
          case "push-ad-version":
            await currentAd.push();
            break;
          case "queue-license-correction":
            await currentLicense.queueCorrection();
            break;
          case "complete-license-correction":
            await currentLicense.completeCorrection();
            break;
          case "void-license":
            await currentLicense.void();
            break;
          case "expire-media-grants":
            input.expireMedia();
            break;
          case "ad-channel-unavailable":
            await currentAd.channel(false);
            break;
          case "ad-channel-available":
            await currentAd.channel(true);
            break;
          default:
            throw new Error("PREVIEW_ACTION_INVALID");
        }
        return facts();
      })()
        .catch(() => {
          throw new Error("PREVIEW_ACTION_FAILED");
        })
        .finally(() => {
          active = undefined;
        });
      return active;
    },
    readPreviewMedia: tools.transport.read,
    async close() {
      closed = true;
      tools.transport.close();
      await Promise.allSettled([preparing, active]);
    },
  };
}
