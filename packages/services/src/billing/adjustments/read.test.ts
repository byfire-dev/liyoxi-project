import { afterEach, beforeEach, expect, it } from "vitest";
import {
  AccountLedgerQuerySchema,
  MerchantLedgerQuerySchema,
  PointAccountListQuerySchema,
} from "@liyoxi/contract";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import {
  captureHold,
  dramaHoldInput,
  holdDrama,
  priceDrama,
  refundHold,
  snapshotTables,
  topUp,
  useSeededDatabase,
} from "../../testing/index.js";
import { tables, world, pointConfirm } from "./__fixtures__/world.js";
import type { World } from "./__fixtures__/world.js";
const db = useSeededDatabase("services", { max: 1 });
let h: World;
beforeEach(async () => {
  await db.reset();
  h = await world(await db.prisma());
}, 60000);
afterEach(() => h?.close());
const merchant = (who: Awaited<ReturnType<World["subscribed"]>>) => ({
  ctx: createIdentityContext({
    actor: { type: "merchant", id: who.user.id, client: "weapp", role: "owner" },
    entityId: who.entityId,
    storeId: who.storeId,
  }),
  membership: {
    memberId: who.owner.id,
    entityId: who.entityId,
    storeId: who.storeId,
    role: "owner" as const,
    storeMode: "active" as const,
  },
});

it("账户按主体范围读真实余额、筛选汇总；过期GET零写且不展示调整动作", async () => {
  const who = await h.subscribed(),
    other = await h.subscribed(),
    manager = await h.actor("delivery_manager"),
    stranger = await h.actor("delivery_manager"),
    admin = await h.actor();
  await h.prisma.store.update({
    where: { id: who.storeId },
    data: { deliveryManagerId: manager.staff.staff.id },
  });
  await topUp(h, { entityId: who.entityId, points: 1200 });
  const before = await snapshotTables(h.prisma, tables);
  const page = await h.accounts.list(
    manager.staff,
    PointAccountListQuerySchema.parse({ sort: "-spendablePoints" }),
  );
  expect(page).toMatchObject({
    total: 1,
    items: [
      {
        pointAccountId: who.entityId,
        spendablePoints: 7800,
        planAvailablePoints: 6600,
        addonAvailablePoints: 1200,
      },
    ],
  });
  expect(await h.accounts.summary(manager.staff, {})).toMatchObject({
    accountCount: 1,
    activeAccountCount: 1,
    balancePoints: 7800,
    heldPoints: 0,
    grantedThisMonthPoints: 6600,
  });
  await expect(h.accounts.get(stranger.staff, who.entityId)).rejects.toMatchObject({
    error: "NOT_FOUND",
  });
  expect(
    (
      await h.accounts.list(
        manager.staff,
        PointAccountListQuerySchema.parse({ q: other.entity.name }),
      )
    ).items,
  ).toEqual([]);
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  h.clock.set(new Date(who.term.endsAt.getTime() + 1000));
  const stale = await snapshotTables(h.prisma, tables);
  expect(await h.accounts.get(manager.staff, who.entityId)).toMatchObject({
    subscription: { status: "expired" },
    spendablePoints: 0,
    planAvailablePoints: 0,
    addonAvailablePoints: 1200,
    isAddonSuspended: true,
    actions: [],
  });
  expect(await h.accounts.summary(admin.staff, { subStatus: "expired" })).toMatchObject({
    accountCount: 2,
    activeAccountCount: 0,
    balancePoints: 1200,
  });
  expect(await snapshotTables(h.prisma, tables)).toEqual(stale);
}, 60000);

it("真实多积分类型冻结按行游标不丢项；商家同次冻结合并，capture仅后台独立展示", async () => {
  const who = await h.subscribed(),
    admin = await h.actor(),
    drama = await h.make.drama(),
    staff = await h.make.staff();
  await topUp(h, { entityId: who.entityId, points: 1200 });
  await priceDrama(h, { dramaId: drama.id, points: 8000, staffId: staff.id });
  const ctx = createIdentityContext({
    actor: { type: "merchant", id: who.user.id, client: "weapp", role: "owner" },
    entityId: who.entityId,
    storeId: who.storeId,
    requestId: uuidv7(),
  });
  const mixed = await h.tx.run((tx) =>
    h.ledger.hold(tx, dramaHoldInput({ ...who, dramaId: drama.id, refId: uuidv7(), ctx })),
  );
  const q = AccountLedgerQuerySchema.parse({ tab: "use", limit: 1 });
  const first = await h.accounts.adminLedger(admin.staff, who.entityId, q);
  expect(first).toMatchObject({
    items: [{ ledgerOperationId: mixed.operationId, lotKind: "plan", deltaPoints: -6600 }],
    hasMore: true,
  });
  const second = await h.accounts.adminLedger(admin.staff, who.entityId, {
    ...q,
    cursor: first.nextCursor!,
  });
  expect(second).toMatchObject({
    items: [{ ledgerOperationId: mixed.operationId, lotKind: "addon", deltaPoints: -600 }],
    hasMore: false,
    nextCursor: null,
  });
  const bad = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as {
    seq: string;
  };
  bad.seq = "99999999999999999999";
  await expect(
    h.accounts.adminLedger(admin.staff, who.entityId, {
      ...q,
      cursor: Buffer.from(JSON.stringify(bad)).toString("base64url"),
    }),
  ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  await expect(
    h.accounts.adminLedger(admin.staff, who.entityId, {
      ...q,
      tab: "all",
      cursor: first.nextCursor!,
    }),
  ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  await captureHold(h, mixed.pointHoldId);
  const adminRows = await h.accounts.adminLedger(
    admin.staff,
    who.entityId,
    AccountLedgerQuerySchema.parse({ tab: "use" }),
  );
  expect(adminRows.items.filter((r) => r.opType === "capture")).toMatchObject([
    { lotKind: null, deltaPoints: 0, qty: 7200 },
  ]);
  const rows = await h.accounts.merchantLedger(
    merchant(who),
    MerchantLedgerQuerySchema.parse({ tab: "use" }),
  );
  expect(rows.items).toMatchObject([
    { opType: "hold", lotKind: "plan", holdStatus: "captured" },
    { opType: "hold", lotKind: "addon", holdStatus: "captured" },
  ]);
  expect(rows.items.some((r) => r.opType === "capture")).toBe(false);
}, 60000);

it("真实同事务两张冻结合并、不同事务requestId不猜合并；退回不泄露冻结状态与旧月导航", async () => {
  const who = await h.subscribed(2),
    staff = await h.make.staff(),
    drama = await h.make.drama();
  await priceDrama(h, { dramaId: drama.id, points: 1000, staffId: staff.id });
  const ctx = createIdentityContext({
    actor: { type: "merchant", id: who.user.id, client: "weapp", role: "owner" },
    entityId: who.entityId,
    storeId: who.storeId,
    requestId: uuidv7(),
  });
  const holds = await h.tx.run(async (tx) => {
    const a = await h.ledger.hold(
      tx,
      dramaHoldInput({ ...who, dramaId: drama.id, refId: uuidv7(), ctx }),
    );
    const b = await h.ledger.hold(
      tx,
      dramaHoldInput({ ...who, dramaId: drama.id, refId: uuidv7(), ctx }),
    );
    return [a, b];
  });
  await holdDrama(h, { ...who, dramaId: drama.id });
  const page = await h.accounts.merchantLedger(
    merchant(who),
    MerchantLedgerQuerySchema.parse({ tab: "use" }),
  );
  expect(page.items.map((r) => [r.itemCount, r.deltaPoints])).toEqual([
    [1, -900],
    [2, -1800],
  ]);
  await captureHold(h, holds[0]!.pointHoldId);
  await refundHold(h, { pointHoldId: holds[0]!.pointHoldId, qty: 300, reasonClass: "platform" });
  const gain = await h.accounts.merchantLedger(
    merchant(who),
    MerchantLedgerQuerySchema.parse({ tab: "gain" }),
  );
  expect(gain.items.find((r) => r.opType === "refund")).toMatchObject({
    holdStatus: null,
    deltaPoints: 300,
  });
  h.clock.set(new Date("2026-02-06T04:00:00Z"));
  const before = await snapshotTables(h.prisma, tables);
  const empty = await h.accounts.merchantLedger(
    merchant(who),
    MerchantLedgerQuerySchema.parse({ tab: "expire" }),
  );
  expect(empty).toMatchObject({
    items: [],
    month: "2026-02",
    prevMonth: "2026-01",
    firstEntryAt: "2026-01-05T04:00:00.000Z",
  });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  await expect(
    h.accounts.merchantLedger(merchant(who), MerchantLedgerQuerySchema.parse({ month: "2026-03" })),
  ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
}, 60000);

it("批准调整的流水保留历史原因、200字说明与真实TZ关联，详情GET零写", async () => {
  const who = await h.subscribed(),
    author = await h.actor(),
    reviewer = await h.actor("finance");
  const r = await h.svc.points.create(
    author,
    await h.adjustmentInput(who.entityId, { note: "补".repeat(200) }),
  );
  await h.svc.points.approve(reviewer, r.pointAdjustmentRequestId, pointConfirm(r));
  const before = await snapshotTables(h.prisma, tables);
  const rows = await h.accounts.adminLedger(
    reviewer.staff,
    who.entityId,
    AccountLedgerQuerySchema.parse({ tab: "gain" }),
  );
  expect(rows.items.find((x) => x.opType === "adjust")).toMatchObject({
    refNo: r.requestNo,
    title: "积分调整：制作问题补偿",
    deltaPoints: 100,
  });
  const merchantRows = await h.accounts.merchantLedger(
    merchant(who),
    MerchantLedgerQuerySchema.parse({ tab: "gain" }),
  );
  expect(merchantRows.items.find((x) => x.opType === "adjust")).toMatchObject({
    remark: "补".repeat(200),
    refNo: r.requestNo,
    holdStatus: null,
  });
  expect(await h.svc.points.get(reviewer.staff, r.pointAdjustmentRequestId)).toMatchObject({
    approval: { status: "approved" },
    applied: { spendableAfterPoints: 6700 },
  });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
}, 60000);

it("退款notice只来自真实周期挂载，未挂载的在途申请不冒充闸门；批准前资格变化整张单保持pending", async () => {
  const who = await h.subscribed(),
    author = await h.actor(),
    reviewer = await h.actor(),
    now = h.clock.now();
  const r = await h.svc.points.create(author, await h.adjustmentInput(who.entityId));
  // 退款尚未由本包实现；只准备一张待审批输入，不造支付/退款终态。
  const id = uuidv7(),
    a = await h.prisma.approvalRequest.create({
      data: {
        id: uuidv7(),
        kind: "plan_refund",
        category: "approval",
        subjectType: "billing_order",
        subjectId: who.order.id,
        entityId: who.entityId,
        status: "pending",
        requestNo: "TK20260105001",
        summarySnapshot: { title: "退款中夹具" },
        submitActorType: "staff",
        submitActorId: author.staff.staff.id,
        submitClient: "admin",
        requesterStaffId: author.staff.staff.id,
        dedupeKey: null,
        submittedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  const refund = await h.prisma.refundRequest.create({
    data: {
      id,
      approvalRequestId: a.id,
      source: "customer_service",
      entityId: who.entityId,
      billingOrderId: who.order.id,
      paymentTxnId: who.receipt.id,
      baseAmountFen: 600000,
      amountFen: 600000,
      breakdownSnapshot: {},
      ruleCode: "window",
      ruleText: "测试中的待审批输入",
      reasonCode: "RF001",
      note: "测试退款闸门",
      status: "pending_approval",
      createdAt: now,
      updatedAt: now,
    },
  });
  expect(await h.accounts.get(author.staff, who.entityId)).toMatchObject({
    isRefundPending: false,
    notices: { pendingRefund: null },
  });
  await h.prisma.subscriptionTerm.update({
    where: { id: who.term.id },
    data: { refundRequestId: refund.id, refundRule: "window" },
  });
  const before = await snapshotTables(h.prisma, tables);
  expect(await h.accounts.get(author.staff, who.entityId)).toMatchObject({
    isRefundPending: true,
    spendablePoints: 0,
    notices: {
      pendingRefund: {
        refundRequestId: refund.id,
        requestNo: a.requestNo,
        status: "pending_approval",
      },
    },
  });
  await expect(
    h.svc.points.approve(reviewer, r.pointAdjustmentRequestId, pointConfirm(r)),
  ).rejects.toMatchObject({
    error: "PRECONDITION_CHANGED",
    details: { reason: "account_inactive" },
  });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
}, 60000);
