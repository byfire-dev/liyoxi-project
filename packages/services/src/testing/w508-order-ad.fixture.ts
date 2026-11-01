import type { PrismaClient } from "@liyoxi/db";
import { ChecklistItemsSchema } from "@liyoxi/contract";
import type { AdminSampleRequestChangeBody } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { createDelivery, createDeliveryM5 } from "../delivery/index.js";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import { readAdOrderReferences, readAdPlacementDetails } from "../order/index.js";
import { createProfile } from "../profile/index.js";
import { createPublish } from "../publish/index.js";
import { createSla } from "../sla/index.js";
import { createTenant } from "../tenant/index.js";
import { sampleStaffContext } from "./approval.js";
import { prepareAdVideoForTest } from "./ad-video.fixture.js";
import { createFactories } from "./data/index.js";
import { TEST_KEYRING } from "./data/seal.js";
import { createLicenseConvergenceFixture } from "./license-convergence.fixture.js";
import {
  finishDeliveryProductionForTest,
  prepareDeliveryMasterForTest,
} from "./delivery-production-tools.js";

/** Fixed W5-08 acceptance chain. Initial identity/config inputs never substitute for a domain result. */
export async function createW508OrderAdFixture(
  prisma: PrismaClient,
  options: Parameters<typeof createLicenseConvergenceFixture>[1],
) {
  const f = await createLicenseConvergenceFixture(prisma, { ...options, withAdProduction: true });
  try {
    const r = f.runtime,
      make = createFactories({ db: prisma, clock: f.clock });
    const adminRow = await make.staff({ staffRoleKey: "super_admin" }),
      editorRow = await make.staff({ staffRoleKey: "editor" }),
      managerRow = await make.staff({ staffRoleKey: "delivery_manager" });
    const actor = async (id: string) => ({
      ctx: createIdentityContext({ actor: { type: "staff", id, client: "admin" } }),
      staff: await sampleStaffContext(prisma, id, { stepUpAt: f.clock.now() }),
    });
    const admin = await actor(adminRow.id),
      editor = await actor(editorRow.id);
    const common = {
      tx: r.tx,
      clock: f.clock,
      assembly: r.assembly,
      flow: r.flow,
      events: r.events,
    };
    const publish = createPublish({ ...common, approval: r.approval, media: r.media });
    const profile = createProfile({
      ...common,
      tenant: createTenant(common),
      approval: r.approval,
      media: r.media,
      keyring: () => TEST_KEYRING,
      wechat: f.providers.wechat,
      currentOpenid: async () => "lyxtest_w508_order_ad",
    });
    const deps = {
      ...common,
      media: r.media,
      approval: r.approval,
      profile,
      publish,
      sla: createSla({ clock: f.clock, assembly: r.assembly }),
      samplePlayback: (entityId: string) =>
        r.config.flags.isEnabled("weapp.video.sample.enabled", { entityId }),
      ensureLicenseReadiness: r.licenseLetters.ensureLicenseReadiness,
      adOrderReferences: readAdOrderReferences,
      reopenAdFree: r.ads.reopenFreeTx,
    };
    const delivery = createDelivery(deps),
      lifecycle = createDeliveryM5(deps);
    // This fixture exercises the documented album fallback; default embedded playback is A's separate target.
    for (const [key, value] of [
      ["weapp.video.ad.enabled", false],
      ["weapp.video.sample.enabled", true],
    ] as const)
      await prisma.featureFlag.upsert({
        where: { key },
        update: { defaultValue: value, rules: [] },
        create: {
          key,
          valueType: "bool",
          defaultValue: value,
          exposedTo: "client",
          createdAt: f.clock.now(),
          updatedAt: f.clock.now(),
        },
      });
    await r.config.cache.bump("flag");
    if (
      !(await prisma.agreementVersion.findFirst({
        where: { agreementKey: "ad_service", status: "active" },
      }))
    )
      await make.agreementVersion({ agreementKey: "ad_service" });
    const scope = { entityId: f.actor.membership.entityId, storeId: f.actor.membership.storeId };
    async function createAd() {
      const quote = await r.ads.quote(f.actor, { type: "opening" }),
        promo = await prisma.dictItem.findFirstOrThrow({
          where: { dictTypeKey: "ad_promo_point", isEnabled: true },
        }),
        option = quote.typeOptions.find((row) => row.type === "opening")!;
      return r.ads.create(f.actor, {
        type: "opening",
        durationSec: option.durationOptions[0]!,
        promoPointCodes: [promo.code],
        expectChargePoints: quote.chargePoints!,
        agreementVersionId: quote.agreement.agreementVersionId,
        isAgreementChecked: true,
      });
    }
    async function pushAd(adId: string) {
      const ad = await prisma.ad.findUniqueOrThrow({ where: { id: adId } });
      if (ad.status === "pending_assign")
        await r.tx.run((tx) => r.ads.production.assignTx(tx, admin, adId, editor.staff.staff.id));
      const video = await prepareAdVideoForTest(f, prisma, adId, editor),
        version = await r.tx.run((tx) =>
          r.ads.production.registerVersionTx(tx, editor, adId, video),
        );
      await r.tx.run((tx) => r.ads.production.pushVersionTx(tx, editor, version.adVersionId));
      return version;
    }
    async function confirmAd(adId: string, versionNo: number) {
      await r.ads.download(f.actor, adId, { versionNo });
      return r.ads.confirm(f.actor, adId, { versionNo, viewedVia: "album", hasViewed: true });
    }
    async function createBoundOrder(adId: string) {
      const quote = await r.order.quote(f.actor, {
        dramaIds: [f.dramaId],
        channelAccountIds: [...f.accounts],
        isTopModel: false,
      });
      const order = await r.order.create(f.actor, {
        dramaIds: [f.dramaId],
        channelAccountIds: [...f.accounts],
        focusCodes: ["W115F"],
        isTopModel: false,
        adIds: [adId],
        agreementVersionId: quote.agreement.agreementVersionId,
        expect: quote.expect,
      });
      const timer = await prisma.timer.findFirstOrThrow({
        where: { kind: "order.start", subjectId: order.orderId },
      });
      if (timer.fireAt > f.clock.now()) f.clock.set(timer.fireAt);
      const start = r.assembly.timerHandler("order.start")!;
      await r.tx.run((tx) =>
        start.handle(tx, {
          id: timer.id,
          kind: timer.kind,
          subjectType: timer.subjectType,
          subjectId: timer.subjectId,
          payload: timer.payload as Record<string, unknown>,
        }),
      );
      const ticket = await prisma.deliveryTicket.findFirstOrThrow({
        where: { dramaOrderId: order.orderId },
      });
      if (!ticket.deliveryManagerId)
        await delivery.assign(admin.ctx, admin.staff, ticket.id, { staffId: managerRow.id });
      await lifecycle.assignEditor(admin.ctx, admin.staff, ticket.id, {
        staffId: editor.staff.staff.id,
      });
      const plan = await prisma.deliveryPlan.findUniqueOrThrow({
        where: { dramaOrderId: order.orderId },
      });
      await delivery.replaceDraft(admin.ctx, admin.staff, plan.id, {
        draftLockVersion: plan.draftLockVersion,
        content: {
          focusCodes: ["W115F"],
          referenceAssetIds: [],
          launchMode: "merchant_self",
          note: "W508合法浮动引用",
          items: [
            {
              orderItemId: ticket.orderItemId,
              channelAccountIds: [...f.accounts],
              placements: [{ slot: "opening", adId }],
              agreedLaunchDate: addDays(calendarDate(f.clock.now()), 14),
              expectedDeliveryDate: null,
            },
          ],
        },
      });
      await delivery.push(admin.ctx, admin.staff, plan.id, {
        draftLockVersion: plan.draftLockVersion + 1,
      });
      await delivery.confirm(f.actor, plan.id, { versionNo: 1 });
      return { orderId: order.orderId, itemId: ticket.orderItemId, ticketId: ticket.id };
    }
    async function pushSample(target: Awaited<ReturnType<typeof createBoundOrder>>) {
      await prepareDeliveryMasterForTest(r, prisma, {
        dramaId: f.dramaId,
        episodeNo: 1,
        staffId: editor.staff.staff.id,
      });
      const bytes = new Uint8Array(1234);
      bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
      const mediaActor = { identity: editor.ctx, staff: editor.staff };
      const registered = await r.media.register(mediaActor, {
        category: "sample_video",
        storeId: scope.storeId,
        files: [
          { fileName: "W508-sample.mp4", sizeBytes: String(bytes.length), clientToken: uuidv7() },
        ],
        production: {
          kind: "sample",
          orderItemId: target.itemId,
          episodeNo: 1,
          aiUsage: { used: false, tools: [] },
        },
      });
      const fileId = registered.items[0]!.fileId,
        file = await prisma.fileObject.findUniqueOrThrow({ where: { id: fileId } });
      f.providers.storage.put({ bucket: "media", key: file.incomingKey! }, bytes, "video/mp4");
      await r.media.completeAdmin(mediaActor, fileId);
      const promote = await prisma.mediaJob.findUniqueOrThrow({
        where: { dedupeKey: `promote:${fileId}` },
      });
      await r.media.jobs.run({ jobId: promote.id });
      const placement = await prisma.orderItemPlacement.findFirstOrThrow({
        where: { orderItemId: target.itemId },
      });
      const created = await delivery.sampleCreate(editor.ctx, editor.staff, target.ticketId, {
        fileId,
        adSlots: [
          { slot: "opening", startMs: 0, endMs: placement.durationSec * 1000, label: "广告" },
        ],
      });
      await finishDeliveryProductionForTest(r, f.clock, fileId, true);
      const template = await prisma.checklistTemplate.findFirstOrThrow({
        where: { code: "qc.sample", status: "active" },
      });
      await delivery.sampleInspect(admin.ctx, admin.staff, created.sampleId, {
        checklistVersionNo: template.versionNo,
        results: ChecklistItemsSchema.parse(template.items).map(({ key }) => ({
          key,
          result: "pass",
        })),
      });
      await delivery.samplePush(admin.ctx, admin.staff, created.sampleId, {});
      return { sampleId: created.sampleId, versionNo: created.versionNo };
    }
    return {
      ...f,
      admin,
      editor,
      delivery,
      createAd,
      pushAd,
      confirmAd,
      createBoundOrder,
      pushSample,
      references: (adId: string) =>
        r.tx.run((tx) => readAdOrderReferences(tx, { ...scope, adIds: [adId] })),
      placementDetails: (adId: string) =>
        r.tx.run((tx) => readAdPlacementDetails(tx, { ...scope, adId })),
      feedback: (sampleId: string, body: AdminSampleRequestChangeBody) =>
        delivery.adminSampleRequestChange(admin.ctx, admin.staff, sampleId, body),
      async pause(target: Awaited<ReturnType<typeof createBoundOrder>>) {
        const quote = await r.cancelRequests.quote(admin, target.orderId, {
          reasonCode: "merchant_request",
        });
        return r.cancelRequests.create(admin, target.orderId, {
          reasonCode: "merchant_request",
          note: "W508暂停引用边界",
          expect: quote.expect,
        });
      },
      resume: (id: string) => r.cancelRequests.withdraw(admin, id, { note: "W508恢复引用边界" }),
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
