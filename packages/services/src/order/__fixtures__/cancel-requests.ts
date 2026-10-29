import type { PrismaClient } from "@liyoxi/db";
import type { CancelApproveBody, OrderCancelQuoteBody } from "@liyoxi/contract";
import { AdPricingSnapshotSchema } from "@liyoxi/contract";
import { createIdempotencyContext, createIdentityContext, uuidv7 } from "../../kernel/index.js";
import { createProfile } from "../../profile/index.js";
import type { ProfileViewer } from "../../profile/index.js";
import { createTenant } from "../../tenant/index.js";
import { openTerm, TEST_KEYRING } from "../../testing/index.js";
import {
  completeQualificationFixture as complete,
  submitQualificationFixture as submit,
} from "../../testing/index.js";
import { body, drama, version } from "./harness.js";
import { cancelHarness } from "../cancel-execute.fixture.js";
import type { CancelActor } from "../cancel-context.js";
import { bindCancelRequests } from "../cancel-binding.js";
import { createCancelRequests } from "../cancel-requests.js";

export const REQUEST_TABLES = [
  "approval_request",
  "cancel_request",
  "cancel_request_line",
  "ad",
  "drama_order",
  "order_item",
  "delivery_ticket",
  "delivery_ticket_pause",
  "delivery_ticket_stage",
  "timer",
  "status_transition",
  "audit_log",
  "outbox_event",
  "billing_account",
  "point_lot",
  "point_hold",
  "point_hold_alloc",
  "ledger_operation",
  "point_ledger_entry",
];
export const MONEY_TABLES = [
  "billing_account",
  "point_lot",
  "point_hold",
  "point_hold_alloc",
  "ledger_operation",
  "point_ledger_entry",
];

/** Reuse only the real order/start/delivery setup. W5-01's seeded request() is never called. */
export function requestsHarness(prisma: PrismaClient) {
  const h = cancelHarness(prisma);
  const deps = h.cancelDeps;
  const unbind = bindCancelRequests(deps);
  const requests = createCancelRequests(deps);
  const tenant = createTenant(h.core);
  const profile = createProfile({
    ...h.core,
    tenant,
    approval: h.cancelDeps.approval,
    media: { link: h.media.link, release: h.media.release, signRead: h.media.signRead },
    keyring: () => TEST_KEYRING,
    wechat: h.fake.wechat,
    currentOpenid: async () => "lyxtest_w502_profile",
  });
  async function owner() {
    const made = await h.make.merchant();
    const viewer: ProfileViewer = {
      ctx: createIdentityContext({
        actor: { type: "merchant", id: made.user.id, client: "weapp" },
      }),
      principal: {
        sessionId: made.user.id,
        merchantUserId: made.user.id,
        wechatIdentityId: made.user.id,
        consentStamp: "test",
      },
      membership: {
        memberId: made.owner.id,
        entityId: made.entity.id,
        storeId: made.store.id,
        role: "owner",
        storeMode: "active",
      },
    };
    return { ...made, member: made.owner, viewer };
  }
  const profileFixture = { ...h, tenant, approval: h.cancelDeps.approval, profile, owner };
  async function qualificationOrder(count = 1) {
    h.clock.advance(1000);
    const w = await owner();
    const ready = await complete(profileFixture, w.viewer);
    await submit(profileFixture, w.viewer, ready.submissionId);
    const { term } = await openTerm(h, { entityId: w.entity.id });
    const manager = await h.pool("delivery_manager");
    await prisma.store.update({
      where: { id: w.store.id },
      data: { deliveryManagerId: manager.id },
    });
    const accountId = uuidv7();
    await prisma.channelAccount.create({
      data: {
        id: accountId,
        entityId: w.entity.id,
        storeId: w.store.id,
        platform: "douyin",
        accountName: "资质后续真实订购账号",
        accountUid: accountId,
        accountUidNorm: accountId,
        accountType: "personal",
        status: "available",
        submittedAt: h.clock.now(),
        verifiedAt: h.clock.now(),
        verifiedByStaffId: manager.id,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const actor = { ctx: w.viewer.ctx, membership: w.viewer.membership };
    const b = { ...w, actor, term, accountId };
    const oh = { ...h, deps: h.orderDeps };
    await version(oh);
    await prisma.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: "custom_focus", code: "W115F" } },
      create: {
        id: uuidv7(),
        dictTypeKey: "custom_focus",
        code: "W115F",
        name: "主推服务",
        parentCode: null,
        ext: {},
        isEnabled: true,
        position: 999,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
      update: {},
    });
    const dramas = [];
    for (let i = 0; i < count; i++) dramas.push(await drama(oh, 120 + i));
    const result = await h.order.create(
      actor,
      await body(
        oh,
        b,
        dramas.map((d) => d.id),
      ),
    );
    return { ...w, ...ready, actor, b, id: result.orderId, dramas };
  }
  async function saved(id: string) {
    return prisma.cancelRequest.findUniqueOrThrow({
      where: { id },
      include: { approvalRequest: true, cancelRequestLines: { orderBy: { id: "asc" } } },
    });
  }
  /** W5-08's ad request producer is not upstream yet. Existing legal ad facts use real holds;
   * qualification events and all cancellation input still come from their production services.
   */
  async function unassignedAd(w: Awaited<ReturnType<typeof qualificationOrder>>) {
    const id = uuidv7(),
      now = h.clock.now(),
      adNo = `GG20260105${++adSequence}`;
    const held = await h.tx.run((tx) =>
      h.ledger.hold(tx, {
        entityId: w.entity.id,
        storeId: w.store.id,
        refType: "ad",
        refId: id,
        pricing: { kind: "ad" },
        title: { code: "ad_hold", args: { adNo, unitPoints: 50, discountBp: w.b.term.discountBp } },
        ctx: createIdentityContext({ actor: { type: "system", job: "lyxtest.w502_existing_ad" } }),
      }),
    );
    const pricing = AdPricingSnapshotSchema.parse(held.snapshot);
    const consent = await h.make.agreementConsent({
      scene: "ad_request",
      merchantUserId: w.user.id,
      entityId: w.entity.id,
      storeId: w.store.id,
      bizId: id,
    });
    return prisma.ad.create({
      data: {
        id,
        adNo,
        entityId: w.entity.id,
        storeId: w.store.id,
        requestedByUserId: w.user.id,
        type: "opening",
        durationSec: 3,
        promoPointCodes: ["TEST"],
        status: "pending_assign",
        unitPricePoints: pricing.unitPoints,
        discountBp: pricing.discountBp,
        chargePoints: held.points,
        pricingSnapshot: held.snapshot,
        pointHoldId: held.pointHoldId,
        freeRevisionQuota: pricing.freeRevisions,
        agreementConsentId: consent.id,
        submittedAt: now,
        firstDueAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  async function create(
    p: Awaited<ReturnType<typeof h.atStage>>,
    actor = p.actor,
    quoteInput: OrderCancelQuoteBody = p.input,
  ) {
    const q = await requests.quote(actor, p.out.orderId, quoteInput);
    return requests.create(actor, p.out.orderId, {
      ...quoteInput,
      note: "商家申请取消真实订购",
      expect: q.expect,
    });
  }
  async function approveBody(id: string): Promise<CancelApproveBody> {
    const r = await saved(id);
    return {
      lockVersion: r.approvalRequest.lockVersion,
      confirm: { requestNo: r.approvalRequest.requestNo!, totalRefundPoints: r.totalRefundPoints },
      confirmChecks: ["stage_rule_amount_checked"],
    };
  }
  function idem(actor: CancelActor, requestBody: unknown, key = uuidv7()) {
    return createIdempotencyContext({
      mode: "required",
      scope: "admin.order.cancelRequest.create",
      key,
      actor: actor.ctx.actor,
      request: { method: "POST", body: requestBody },
    });
  }
  async function deliver(storeId: string, type = "store.qualification.rejected") {
    const e = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: storeId, eventType: type },
      orderBy: { id: "desc" },
    });
    const subscriber = h.assembly.subscriber("order.onQualificationDecided")!;
    await h.tx.run((tx) =>
      subscriber.handle(tx, {
        id: e.id,
        type: e.eventType,
        payload: e.payload as Record<string, unknown>,
      }),
    );
    return e;
  }
  async function param(...args: Parameters<typeof h.param>) {
    const latest = await prisma.paramValue.findFirst({
      where: { key: args[0] },
      orderBy: { effectiveAt: "desc" },
      select: { effectiveAt: true },
    });
    // atStage deliberately resets its clock; append parameters at a distinct, increasing instant.
    const next = Math.max(h.clock.now().getTime(), (latest?.effectiveAt.getTime() ?? 0) + 1);
    h.clock.set(new Date(next));
    return h.param(...args);
  }
  return {
    ...h,
    param,
    requestDeps: deps,
    requests,
    profile,
    profileFixture,
    qualificationOrder,
    unassignedAd,
    saved,
    create,
    approveBody,
    idem,
    deliver,
    close: async () => {
      unbind();
      await h.close();
    },
  };
}
export type RequestsHarness = ReturnType<typeof requestsHarness>;
let adSequence = 50200;
