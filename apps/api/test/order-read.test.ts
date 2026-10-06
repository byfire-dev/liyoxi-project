// W1-15b：12 个真实生产处理器，C50 与零资金写；旧店员黄金字段保持。
import { beforeAll, describe, expect, it } from "vitest";
import { createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import {
  createFactories,
  prepareOrderFixture,
  signInAsStaff,
  createLedgerHarness,
  priceDrama,
} from "@liyoxi/services/testing";
import type { SignedInStaff, FakeStorage } from "@liyoxi/services/testing";
import {
  CartItemSchema,
  CartListSchema,
  CartAcceptResultSchema,
  MerchantOrderListSchema,
  OrderDetailSchema,
  MerchantOrderItemListSchema,
  OrderItemSummarySchema,
  OrderItemDetailSchema,
  AdminOrderListSchema,
  AdminOrderSummarySchema,
  AdminOrderDetailSchema,
} from "@liyoxi/contract";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi, TestRequestInit } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { HANDLERS } from "../src/routes/index.js";
const h = useTestApi();
let api: TestApi,
  owner: SignedInMerchant,
  clerk: SignedInMerchant,
  admin: SignedInStaff,
  manager: SignedInStaff,
  groupmate: SignedInStaff,
  finance: SignedInStaff;
let scope: { entityId: string; storeId: string; memberId: string },
  fixture: Awaited<ReturnType<typeof prepareOrderFixture>>,
  orderId: string,
  itemId: string,
  otherStoreId: string,
  peer = 0;
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: unknown }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
const request = (
  path: string,
  options: TestRequestInit = {},
  who = owner,
  storeId = scope.storeId,
) =>
  api.request(`/api/v1${path}`, {
    ...options,
    headers: { ...who.withStore(storeId), ...options.headers },
    peer: `198.19.215.${++peer % 250}`,
  });
const staffGet = (path: string, staff = admin) =>
  api.request(`/api/v1/admin/${path}`, {
    headers: staff.headers,
    peer: `198.19.216.${++peer % 250}`,
  });
beforeAll(async () => {
  api = await h.start();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(h, api);
  owner = await signInAsMerchant(api);
  scope = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  const prisma = await h.db.prisma();
  fixture = await prepareOrderFixture(prisma, api.runtime, api.clock, {
    ...scope,
    merchantUserId: owner.merchantUserId,
  });
  const create = await request("/m/orders", {
    method: "POST",
    json: fixture.input,
    headers: { "Idempotency-Key": uuidv7() },
  });
  const made = OrderDetailSchema.parse(await data(create));
  orderId = made.orderId;
  itemId = made.items[0]!.orderItemId;
  clerk = await signInAsMerchant(api);
  const make = createFactories({ db: prisma, clock: api.clock }),
    member = await make.entityMember({
      entityId: scope.entityId,
      merchantUserId: clerk.merchantUserId,
    });
  await make.storeMember({
    entityMemberId: member.id,
    storeId: scope.storeId,
    addedByMemberId: scope.memberId,
  });
  otherStoreId = (await make.store({ entityId: scope.entityId })).id;
  admin = await signInAsStaff(prisma, { roleKey: "super_admin" });
  manager = await signInAsStaff(prisma, { roleKey: "delivery_manager" });
  groupmate = await signInAsStaff(prisma, { roleKey: "delivery_manager" });
  finance = await signInAsStaff(prisma, { roleKey: "finance" });
  await prisma.store.update({
    where: { id: scope.storeId },
    data: { deliveryManagerId: manager.staff.id },
  });
}, 180000);
const merchantOps = [
  "m.cartItem.list",
  "m.cartItem.create",
  "m.cartItem.delete",
  "m.cartItem.acceptPrice",
  "m.order.list",
  "m.order.get",
  "m.orderItem.list",
  "m.orderItem.summary",
  "m.orderItem.get",
];
const adminOps = ["admin.order.list", "admin.order.summary", "admin.order.get"];
async function noFinancialWrite() {
  return api.runtime.tx.run(async (tx) => ({
    account: await tx.billingAccount.findUnique({ where: { entityId: scope.entityId } }),
    lots: await tx.pointLot.findMany({
      where: { entityId: scope.entityId },
      orderBy: { id: "asc" },
    }),
    holds: await tx.pointHold.findMany({
      where: { entityId: scope.entityId },
      orderBy: { id: "asc" },
    }),
    ledger: await tx.ledgerOperation.count({ where: { entityId: scope.entityId } }),
    audits: await tx.auditLog.count(),
    events: await tx.outboxEvent.count(),
    history: await tx.statusTransition.count(),
  }));
}
describe("选剧单与订单读侧12接口", { timeout: 90000 }, () => {
  it("m.cartItem.create/list/acceptPrice/delete：天然重复保存P、required同键C50与删除重放", async () => {
    for (const op of [...merchantOps, ...adminOps])
      expect(HANDLERS.some((h) => h.route.operationId === op)).toBe(true);
    const before = await noFinancialWrite(),
      first = CartItemSchema.parse(
        await data(
          await request("/m/cart-items", { method: "POST", json: { dramaId: fixture.dramaId } }),
        ),
      );
    expect(first).toMatchObject({ state: "valid", snapshotPricePoints: 101, discountedPoints: 91 });
    expect(first.drama.posterUrl).not.toBeNull();
    const list = CartListSchema.parse(await data(await request("/m/cart-items")));
    expect(list.items.map((i) => i.cartItemId)).toContain(first.cartItemId);
    const duplicate = CartItemSchema.parse(
      await data(
        await request("/m/cart-items", { method: "POST", json: { dramaId: fixture.dramaId } }),
      ),
    );
    expect(duplicate.cartItemId).toBe(first.cartItemId);
    const prisma = await h.db.prisma();
    api.clock.advance(1);
    await priceDrama(createLedgerHarness(prisma, { clock: api.clock }), {
      dramaId: fixture.dramaId,
      points: 211,
      staffId: admin.staff.id,
    });
    expect(CartListSchema.parse(await data(await request("/m/cart-items"))).items[0]).toMatchObject(
      { state: "price_changed", currentPricePoints: 211 },
    );
    const path = `/m/cart-items/${first.cartItemId}/accept-price`,
      input = { acceptedPricePoints: 211 },
      key = uuidv7();
    await error(
      await request(path, {
        method: "POST",
        json: { acceptedPricePoints: 190 },
        headers: { "Idempotency-Key": uuidv7() },
      }),
      409,
      "CART_PRICE_CHANGED",
    );
    await error(
      await request(path, { method: "POST", json: input }),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    const accepted = CartAcceptResultSchema.parse(
      await data(
        await request(path, { method: "POST", json: input, headers: { "Idempotency-Key": key } }),
      ),
    );
    expect(accepted).toMatchObject({ state: "valid", replayed: false, snapshotPricePoints: 211 });
    expect(accepted.drama.posterUrl).not.toBeNull();
    const storage = api.runtime.providers.storage as FakeStorage,
      count = storage.callsOf("presignGet").length;
    const replayResponse = await request(path, {
      method: "POST",
      json: input,
      headers: { "Idempotency-Key": key },
    });
    expect(replayResponse.headers.get("Idempotent-Replayed")).toBe("true");
    expect(CartAcceptResultSchema.parse(await data(replayResponse))).toMatchObject({
      replayed: true,
      drama: { posterUrl: null },
    });
    expect(storage.callsOf("presignGet")).toHaveLength(count);
    const saved = await api.runtime.tx.run((tx) =>
      tx.idempotencyRecord.findUniqueOrThrow({
        where: {
          scope_actorKey_key: {
            scope: "m.cartItem.acceptPrice",
            actorKey: `merchant:${owner.merchantUserId}`,
            key,
          },
        },
      }),
    );
    expect(CartAcceptResultSchema.parse(saved.result).drama.posterUrl).toBeNull();
    await error(
      await request(
        `/m/cart-items/${first.cartItemId}`,
        { method: "DELETE", headers: { "Idempotency-Key": uuidv7() } },
        owner,
        otherStoreId,
      ),
      404,
      "NOT_FOUND",
    );
    const deleteKey = uuidv7(),
      remove = () =>
        request(`/m/cart-items/${first.cartItemId}`, {
          method: "DELETE",
          headers: { "Idempotency-Key": deleteKey },
        });
    expect(await data(await remove())).toBeNull();
    expect(await data(await remove())).toBeNull();
    expect(await noFinancialWrite()).toEqual(before);
  });
  it("m.order.list/get 与 m.orderItem.list/summary/get：快照与签名、范围404、GET零资金/审计写", async () => {
    const before = await noFinancialWrite(),
      orders = MerchantOrderListSchema.parse(await data(await request("/m/orders?tab=producing")));
    expect(orders.items.map((r) => r.orderId)).toEqual([orderId]);
    const detail = OrderDetailSchema.parse(await data(await request(`/m/orders/${orderId}`)));
    expect(detail.items[0]).toMatchObject({
      orderItemId: itemId,
      listPricePoints: 101,
      chargePoints: 91,
    });
    expect(detail.items[0]!.posterUrl).not.toBeNull();
    expect(
      MerchantOrderItemListSchema.parse(
        await data(await request("/m/order-items?tab=to_launch")),
      ).items.map((r) => r.orderItemId),
    ).toEqual([itemId]);
    expect(
      OrderItemSummarySchema.parse(
        await data(await request(`/m/order-items/summary?orderId=${orderId}`)),
      ),
    ).toEqual({ all: 1, live: 0, to_launch: 1, ended: 0, delivering: 0 });
    expect(
      OrderItemDetailSchema.parse(await data(await request(`/m/order-items/${itemId}`))),
    ).toMatchObject({ orderId, phase: "pending_start", remainingDays: null });
    for (const path of [
      `/m/orders/${orderId}`,
      `/m/order-items/${itemId}`,
      `/m/order-items?orderId=${orderId}`,
      `/m/order-items/summary?orderId=${orderId}`,
    ])
      await error(await request(path, {}, owner, otherStoreId), 404, "NOT_FOUND");
    expect(await noFinancialWrite()).toEqual(before);
  });
  it("admin.order.list/summary/get：真实all/group/own、模块拒绝、完整typed详情，GET零资金/访问审计", async () => {
    const before = await noFinancialWrite(),
      list = AdminOrderListSchema.parse(
        await data(await staffGet(`orders?entityId=${scope.entityId}&pageSize=1`)),
      ),
      summary = AdminOrderSummarySchema.parse(
        await data(await staffGet(`orders/summary?entityId=${scope.entityId}`)),
      );
    expect(list.total).toBe(1);
    expect(list.items[0]!.orderId).toBe(orderId);
    expect(summary.tabs).toMatchObject({ all: 1, pending_start: 1 });
    expect(Object.keys(summary.tabs)).toHaveLength(9);
    const detail = AdminOrderDetailSchema.parse(await data(await staffGet(`orders/${orderId}`)));
    expect(detail.items[0]!.pointHold).toMatchObject({ status: "held" });
    expect(detail.pointsBreakdown).toMatchObject({ totalChargePoints: 91, planPoints: 91 });
    expect(AdminOrderListSchema.parse(await data(await staffGet("orders", manager))).total).toBe(1);
    expect(
      AdminOrderSummarySchema.parse(await data(await staffGet("orders/summary", manager))).tabs.all,
    ).toBe(1);
    await data(await staffGet(`orders/${orderId}`, manager));
    expect(AdminOrderListSchema.parse(await data(await staffGet("orders", groupmate))).total).toBe(
      0,
    );
    await error(await staffGet(`orders/${orderId}`, groupmate), 404, "NOT_FOUND");
    const prisma = await h.db.prisma(),
      lead = await signInAsStaff(prisma, {
        roleKey: "delivery_manager",
        isLead: true,
        staffGroupId: manager.staff.staffGroupId,
      });
    expect(AdminOrderListSchema.parse(await data(await staffGet("orders", lead))).total).toBe(1);
    expect(
      AdminOrderSummarySchema.parse(await data(await staffGet("orders/summary", lead))).tabs.all,
    ).toBe(1);
    await data(await staffGet(`orders/${orderId}`, lead));
    const editor = await signInAsStaff(prisma, { roleKey: "editor" });
    for (const path of ["orders", "orders/summary", `orders/${orderId}`]) {
      await data(await staffGet(path, finance));
      await error(await staffGet(path, editor), 403, "PERMISSION_DENIED");
    }
    // 建测试员工/会话会增加身份表；账本与业务审计快照保持不变。
    expect(await noFinancialWrite()).toEqual(before);
  });
  it("商城三项非零事实接真实接口，门店隔离且店员/游客不返回老板字段", async () => {
    const prisma = await h.db.prisma(),
      make = createFactories({ db: prisma, clock: api.clock }),
      original = await prisma.dramaOrder.findUniqueOrThrow({ where: { id: orderId } }),
      snapshot = await api.runtime.tx.run((tx) =>
        api.runtime.content.assertOrderable(tx, fixture.dramaId, ["douyin"]),
      ),
      live = await make.dramaOrder({
        entityId: scope.entityId,
        storeId: scope.storeId,
        placedByUserId: owner.merchantUserId,
        subscriptionTermId: original.subscriptionTermId,
        status: "live",
      });
    await make.orderItem({
      dramaOrderId: live.id,
      dramaId: fixture.dramaId,
      dramaSnapshot: snapshot,
      phase: "live",
      liveEpisodeCount: 2,
    });
    const cart = CartItemSchema.parse(
        await data(
          await request("/m/cart-items", {
            method: "POST",
            json: { dramaId: fixture.dramaId },
          }),
        ),
      ),
      before = await noFinancialWrite();
    expect(await data(await request("/m/home"))).toMatchObject({
      cartCount: 1,
      launchOverview: { liveItemCount: 1, liveEpisodeCount: 2 },
    });
    expect(await data(await request(`/m/dramas/${fixture.dramaId}`))).toMatchObject({
      owner: { cartItemId: cart.cartItemId },
    });
    expect(await data(await request("/m/home", {}, owner, otherStoreId))).toMatchObject({
      cartCount: 0,
      launchOverview: { liveItemCount: 0, liveEpisodeCount: 0 },
    });
    expect(
      await data(await request(`/m/dramas/${fixture.dramaId}`, {}, owner, otherStoreId)),
    ).toMatchObject({ owner: { cartItemId: null } });
    expect(await data(await request("/m/home", {}, clerk))).not.toHaveProperty("cartCount");
    expect(await data(await request(`/m/dramas/${fixture.dramaId}`, {}, clerk))).not.toHaveProperty(
      "owner",
    );
    expect(
      await data(await api.request("/api/v1/m/home", { peer: "198.19.217.1" })),
    ).not.toHaveProperty("cartCount");
    expect(
      await data(
        await api.request(`/api/v1/m/dramas/${fixture.dramaId}`, { peer: "198.19.217.2" }),
      ),
    ).not.toHaveProperty("owner");
    expect(await noFinancialWrite()).toEqual(before);
  });
  it("九条商家接口真实店员403；已停用老板纯订单读可用而加入403", async () => {
    for (const path of [
      "/m/cart-items",
      "/m/orders",
      `/m/orders/${orderId}`,
      "/m/order-items",
      "/m/order-items/summary",
      `/m/order-items/${itemId}`,
    ])
      await error(await request(path, {}, clerk), 403, "ROLE_FORBIDDEN");
    await error(
      await request("/m/cart-items", { method: "POST", json: { dramaId: fixture.dramaId } }, clerk),
      403,
      "ROLE_FORBIDDEN",
    );
    await error(
      await request(
        `/m/cart-items/${uuidv7()}`,
        { method: "DELETE", headers: { "Idempotency-Key": uuidv7() } },
        clerk,
      ),
      403,
      "ROLE_FORBIDDEN",
    );
    await error(
      await request(
        `/m/cart-items/${uuidv7()}/accept-price`,
        {
          method: "POST",
          json: { acceptedPricePoints: 211 },
          headers: { "Idempotency-Key": uuidv7() },
        },
        clerk,
      ),
      403,
      "ROLE_FORBIDDEN",
    );
    const prisma = await h.db.prisma(),
      archived = await createFactories({ db: prisma, clock: api.clock }).store({
        entityId: scope.entityId,
        lifecycle: "archived",
        archivedAt: api.clock.now(),
        archiveActorType: "merchant",
        archiveActorId: owner.merchantUserId,
        archiveClient: "weapp",
        archiveReason: "by_owner",
      });
    expect(
      MerchantOrderListSchema.parse(await data(await request("/m/orders", {}, owner, archived.id)))
        .items,
    ).toEqual([]);
    expect(
      MerchantOrderItemListSchema.parse(
        await data(await request("/m/order-items", {}, owner, archived.id)),
      ).items,
    ).toEqual([]);
    await error(
      await request(
        "/m/cart-items",
        { method: "POST", json: { dramaId: fixture.dramaId } },
        owner,
        archived.id,
      ),
      403,
      "STORE_ARCHIVED",
    );
  });
});
