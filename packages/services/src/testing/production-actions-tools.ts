import type { PrismaClient } from "@liyoxi/db";
import { readProductionMasterVersion } from "../content/index.js";
import { createEvents } from "../events/index.js";
import {
  AppError,
  createIdentityContext,
  createTxRunner,
  defineRegistration,
  implementKeyed,
  uuidv7,
} from "../kernel/index.js";
import { createRuntimeMediaProduction, requireRuntimeProductionAccess } from "../ops/index.js";
import { staffBriefs } from "../staff/index.js";
import { createMedia, declareManualProduction, fileCategoryGuardPort } from "../media/index.js";
import type { FileCategoryGuard, MediaActor } from "../media/index.js";
import { assembleForTest } from "./assembly.js";
import { createClock } from "./clock.js";
import {
  createDeliveryProductionTools,
  prepareDeliveryMasterForTest,
} from "./delivery-production-tools.js";
import { createFactories } from "./data/factories/index.js";
import { createFakeProviders } from "./providers/index.js";
import { sampleStaffContext } from "./approval.js";
import { AdPricingSnapshotSchema } from "@liyoxi/contract";
import { createLedgerHarness, openTerm } from "./billing.js";
import type { AdjustableClock } from "./clock.js";
import { failed, ok } from "../providers/types.js";

let adSequence = 50400;
/** Only an initial, nonterminal parent fixture; hold and capture use the real ledger. */
async function producingAd(
  db: PrismaClient,
  clock: AdjustableClock,
  staffId: string,
  adKind: "head" | "tail",
) {
  const billing = createLedgerHarness(db, { clock }),
    merchant = await billing.make.merchant({ verified: true }),
    { term } = await openTerm(billing, { entityId: merchant.entity.id }),
    id = uuidv7(),
    adNo = `GG20261030${++adSequence}`,
    identity = createIdentityContext({
      actor: { type: "system", job: "lyxtest.production_ad_parent" },
      entityId: merchant.entity.id,
    });
  const held = await billing.tx.run((tx) =>
    billing.ledger.hold(tx, {
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      refType: "ad",
      refId: id,
      pricing: { kind: "ad" },
      title: { code: "ad_hold", args: { adNo, unitPoints: 50, discountBp: term.discountBp } },
      ctx: identity,
    }),
  );
  await billing.tx.run((tx) =>
    billing.ledger.capture(tx, {
      pointHoldId: held.pointHoldId,
      title: { refType: "ad", refNo: adNo, count: 1 },
      ctx: identity,
    }),
  );
  const hold = await db.pointHold.findUniqueOrThrow({ where: { id: held.pointHoldId } }),
    price = AdPricingSnapshotSchema.parse(held.snapshot),
    consent = await billing.make.agreementConsent({
      scene: "ad_request",
      merchantUserId: merchant.user.id,
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      bizId: id,
    }),
    now = clock.now();
  return db.ad.create({
    data: {
      id,
      adNo,
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      requestedByUserId: merchant.user.id,
      type: adKind === "head" ? "opening" : "ending",
      durationSec: adKind === "head" ? 3 : 5,
      promoPointCodes: ["TEST"],
      status: "producing",
      unitPricePoints: price.unitPoints,
      discountBp: price.discountBp,
      chargePoints: held.points,
      pricingSnapshot: held.snapshot,
      pointHoldId: held.pointHoldId,
      capturedAt: hold.capturedAt,
      editorId: staffId,
      freeRevisionQuota: price.freeRevisions,
      agreementConsentId: consent.id,
      submittedAt: now,
      firstDueAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}

export async function createProductionActionsTools(
  db: PrismaClient,
  kind: "final" | "sample" | "ad" = "final",
  options: { adKind?: "head" | "tail"; durationMs?: number; skipInitialProbe?: boolean } = {},
) {
  const clock = createClock(),
    make = createFactories({ db, clock }),
    fake = createFakeProviders({ clock }),
    codec = createDeliveryProductionTools(fake),
    production = createRuntimeMediaProduction(codec.env, fake, {
      appEnv: "test",
      tools: codec.tools,
    }),
    tx = createTxRunner({ prisma: db, appEnv: "test" }),
    staff = await make.staff({ staffRoleKey: "super_admin" }),
    context = await sampleStaffContext(db, staff.id, { stepUpAt: clock.now() }),
    actor: MediaActor = {
      staff: context,
      identity: createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
    },
    ticket = await make.deliveryTicket({ step: "batch_compose", editorId: staff.id });
  let ruleVersion = 1,
    failProbe = false;
  const originalProbe = codec.tool.probe;
  codec.tool.probe = async (input) => {
    if (failProbe) return failed("rejected", "owned probe failure");
    const result = await originalProbe(input);
    if (!result.ok || options.durationMs === undefined) return result;
    return ok({
      ...result.value,
      format: { ...result.value.format, durationMs: options.durationMs },
      streams: result.value.streams.map((stream) => ({
        ...stream,
        durationMs: options.durationMs!,
        nbFrames:
          stream.codecType === "video" ? (options.durationMs! * 30) / 1000 : stream.nbFrames,
      })),
    });
  };
  const ad =
      kind === "ad" ? await producingAd(db, clock, staff.id, options.adKind ?? "head") : null,
    parent = ad
      ? { orderItemId: null, adId: ad.id }
      : { orderItemId: ticket.orderItemId, adId: null },
    owner = ad ?? ticket,
    category = kind === "ad" ? "ad_video" : kind === "final" ? "final_episode" : "sample_video";
  // Only the source-upload declaration fixture is replaced; availability and all media jobs
  // below use the real register/complete/promote/probe path and real parent scope reader.
  const guard: FileCategoryGuard = {
    assert: async (t, a, input) => {
      if (input.storeId !== owner.storeId) throw new AppError("NOT_FOUND");
      await requireRuntimeProductionAccess(t, a, parent);
    },
    registered: async (t, fileId) => {
      if (ad) {
        const now = clock.now();
        await t.productionRecord.create({
          data: {
            fileId,
            kind: "ad",
            adId: ad.id,
            source: "manual_upload",
            pipelineState: "uploading",
            aigcState: "not_required",
            aiUsage: {
              used: false,
              tools: [],
              declaredBy: staff.id,
              declaredAt: now.toISOString(),
              forcedByDrama: false,
            },
            uploadedByStaffId: staff.id,
            createdAt: now,
            updatedAt: now,
          },
        });
        return;
      }
      await declareManualProduction(t, clock, {
        fileId,
        kind: kind === "sample" ? "sample" : "final",
        orderItemId: ticket.orderItemId,
        episodeNo: 1,
        entityId: ticket.entityId,
        storeId: ticket.storeId,
        productionTier: "standard",
        uploadedByStaffId: staff.id,
        forcedByDrama: false,
        dramaEpisodeMasterId: masterId,
        aiUsage: { used: false, tools: [] },
      });
    },
  };
  const assembly = assembleForTest({
      entry: "api",
      extra: [
        defineRegistration("lyxtest_w504_upload", {
          portImplementations: [implementKeyed(fileCategoryGuardPort, category, guard)],
        }),
      ],
    }),
    events = createEvents({ tx, clock, assembly });
  const media = createMedia({
    tx,
    clock,
    assembly,
    events,
    storage: fake.storage,
    production: production.production
      ? {
          ...production.production,
          parameters: async (t) => ({
            ...(await production.production!.parameters(t)),
            ruleVersion,
          }),
        }
      : undefined,
    productionAccess: {
      require: requireRuntimeProductionAccess,
      master: readProductionMasterVersion,
      staff: async (t, id) => (await staffBriefs(t, [id]))[0] ?? null,
    },
  });
  const master =
    kind === "ad"
      ? null
      : await prepareDeliveryMasterForTest({ media, tx, clock, providers: fake }, db, {
          dramaId: ticket.dramaId,
          episodeNo: 1,
          staffId: staff.id,
        });
  const masterId = master?.id;
  const bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const uploadInput: Parameters<typeof media.register>[1] = {
    category,
    storeId: owner.storeId,
    production: { kind, ...parent, episodeNo: kind === "ad" ? undefined : 1 },
    files: [{ fileName: "source.mp4", sizeBytes: String(bytes.length), clientToken: uuidv7() }],
  };
  const entry = await (async () => {
    if (!ad) return (await media.register(actor, uploadInput)).items[0]!;
    // ad_video is deliberately absent from generic admin.register. Model only the
    // future owner's initial pending upload; every storage/check success stays real.
    const id = uuidv7(),
      key = `incoming/${id}/source.mp4`;
    await make.fileObject({
      id,
      category: "ad_video",
      bucket: "media",
      scopeType: "store",
      entityId: ad.entityId,
      storeId: ad.storeId,
      uploadActorType: "staff",
      uploadActorId: staff.id,
      uploadClient: "admin",
      status: "pending",
      uploadMode: "post",
      incomingBucket: "media",
      incomingKey: key,
      declaredSize: bytes.length,
      declaredMime: "video/mp4",
      ext: "mp4",
      originalName: "source.mp4",
      sizeBytes: null,
      mime: null,
      etag: null,
      sha256: null,
      storedAt: null,
      uploadExpiresAt: new Date(clock.now().getTime() + 600_000),
    });
    await tx.run(async (t) => {
      await guard.assert(t, actor, uploadInput);
      await guard.registered!(t, id, actor, uploadInput);
    });
    return { fileId: id, key };
  })();
  const initial = await db.productionRecord.findUniqueOrThrow({ where: { fileId: entry.fileId } });
  fake.storage.put({ bucket: "media", key: entry.key }, bytes, "video/mp4");
  await media.completeAdmin(actor, entry.fileId);
  const promote = await db.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${entry.fileId}` },
  });
  await media.jobs.run({ jobId: promote.id });
  const probe = await tx.run((t) => media.enqueueProbe(t, entry.fileId));
  if (!options.skipInitialProbe) await media.jobs.run({ jobId: probe });
  const source = await db.productionRecord.findUniqueOrThrow({ where: { fileId: entry.fileId } });
  return {
    clock,
    make,
    fake,
    codec,
    tx,
    media,
    actor,
    ticket,
    source,
    master,
    ad,
    initial,
    probe,
    setProbeFailure: (value: boolean) => {
      failProbe = value;
    },
    close: async () => {
      await media.jobs.shutdown();
      await production.close();
    },
    setRuleVersion: (value: number) => {
      ruleVersion = value;
    },
  };
}
