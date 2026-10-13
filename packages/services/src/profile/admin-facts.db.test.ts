import { beforeAll, describe, expect, it } from "vitest";
import {
  createLedgerHarness,
  openTerm,
  sampleStaffContext,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { adminFactsOf } from "./admin-ports.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services", { max: 1 });
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
const tables = [
  "billing_account",
  "billing_order",
  "subscription_term",
  "point_lot",
  "point_adjustment_request",
  "approval_request",
  "drama_order",
  "order_item",
  "delivery_ticket",
  "audit_log",
  "outbox_event",
];
const read = (entityId: string, storeId: string, managerId: string | null = null) =>
  h.tx.run((tx) =>
    adminFactsOf(h.assembly, tx, {
      entityId,
      storeId,
      managerId,
      ownerId: null,
      now: h.clock.now(),
    }),
  );

describe("后台跨域事实真实装配", { timeout: 60000 }, () => {
  it("计费按净实付和当前paid笔数分开，真实钱包/待审调整/关联付款且全程零写", async () => {
    const own = await h.make.merchant(),
      other = await h.make.merchant();
    const ledger = createLedgerHarness(h.prisma, { clock: h.clock });
    await openTerm(ledger, { entityId: own.entity.id, planCode: "pro" });
    const baseline = await read(own.entity.id, own.store.id);
    await h.make.billingOrder({ entityId: own.entity.id, amountFen: 1000, refundedAmountFen: 200 });
    await h.make.billingOrder({ entityId: own.entity.id, type: "topup", amountFen: 300 });
    await h.make.billingOrder({ entityId: own.entity.id, status: "refunded", amountFen: 500 });
    const pending = await h.make.billingOrder({
      entityId: own.entity.id,
      type: "topup",
      status: "pending_payment",
      amountFen: 100,
      contentSnapshot: { v: 1, kind: "topup", packId: uuidv7(), points: 1234, payFen: 100 },
    });
    await h.make.billingOrder({ entityId: other.entity.id, amountFen: 900000 });
    const staff = await h.make.staff(),
      id = uuidv7(),
      now = h.clock.now();
    const request = await h.prisma.approvalRequest.create({
      data: {
        id: uuidv7(),
        requestNo: "TZ2026101400001",
        kind: "points_adjust",
        category: "approval",
        subjectType: "point_adjustment_request",
        subjectId: id,
        entityId: own.entity.id,
        status: "pending",
        summarySnapshot: { title: "测试积分调整" },
        submitActorType: "staff",
        submitActorId: staff.id,
        submitClient: "admin",
        requesterStaffId: staff.id,
        submittedAt: now,
        dedupeKey: `points_adjust:${id}`,
        createdAt: now,
        updatedAt: now,
      },
    });
    await h.prisma.pointAdjustmentRequest.create({
      data: {
        id,
        approvalRequestId: request.id,
        entityId: own.entity.id,
        direction: "increase",
        lotKind: "plan",
        adjustPoints: 27,
        reasonCode: "other",
        note: "只读事实测试说明",
        spendableBeforePoints: baseline.billing.points.spendablePoints,
        createdAt: now,
        updatedAt: now,
      },
    });
    const before = await snapshotTables(h.prisma, tables),
      result = await read(own.entity.id, own.store.id);
    expect(result.billing.subscription.status).toBe("active");
    expect(result.billing.points).toEqual(baseline.billing.points);
    expect(result.billing.points.spendablePoints).toBeGreaterThan(0);
    expect(result.billing.paid).toEqual({
      totalPaidFen: baseline.billing.paid.totalPaidFen + 1100,
      paidOrderCount: baseline.billing.paid.paidOrderCount + 2,
      planOrderCount: baseline.billing.paid.planOrderCount + 1,
      topupOrderCount: baseline.billing.paid.topupOrderCount + 1,
    });
    expect(result.billing.pendingPointAdjustment).toEqual({
      pointAdjustmentRequestId: id,
      requestNo: request.requestNo,
      direction: "increase",
      lotKind: "plan",
      adjustPoints: 27,
    });
    expect(result.billing.relatedOrders).toEqual([
      {
        kind: "payment_order",
        id: pending.id,
        no: pending.orderNo,
        title: "加购积分 1,234",
        statusText: "待付款",
        amountFen: 100,
        heldPoints: null,
      },
    ]);
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  });

  it("订购上线与交付按本店事实聚合，经理在办量不含别人、终态或同主体其他店", async () => {
    const own = await h.make.merchant(),
      manager = await h.make.staff(),
      other = await h.make.staff();
    const sibling = await h.make.store({ entityId: own.entity.id, isPrimary: false });
    const drama = await h.make.drama();
    const snapshot = {
      dramaId: drama.id,
      title: "测试短剧",
      totalEpisodes: 3,
      dramaClass: "class_1",
      genreCodes: [],
      permits: [],
      licenseEndDate: "2027-12-31",
      posterFileId: null,
      allowedPlacements: [],
      isAiGenerated: false,
    };
    async function row(
      storeId: string,
      status: string,
      phase: string,
      step: string,
      managerId: string,
      index: number,
    ) {
      const order = await h.make.dramaOrder({
        entityId: own.entity.id,
        storeId,
        status,
        deliveryManagerId: managerId,
        submittedAt: new Date(`2026-09-${String(index).padStart(2, "0")}T00:00:00Z`),
      });
      const item = await h.make.orderItem({
        dramaOrderId: order.id,
        dramaId: drama.id,
        phase,
        dramaSnapshot: snapshot,
        usageEndSource: "license",
        ...(phase === "live"
          ? {
              usageStartDate: new Date(`2026-10-${String(index).padStart(2, "0")}`),
              usageEndDate: new Date(`2027-01-${String(index).padStart(2, "0")}`),
            }
          : {}),
        ...(phase === "producing" ? { agreedLaunchDate: new Date("2026-11-01") } : {}),
      });
      await h.make.deliveryTicket({ orderItemId: item.id, step, deliveryManagerId: managerId });
      return order;
    }
    const pending = await row(
      own.store.id,
      "pending_start",
      "pending_start",
      "assigning",
      manager.id,
      1,
    );
    await row(own.store.id, "producing", "producing", "plan_confirm", other.id, 2);
    await row(own.store.id, "live", "live", "in_service", manager.id, 3);
    await row(own.store.id, "live", "live", "takedown", manager.id, 4);
    await row(own.store.id, "ended", "ended", "archived", manager.id, 5);
    await row(sibling.id, "producing", "producing", "plan_confirm", manager.id, 6);
    const before = await snapshotTables(h.prisma, tables),
      result = await read(own.entity.id, own.store.id, manager.id);
    expect(result.order).toEqual({
      lastOrderAt: "2026-09-05T00:00:00.000Z",
      dramaOrderCount: 3,
      liveDramaCount: 2,
      liveSummary: {
        firstLiveDate: "2026-10-03",
        latestUsageEndDate: "2027-01-04",
        usageEndSource: "license",
      },
      nearestAgreedLaunchDate: "2026-11-01",
      relatedOrders: [
        {
          kind: "drama_order",
          id: pending.id,
          no: pending.orderNo,
          title: "《测试短剧》",
          statusText: "待开工",
          amountFen: null,
          heldPoints: 100,
        },
      ],
    });
    expect(result.delivery).toEqual({
      deliveringTicketCount: 2,
      producingCount: 1,
      inServiceCount: 2,
    });
    const unassigned = await read(own.entity.id, own.store.id);
    expect(unassigned.order.dramaOrderCount).toBe(0);
    expect(unassigned.delivery).toEqual({
      deliveringTicketCount: 2,
      producingCount: 0,
      inServiceCount: 0,
    });
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  });

  it("真实profile详情/列表消费三个键，次店隐金额、范围拒绝，空订阅不造业务行", async () => {
    const own = await h.make.merchant(),
      sibling = await h.make.store({ entityId: own.entity.id, isPrimary: false });
    const admin = await sampleStaffContext(
      h.prisma,
      (await h.make.staff({ staffRoleKey: "super_admin" })).id,
    );
    const manager = await sampleStaffContext(
      h.prisma,
      (await h.make.staff({ staffRoleKey: "delivery_manager" })).id,
    );
    const before = await snapshotTables(h.prisma, tables);
    const detail = await h.profile.admin.get(admin, sibling.id);
    expect(detail.subscription.status).toBe("none");
    expect(detail.liveDramaCount).toBe(0);
    expect(detail.liveSummary).toEqual({
      firstLiveDate: null,
      latestUsageEndDate: null,
      usageEndSource: null,
    });
    const list = await h.profile.admin.list(admin, {
      entityId: own.entity.id,
      lifecycle: "active",
      sort: "-registeredAt",
      page: 1,
      pageSize: 20,
    });
    expect(list.items.find((r) => r.storeId === sibling.id)?.totalPaidFen).toBeNull();
    expect(list.items.find((r) => r.isPrimary)?.totalPaidFen).toBe(0);
    await expect(h.profile.admin.get(manager, own.store.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  });
});
