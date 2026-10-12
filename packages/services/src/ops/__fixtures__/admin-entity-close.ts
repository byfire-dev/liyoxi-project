import { createHash } from "node:crypto";
import { AdPricingSnapshotSchema } from "@liyoxi/contract";
import type { EntityCloseBody } from "@liyoxi/contract";
import type { PrismaClient } from "@liyoxi/db";
import { createApproval } from "../../approval/index.js";
import { createFlow } from "../../flow/index.js";
import {
  createBizNoIssuer,
  createIdempotencyContext,
  createIdentityContext,
  lockRows,
  uuidv7,
} from "../../kernel/index.js";
import type { TxRunner } from "../../kernel/index.js";
import {
  bindOrder,
  createAdCancel,
  quoteAdCancel,
  countOrderItemsByPhase,
} from "../../order/index.js";
import type { CancelDeps } from "../../order/index.js";
import { readTenantAdminBillingFacts } from "../../billing/index.js";
import { readEntityAssetCounts } from "../../media/index.js";
import { readEntityStoreProfileFacts } from "../../profile/index.js";
import { createSla } from "../../sla/index.js";
import { createTenant } from "../../tenant/index.js";
import type { TenantAdminReadDeps } from "../../tenant/index.js";
import {
  assembleForTest,
  createLedgerHarness,
  openTerm,
  sampleStaffContext,
  snapshotTables,
  testSealer,
} from "../../testing/index.js";
import { createTimers, timerKey } from "../../timers/index.js";

export const SLOW = 120_000;
export type CloseBody = EntityCloseBody;
export const TABLES = [
  "entity",
  "store",
  "entity_member",
  "store_member",
  "invitation",
  "invitation_request",
  "portal_session",
  "timer",
  "status_transition",
  "audit_log",
  "outbox_event",
  "idempotency_record",
  "ad",
  "cancel_request",
  "cancel_request_line",
  "approval_request",
  "billing_account",
  "billing_order",
  "subscription_term",
  "grant_schedule",
  "point_hold",
  "point_hold_alloc",
  "point_lot",
  "point_ledger_entry",
  "ledger_operation",
  "store_profile",
  "qualification_submission",
  "file_ref",
  "store_asset",
  "refund_request",
  "invoice_request",
  "payment_txn",
  "drama_order",
  "order_item",
  "delivery_ticket",
];
export const realReaders: TenantAdminReadDeps = {
  billing: readTenantAdminBillingFacts,
  profiles: readEntityStoreProfileFacts,
  assets: readEntityAssetCounts,
  orders: countOrderItemsByPhase,
};
let serial = 0;
export function closeHarness(prisma: PrismaClient) {
  const h = createLedgerHarness(prisma);
  const assembly = assembleForTest({ entry: "api" });
  const flow = createFlow({ assembly, clock: h.clock, events: h.events });
  const timers = createTimers({ assembly }),
    sla = createSla({ assembly, clock: h.clock });
  const approval = createApproval({
    assembly,
    clock: h.clock,
    events: h.events,
    flow,
    timers,
    sla,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
  });
  const cancel: CancelDeps = {
    tx: h.tx,
    clock: h.clock,
    approval,
    flow,
    ledger: h.ledger,
    events: h.events,
    timers,
    sla,
  };
  const unbind = bindOrder({ assembly, clock: h.clock, flow, cancel });
  function service(runner: TxRunner = h.tx, adminRead: TenantAdminReadDeps | null = realReaders) {
    return createTenant({
      tx: runner,
      clock: h.clock,
      assembly,
      events: h.events,
      flow,
      entityClose: { assembly, timers },
      ...(adminRead ? { adminRead } : {}),
    });
  }
  const tenant = service();
  async function world() {
    const merchant = await h.make.merchant({ verified: true });
    const group = await prisma.staffGroup.findFirstOrThrow({
      where: { staffRoleKey: "super_admin", isDefault: true },
    });
    const row = await h.make.staff({
      staffRoleKey: "super_admin",
      staffGroupId: group.id,
      isLead: true,
    });
    const staff = await sampleStaffContext(prisma, row.id, { stepUpAt: h.clock.now() });
    const ctx = createIdentityContext({
      actor: { type: "staff", id: row.id, client: "admin" },
      requestId: uuidv7(),
    });
    return { merchant, staff, ctx, entityId: merchant.entity.id };
  }
  type World = Awaited<ReturnType<typeof world>>;
  async function input(w: World): Promise<CloseBody> {
    return {
      reasonText: "经营主体主动申请结束经营服务",
      confirm: {
        activeStoreCount: await prisma.store.count({
          where: { entityId: w.entityId, lifecycle: "active" },
        }),
        activeMemberCount: await prisma.entityMember.count({
          where: { entityId: w.entityId, status: "active" },
        }),
      },
    };
  }
  async function invitation(w: World, status: "pending" | "revoked" = "pending") {
    const id = uuidv7(),
      now = h.clock.now();
    return prisma.invitation.create({
      data: {
        id,
        entityId: w.entityId,
        storeId: w.merchant.store.id,
        role: "clerk",
        inviterMemberId: w.merchant.owner.id,
        tokenHash: createHash("sha256").update(id).digest(),
        tokenEnc: status === "pending" ? "v1:test:token" : null,
        status,
        expiresAt: new Date(now.getTime() + 86_400_000),
        clientRequestId: uuidv7(),
        createdAt: now,
        updatedAt: now,
        ...(status === "revoked"
          ? {
              revokedAt: now,
              revokeActorType: "merchant",
              revokeActorId: w.merchant.user.id,
              revokeClient: "weapp",
              revokeReason: "by_owner",
            }
          : {}),
      },
    });
  }
  async function grant(
    w: World,
    extra: { expired?: boolean; revoked?: boolean; userId?: string } = {},
  ) {
    const id = uuidv7(),
      now = h.clock.now();
    return prisma.portalSession.create({
      data: {
        id,
        tokenHash: createHash("sha256").update(id).digest(),
        portalTicketId: uuidv7(),
        entityId: w.entityId,
        storeId: w.merchant.store.id,
        approvedByUserId: extra.userId ?? w.merchant.user.id,
        grantScope: "store",
        expiresAt: new Date(now.getTime() + (extra.expired ? -1 : 1) * 3_600_000),
        ...(extra.revoked ? { revokedAt: now, revokeReason: "owner_revoked" } : {}),
        createdAt: new Date(now.getTime() - 10_800_000),
        updatedAt: now,
        ip: "198.51.100.74",
        userAgent: "关闭主体测试",
      },
    });
  }
  async function extended(w: World) {
    const store = await h.make.store({ entityId: w.entityId });
    const clerk = await h.make.entityMember({ entityId: w.entityId, lastStoreId: store.id });
    await h.make.storeMember({ entityId: w.entityId, storeId: store.id, entityMemberId: clerk.id });
    // 合法历史前提；新HTTP用例须保留这些已经终止的记录。
    const oldStore = await h.make.store({
      entityId: w.entityId,
      lifecycle: "archived",
      archivedAt: h.clock.now(),
      archiveReason: "by_owner",
      archiveActorType: "merchant",
      archiveActorId: w.merchant.user.id,
      archiveClient: "weapp",
    });
    const oldMember = await h.make.entityMember({
      entityId: w.entityId,
      status: "removed",
      removedAt: h.clock.now(),
      removeReason: "self",
      removeActorType: "merchant",
      removeActorId: w.merchant.user.id,
      removeClient: "weapp",
    });
    const pending = await invitation(w),
      oldInvite = await invitation(w, "revoked");
    const timer = await h.tx.run(async (tx) => {
      await lockRows(tx, "invitation", [pending.id]);
      return timers.arm(tx, {
        kind: "invitation.expire",
        subject: { type: "invitation", id: pending.id },
        key: timerKey("invitation.expire", { type: "invitation", id: pending.id }),
        fireAt: pending.expiresAt,
        entityId: w.entityId,
        storeId: pending.storeId,
      });
    });
    return { ...w, store, clerk, oldStore, oldMember, pending, oldInvite, timer };
  }
  async function block(w: World, kind: string) {
    const entityId = w.entityId;
    if (kind === "subscription_active") {
      await h.make.subscriptionTerm({ entityId });
      return;
    }
    if (kind === "payment_open") {
      await h.make.billingOrder({ entityId, status: "pending_payment" });
      return;
    }
    if (kind === "refund_open" || kind === "invoice_open") {
      const order = await h.make.billingOrder({ entityId }),
        now = h.clock.now(),
        id = uuidv7();
      if (kind === "refund_open") {
        if (!order.paidPaymentTxnId) throw new Error("退款前提缺真实已付流水");
        await prisma.approvalRequest.create({
          data: {
            id,
            requestNo: `TK${id.replaceAll("-", "")}`,
            kind: "plan_refund",
            category: "approval",
            subjectType: "billing_order",
            subjectId: order.id,
            entityId,
            status: "pending",
            summarySnapshot: { title: "关闭主体退款前提" },
            requesterStaffId: w.staff.staff.id,
            submitActorType: "staff",
            submitActorId: w.staff.staff.id,
            submitClient: "admin",
            submittedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        });
        await prisma.refundRequest.create({
          data: {
            id: uuidv7(),
            approvalRequestId: id,
            source: "customer_service",
            entityId,
            billingOrderId: order.id,
            paymentTxnId: order.paidPaymentTxnId,
            baseAmountFen: order.amountFen,
            amountFen: order.amountFen,
            breakdownSnapshot: {},
            ruleCode: "window",
            ruleText: "关闭主体退款规则",
            reasonCode: "other",
            status: "pending_approval",
            createdAt: now,
            updatedAt: now,
          },
        });
      } else
        await prisma.invoiceRequest.create({
          data: {
            id,
            requestNo: `FP${id.replaceAll("-", "")}`,
            billingOrderId: order.id,
            entityId,
            amountFen: order.amountFen,
            invoiceType: "normal",
            medium: "electronic",
            title: "关闭主体发票前提",
            taxNoEnc: testSealer.text("invoice_request.tax_no_enc", "913300001234567890"),
            taxNoMask: "9133**********7890",
            recvEmailEnc: testSealer.text("invoice_request.recv_email_enc", "test@example.invalid"),
            recvEmailMask: "te**@example.invalid",
            itemName: "测试服务",
            status: "pending",
            appliedByUserId: w.merchant.user.id,
            appliedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        });
      return;
    }
    const term = await h.make.subscriptionTerm({ entityId, status: "ended" });
    const order = await h.make.dramaOrder({
      entityId,
      storeId: w.merchant.store.id,
      subscriptionTermId: term.id,
      status: kind === "open_order" ? "pending_start" : "ended",
    });
    if (kind === "release_online") {
      const item = await h.make.orderItem({ dramaOrderId: order.id, phase: "ended" });
      await h.make.deliveryTicket({ orderItemId: item.id, step: "in_service" });
    }
  }
  async function adCancel(w: World) {
    h.clock.advance(++serial * 10);
    const { term } = await openTerm(h, { entityId: w.entityId });
    await prisma.billingOrder.update({
      where: { id: term.sourceBillingOrderId },
      data: {
        contentSnapshot: {
          v: 1,
          kind: "plan",
          planId: term.planId,
          planRevisionId: term.initialPlanRevisionId,
          months: term.months,
          cyclePriceFen: term.priceTotalFen,
          payFen: term.priceTotalFen,
          monthlyPoints: term.monthlyPoints,
          discountBp: term.discountBp,
          promo: null,
          quotedAt: term.createdAt.toISOString(),
        },
      },
    });
    for (const key of [
      "refund.points.auto_approve_before_production",
      "refund.require_distinct_executor",
    ]) {
      h.clock.advance(1);
      await prisma.paramValue.create({
        data: {
          id: uuidv7(),
          key,
          value: false,
          effectiveAt: h.clock.now(),
          createdAt: h.clock.now(),
          createdByStaffId: w.staff.staff.id,
          reason: "关闭主体取消申请前提",
        },
      });
    }
    for (const [key, value] of [
      [
        "cancelDeductionBp",
        {
          planConfirm: 3000,
          adAndSample: 3000,
          samplePending: 5000,
          postSample: null,
          adInProduction: 3000,
        },
      ],
      ["expiredTermRefund", { merchant: "forfeit", platform: "addon", qualification: "addon" }],
    ] as const) {
      h.clock.advance(1);
      await prisma.billingParam.create({
        data: {
          id: uuidv7(),
          key,
          value,
          effectiveAt: h.clock.now(),
          changeId: uuidv7(),
          createdAt: h.clock.now(),
        },
      });
    }
    const id = uuidv7(),
      adNo = `GG20260105${String(serial).padStart(5, "0")}`,
      now = h.clock.now();
    const held = await h.tx.run((tx) =>
      h.ledger.hold(tx, {
        entityId: w.entityId,
        storeId: w.merchant.store.id,
        refType: "ad",
        refId: id,
        pricing: { kind: "ad" },
        title: { code: "ad_hold", args: { adNo, unitPoints: 50, discountBp: term.discountBp } },
        ctx: createIdentityContext({
          actor: { type: "system", job: "lyxtest.admin_entity_close" },
          entityId: w.entityId,
        }),
      }),
    );
    const pricing = AdPricingSnapshotSchema.parse(held.snapshot);
    const consent = await h.make.agreementConsent({
      scene: "ad_request",
      merchantUserId: w.merchant.user.id,
      entityId: w.entityId,
      storeId: w.merchant.store.id,
      bizId: id,
    });
    // M5广告提交producer未交付；广告仅作合法上游行，冻结/取消/审批走真实公口。
    await prisma.ad.create({
      data: {
        id,
        adNo,
        entityId: w.entityId,
        storeId: w.merchant.store.id,
        requestedByUserId: w.merchant.user.id,
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
    const quote = await h.tx.run((tx) =>
      quoteAdCancel(
        tx,
        { scope: w.staff.scope, adId: id, body: { reasonCode: "merchant_request" } },
        h.clock.now(),
      ),
    );
    const request = await createAdCancel(cancel).submit({ ctx: w.ctx, staff: w.staff }, id, {
      reasonCode: "merchant_request",
      note: "商家申请取消广告制作",
      expect: quote.expect,
    });
    h.clock.set(new Date(term.endsAt.getTime() + 1));
    await h.tx.run((tx) => h.ledger.advance(tx, w.entityId));
    return {
      id,
      request,
      staff: await sampleStaffContext(prisma, w.staff.staff.id, { stepUpAt: h.clock.now() }),
    };
  }
  return {
    ...h,
    assembly,
    flow,
    timers,
    approval,
    cancel,
    tenant,
    service,
    world,
    input,
    invitation,
    grant,
    extended,
    block,
    adCancel,
    state: () => snapshotTables(prisma, TABLES),
    close: unbind,
  };
}
export type CloseHarness = ReturnType<typeof closeHarness>;
export type CloseWorld = Awaited<ReturnType<CloseHarness["world"]>>;
export function closeCall(
  tenant: ReturnType<typeof createTenant>,
  w: CloseWorld,
  body: CloseBody,
  key = uuidv7(),
) {
  return tenant.closeEntity(
    w.ctx,
    w.staff,
    { entityId: w.entityId, ...body },
    {
      idem: createIdempotencyContext({
        mode: "required",
        scope: "admin.entity.close",
        key,
        actor: w.ctx.actor,
        request: { method: "POST", pathParams: { entityId: w.entityId }, body },
      }),
    },
  );
}
