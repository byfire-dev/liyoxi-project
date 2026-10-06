import { beforeAll, describe, expect, it } from "vitest";
import {
  DRAMA_ORDER_STATUS,
  MerchantOrderListQuerySchema,
  MerchantOrderItemQuerySchema,
  AdminOrderListQuerySchema,
  AdminOrderItemRowSchema,
} from "@liyoxi/contract";
import { useSeededDatabase, approvalReadFixture } from "../testing/index.js";
import { paramsAt } from "../config/index.js";
import { uuidv7 } from "../kernel/index.js";
import { scopeOf, SYSTEM_SCOPE } from "../authz/index.js";
import { harness, buyer, drama, version, body } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { countOpenOrdersByEntity, countBlockingStoreOrders, orderMerchantFacts } from "./index.js";
const db = useSeededDatabase("services");
let h: Harness;
type Buyer = Awaited<ReturnType<typeof buyer>>;
beforeAll(async () => {
  h = harness(await db.prisma());
  await version(h);
}, 120000);
async function cancel(b: Buyer) {
  const id = uuidv7(),
    now = h.clock.now(),
    approvalId = uuidv7(),
    requester = await h.make.staff({ staffRoleKey: "cs" });
  await h.prisma.approvalRequest.create({
    data: {
      id: approvalId,
      requestNo: `TK20260105${String(++seq).padStart(5, "0")}`,
      kind: "qualification_cancel",
      category: "approval",
      subjectType: "store",
      subjectId: b.store.id,
      entityId: b.entity.id,
      storeId: b.store.id,
      status: "pending",
      summarySnapshot: { title: "测试整店取消" },
      requesterStaffId: requester.id,
      submitActorType: "system",
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  return h.prisma.cancelRequest.create({
    data: {
      id,
      approvalRequestId: approvalId,
      kind: "qualification_cancel",
      entityId: b.entity.id,
      storeId: b.store.id,
      reasonCode: "qualification_final",
      note: "测试只读历史取消",
      lineCount: 1,
      totalBasePoints: 100,
      totalDeductPoints: 0,
      totalRefundPoints: 100,
      status: "pending_approval",
      createdAt: now,
      updatedAt: now,
    },
  });
}
let seq = 70000;
async function historic(
  b: Buyer,
  status: string,
  phase: string,
  options: {
    end?: string;
    launch?: string | null;
    submittedAt?: Date;
    title?: string;
    liveEpisodes?: number;
  } = {},
) {
  const d = await drama(h),
    snapshot = await h.tx.run((tx) => h.deps.content.assertOrderable(tx, d.id, ["douyin"])),
    open = status === "after_sale" ? await cancel(b) : null,
    order = await h.make.dramaOrder({
      entityId: b.entity.id,
      storeId: b.store.id,
      placedByUserId: b.user.id,
      subscriptionTermId: b.term!.id,
      status,
      ...(open ? { openCancelRequestId: open.id, subStatus: "cancel_reviewing" } : {}),
      ...(options.submittedAt ? { submittedAt: options.submittedAt } : {}),
    });
  const item = await h.make.orderItem({
    dramaOrderId: order.id,
    dramaId: d.id,
    phase,
    dramaSnapshot: { ...snapshot, title: options.title ?? d.title },
    ...(options.end ? { usageEndDate: new Date(options.end) } : {}),
    agreedLaunchDate: options.launch ? new Date(options.launch) : null,
    liveEpisodeCount: options.liveEpisodes ?? 0,
  });
  await h.prisma.orderItemAccount.create({
    data: {
      orderItemId: item.id,
      channelAccountId: b.accountId,
      platform: "douyin",
      createdAt: h.clock.now(),
    },
  });
  return { order, item, d };
}
const oq = (value: unknown) => MerchantOrderListQuerySchema.parse(value),
  iq = (value: unknown) => MerchantOrderItemQuerySchema.parse(value),
  aq = (value: unknown) => AdminOrderListQuerySchema.parse(value);
async function immutable(b: Buyer) {
  return {
    financial: await h.prisma.billingAccount.findUnique({ where: { entityId: b.entity.id } }),
    lots: await h.prisma.pointLot.findMany({
      where: { entityId: b.entity.id },
      orderBy: { id: "asc" },
    }),
    holds: await h.prisma.pointHold.findMany({
      where: { entityId: b.entity.id },
      orderBy: { id: "asc" },
    }),
    ledger: await h.prisma.ledgerOperation.count({ where: { entityId: b.entity.id } }),
    audits: await h.prisma.auditLog.count(),
    events: await h.prisma.outboxEvent.count(),
    history: await h.prisma.statusTransition.count(),
  };
}
describe("真实历史订单读侧", { timeout: 120000 }, () => {
  it("八状态映射、完整单号精确查找、同时间稳定游标、liveSummary与实际退回合计", async () => {
    const b = await buyer(h),
      made: Awaited<ReturnType<typeof historic>>[] = [];
    for (const status of DRAMA_ORDER_STATUS.values)
      made.push(await historic(b, status, status === "after_sale" ? "producing" : status));
    const all = await h.order.list(b.actor, oq({}));
    expect(all.items).toHaveLength(8);
    for (const [tab, expected] of [
      ["producing", ["pending_start", "producing"]],
      ["to_launch", ["to_launch"]],
      ["live", ["live"]],
      ["ended", ["ended"]],
      ["after_sale", ["cancelled", "after_sale", "refunded"]],
    ] as const) {
      expect((await h.order.list(b.actor, oq({ tab }))).items.map((r) => r.status).sort()).toEqual(
        [...expected].sort(),
      );
    }
    const no = made[0]!.order.orderNo;
    expect((await h.order.list(b.actor, oq({ no }))).items.map((i) => i.orderNo)).toEqual([no]);
    expect((await h.order.list(b.actor, oq({ no: no.slice(0, -1) }))).items).toEqual([]);
    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await h.order.list(b.actor, oq({ limit: 2, ...(cursor ? { cursor } : {}) }));
      collected.push(...page.items.map((r) => r.orderId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(collected).toEqual(all.items.map((r) => r.orderId));
    expect(new Set(collected).size).toBe(8);
    expect(
      (await h.order.list(b.actor, oq({ cursor: "broken" }))).items.map((r) => r.orderId),
    ).toEqual(all.items.map((r) => r.orderId));
    const live = made.find((r) => r.item.phase === "live")!;
    await h.prisma.orderItem.update({
      where: { id: live.item.id },
      data: {
        liveEpisodeCount: 2,
        refundRequestedPoints: 30,
        returnedPoints: 10,
        convertedPoints: 20,
      },
    });
    expect((await h.order.list(b.actor, oq({ tab: "live" }))).items[0]).toMatchObject({
      returnedPoints: 30,
      liveSummary: { liveItemCount: 1, liveEpisodeCount: 2, firstLiveOrderItemId: live.item.id },
    });
    expect(await h.tx.run((tx) => countOpenOrdersByEntity(tx, b.entity.id))).toBe(5);
    expect(await h.tx.run((tx) => countBlockingStoreOrders(tx, b.store.id))).toBe(4);
  });
  it("三阶段组的小页键集完整遍历，空约定日最后；summary同orderId谓词且delivering不含pending", async () => {
    const b = await buyer(h),
      rows: Awaited<ReturnType<typeof historic>>[] = [];
    for (const row of [
      { phase: "live", end: "2026-01-07" },
      { phase: "live", end: "2026-01-07" },
      { phase: "live", end: "2026-02-01" },
      { phase: "pending_start", launch: "2026-01-06" },
      { phase: "producing", launch: "2026-01-06" },
      { phase: "to_launch", launch: null },
      { phase: "pending_start", launch: null },
      { phase: "ended" },
      { phase: "refunded" },
      { phase: "terminated" },
      { phase: "cancelled" },
    ])
      rows.push(
        await historic(b, row.phase === "terminated" ? "cancelled" : row.phase, row.phase, row),
      );
    const summary = await h.order.itemSummary(b.actor);
    expect(summary).toEqual({ all: 10, live: 3, to_launch: 4, ended: 3, delivering: 2 });
    const expected: string[] = [];
    for (const tab of ["live", "to_launch", "ended"] as const)
      expected.push(
        ...(await h.order.itemList(b.actor, iq({ tab }))).items.map((i) => i.orderItemId),
      );
    const seen = [];
    let cursor: string | null = null;
    do {
      const page = await h.order.itemList(b.actor, iq({ limit: 2, ...(cursor ? { cursor } : {}) }));
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.map((r) => r.orderItemId)).toEqual(expected);
    expect(new Set(expected).size).toBe(10);
    expect(seen.filter((r) => r.phase === "live").map((r) => r.remainingDays)).toEqual([2, 2, 27]);
    expect(seen.filter((r) => r.phase !== "live").every((r) => r.remainingDays === null)).toBe(
      true,
    );
    expect(
      (await h.order.itemList(b.actor, iq({ tab: "to_launch" }))).items.map(
        (r) => r.agreedLaunchDate,
      ),
    ).toEqual(["2026-01-06", "2026-01-06", null, null]);
    expect(await h.order.itemSummary(b.actor, rows[0]!.order.id)).toEqual({
      all: 1,
      live: 1,
      to_launch: 0,
      ended: 0,
      delivering: 0,
    });
    const other = await buyer(h);
    await expect(
      h.order.itemList(other.actor, iq({ orderId: rows[0]!.order.id })),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    await expect(h.order.itemSummary(other.actor, rows[0]!.order.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    await expect(h.order.itemGet(other.actor, rows[0]!.item.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    const view = await h.order.itemGet(b.actor, rows[0]!.item.id);
    expect(view.accounts[0]).toMatchObject({
      accountName: "测试账号",
      accountType: "personal",
      accountUid: b.accountId,
    });
    expect(view.posterUrl).not.toBeNull();
    h.clock.advance(30 * 86400000);
    expect((await h.order.itemGet(b.actor, rows[0]!.item.id)).remainingDays).toBe(0);
    h.clock.advance(1);
  });
  it("后台all/group/own同筛选、页码稳定、北京日期含两端；真实零资金/审计写", async () => {
    const a = await buyer(h),
      b = await buyer(h),
      c = await buyer(h),
      manager = await h.make.staff({ staffRoleKey: "delivery_manager" }),
      groupmate = await h.make.staff({ staffRoleKey: "delivery_manager" });
    await h.prisma.store.update({
      where: { id: a.store.id },
      data: { deliveryManagerId: manager.id, name: "读侧同城店" },
    });
    await h.prisma.store.update({
      where: { id: b.store.id },
      data: { deliveryManagerId: groupmate.id, name: "读侧别店" },
    });
    await h.prisma.storeProfile.update({
      where: { storeId: a.store.id },
      data: { contactName: "读侧联系人" },
    });
    const first = await historic(a, "pending_start", "pending_start", {
        submittedAt: new Date("2026-02-01T15:59:59Z"),
        title: "历史专名剧",
      }),
      second = await historic(a, "producing", "producing", {
        submittedAt: new Date("2026-02-01T16:00:00Z"),
      });
    await historic(b, "pending_start", "pending_start");
    await historic(c, "pending_start", "pending_start");
    const own = scopeOf({ id: manager.id, isLead: false }, { dataScope: "own" }, [], new Set()),
      group = scopeOf(
        { id: manager.id, isLead: false },
        { dataScope: "group" },
        [groupmate.id],
        new Set(),
      );
    const before = await immutable(a);
    expect((await h.order.adminList(own, aq({}))).total).toBe(2);
    expect((await h.order.adminList(group, aq({}))).total).toBe(3);
    expect((await h.order.adminSummary(own, {})).tabs).toMatchObject({
      all: 2,
      pending_start: 1,
      producing: 1,
    });
    const filters = {
      storeId: a.store.id,
      entityId: a.entity.id,
      deliveryManagerId:
        first.order.deliveryManagerId === null ? "none" : first.order.deliveryManagerId,
      dramaId: first.d.id,
      submittedFrom: "2026-02-01",
      submittedTo: "2026-02-01",
      q: "历史专名",
    };
    expect((await h.order.adminList(own, aq(filters))).items.map((r) => r.orderId)).toEqual([
      first.order.id,
    ]);
    expect((await h.order.adminSummary(own, filters)).tabs).toMatchObject({
      all: 1,
      pending_start: 1,
    });
    expect(
      (
        await h.order.adminList(own, aq({ submittedFrom: "2026-02-02", submittedTo: "2026-02-02" }))
      ).items.map((r) => r.orderId),
    ).toEqual([second.order.id]);
    const p1 = await h.order.adminList(own, aq({ pageSize: 1, sort: "submittedAt" })),
      p2 = await h.order.adminList(own, aq({ pageSize: 1, page: 2, sort: "submittedAt" }));
    expect([p1.items[0]!.orderId, p2.items[0]!.orderId]).toEqual([first.order.id, second.order.id]);
    expect(
      (
        await h.order.adminList(SYSTEM_SCOPE, aq({ q: first.order.orderNo.slice(0, -1) }))
      ).items.map((r) => r.orderId),
    ).toContain(first.order.id);
    expect((await h.order.adminList(own, aq({ q: "读侧同城店" }))).total).toBe(2);
    expect((await h.order.adminList(own, aq({ tab: "live" }))).total).toBe(0);
    await expect(
      h.order.adminGet(
        own,
        (await h.prisma.dramaOrder.findFirstOrThrow({ where: { storeId: b.store.id } })).id,
      ),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    const detail = await h.order.adminGet(own, first.order.id);
    expect(detail.items[0]!.pointHold.status).toBe("held");
    expect(AdminOrderItemRowSchema.parse(detail.items[0])).toEqual(detail.items[0]);
    expect(detail.items[0]).toMatchObject({
      dramaTitle: "历史专名剧",
      cancelReasonCode: null,
      cancelledAt: null,
      accounts: [{ accountUid: a.accountId, status: "available" }],
    });
    for (const merchantOnly of ["posterUrl", "ticketStep", "timeline", "returnPoints"])
      expect(detail.items[0]).not.toHaveProperty(merchantOnly);
    expect(detail.merchant.contactName).not.toBeNull();
    expect(detail.store.storeId).toBe(a.store.id);
    const merchant = await h.order.get(
      { ...a.actor, membership: { ...a.actor.membership, storeMode: "archived" } },
      first.order.id,
    );
    expect(merchant.items[0]!.dramaTitle).toBe("历史专名剧");
    await expect(h.order.get(b.actor, first.order.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    expect(await immutable(a)).toEqual(before);
  });
  it("资质驳回超期只取门店最近一次决定，严格越过阈值且false不过滤", async () => {
    const old = await buyer(h),
      edge = await buyer(h),
      decider = await h.make.staff({ staffRoleKey: "cs" }),
      now = h.clock.now(),
      days = await h.tx.run(async (tx) =>
        Number(
          (await paramsAt(tx, ["order.rejected_stale_days"], now))["order.rejected_stale_days"],
        ),
      ),
      cutoff = new Date(now.getTime() - days * 86400000),
      readApproval = approvalReadFixture(h.prisma, h.clock);
    for (const b of [old, edge]) {
      const row = await historic(b, "pending_start", "pending_start");
      await h.prisma.dramaOrder.update({
        where: { id: row.order.id },
        data: { subStatus: "qualification_rejected" },
      });
    }
    const reject = (b: Buyer, decidedAt: Date, roundNo: number) =>
      readApproval({
        kind: "qualification",
        category: "review",
        subjectType: "store",
        subjectId: b.store.id,
        entityId: b.entity.id,
        storeId: b.store.id,
        status: "rejected",
        roundNo,
        summarySnapshot: { title: "资质驳回历史" },
        submitActorType: "merchant",
        submitActorId: b.user.id,
        submitClient: "weapp",
        submittedAt: new Date(decidedAt.getTime() - 1),
        decidedAt,
        decidedByStaffId: decider.id,
        decisionNote: "只读筛选历史",
        reasonCodes: ["incomplete"],
        dedupeKey: `qualification:${b.store.id}`,
      });
    await reject(old, new Date(cutoff.getTime() - 1), 1);
    await reject(edge, cutoff, 1);
    const q = (b: Buyer, flag: string) => aq({ entityId: b.entity.id, isRejectedStale: flag });
    expect((await h.order.adminList(SYSTEM_SCOPE, q(old, "true"))).total).toBe(1);
    expect((await h.order.adminSummary(SYSTEM_SCOPE, q(old, "true"))).tabs.pending_start).toBe(1);
    expect((await h.order.adminList(SYSTEM_SCOPE, q(edge, "true"))).total).toBe(0);
    const before = await immutable(old);
    await reject(old, now, 2);
    const afterFixture = await immutable(old);
    expect(afterFixture).toEqual(before);
    expect((await h.order.adminList(SYSTEM_SCOPE, q(old, "true"))).total).toBe(0);
    expect((await h.order.adminSummary(SYSTEM_SCOPE, q(old, "true"))).tabs.all).toBe(0);
    expect((await h.order.adminList(SYSTEM_SCOPE, q(old, "false"))).total).toBe(1);
    expect(await immutable(old)).toEqual(afterFixture);
  });
  it("真实订单get/adminGet积分时间线一致；事实非零且跨门店不泄漏", async () => {
    const b = await buyer(h),
      d = await drama(h),
      created = await h.order.create(b.actor, await body(h, b, [d.id])),
      extra = await historic(b, "live", "live", { liveEpisodes: 2 }),
      cartDrama = await drama(h),
      added = await h.order.cartCreate(b.actor, cartDrama.id),
      other = await buyer(h),
      before = await immutable(b);
    expect(added.cartItemId).toBeTruthy();
    const merchant = await h.order.get(b.actor, created.orderId),
      admin = await h.order.adminGet(SYSTEM_SCOPE, created.orderId);
    expect(admin.pointsEvents).toEqual(merchant.pointsEvents);
    expect(admin.pointsEvents[0]!.points).toBe(created.totalChargePoints);
    expect(admin.pointsBreakdown).toMatchObject({
      listPriceTotalPoints: 101,
      discountDeltaPoints: -10,
      surchargeDeltaPoints: 0,
      totalChargePoints: 91,
      planPoints: 91,
      addonPoints: 0,
    });
    const facts = await h.tx.run((tx) =>
      orderMerchantFacts(tx, {
        entityId: b.entity.id,
        storeIds: [b.store.id],
        viewerRole: "owner",
        merchantUserId: b.user.id,
        now: h.clock.now(),
      }),
    );
    expect(facts.stores[b.store.id]).toEqual({
      liveCount: 1,
      deliveringCount: 0,
      cartCount: 1,
      todoCount: 0,
    });
    await expect(
      h.tx.run((tx) =>
        orderMerchantFacts(tx, {
          entityId: b.entity.id,
          storeIds: [other.store.id],
          viewerRole: "owner",
          merchantUserId: b.user.id,
          now: h.clock.now(),
        }),
      ),
    ).rejects.toThrow("不属于主体");
    expect((await h.order.itemGet(b.actor, extra.item.id)).liveEpisodeCount).toBe(2);
    expect(await immutable(b)).toEqual(before);
  });
});
