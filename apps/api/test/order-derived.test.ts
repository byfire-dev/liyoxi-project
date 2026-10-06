// W1-17a："m.order.get"、"m.orderItem.get"、"admin.order.get" 的开工后真实履约字段。
import { beforeAll, expect, it } from "vitest";
import {
  createIdentityContext,
  createSla,
  createTickets,
  prepareTicketAssignees,
  runSeed,
  uuidv7,
} from "@liyoxi/services";
import { createFactories, prepareOrderFixture, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import {
  AdminOrderDetailSchema,
  DramaSnapshotSchema,
  OrderDetailSchema,
  OrderItemDetailSchema,
} from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi, TestRequestInit } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
const h = useTestApi();
let api: TestApi,
  owner: SignedInMerchant,
  admin: SignedInStaff,
  scope: { entityId: string; storeId: string; memberId: string },
  pending: { orderId: string; itemId: string },
  started: { orderId: string; itemId: string; planId: string; ticketId: string },
  peer = 0;
const request = (path: string, options: TestRequestInit = {}, staff = false) =>
  api.request(`/api/v1${path}`, {
    ...options,
    headers: {
      ...(staff ? admin.headers : owner.withStore(scope.storeId)),
      ...options.headers,
    },
    peer: `198.19.217.${++peer % 250}`,
  });
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: unknown }).data;
}
async function get(path: string, staff = false) {
  const response = await request(path, {}, staff);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return data(response);
}
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
  const prisma = await h.db.prisma(),
    fixture = await prepareOrderFixture(prisma, api.runtime, api.clock, {
      ...scope,
      merchantUserId: owner.merchantUserId,
    }),
    made = OrderDetailSchema.parse(
      await data(
        await request("/m/orders", {
          method: "POST",
          json: fixture.input,
          headers: { "Idempotency-Key": uuidv7() },
        }),
      ),
    );
  pending = { orderId: made.orderId, itemId: made.items[0]!.orderItemId };
  const make = createFactories({ db: prisma, clock: api.clock }),
    manager = await make.staff({ staffRoleKey: "delivery_manager" });
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  await prisma.store.update({
    where: { id: scope.storeId },
    data: { deliveryManagerId: manager.id },
  });
  // a 不实施开工扣减事务：工厂准备已经开工/扣减的历史事实，再调用真实建工单与确认主链。
  const original = await prisma.dramaOrder.findUniqueOrThrow({ where: { id: pending.orderId } }),
    source = await prisma.orderItem.findUniqueOrThrow({ where: { id: pending.itemId } }),
    order = await make.dramaOrder({
      entityId: scope.entityId,
      storeId: scope.storeId,
      placedByUserId: owner.merchantUserId,
      subscriptionTermId: original.subscriptionTermId,
      status: "producing",
      focusCodes: ["W115F"],
      deliveryManagerId: manager.id,
    }),
    item = await make.orderItem({
      dramaOrderId: order.id,
      dramaId: source.dramaId,
      dramaSnapshot: DramaSnapshotSchema.parse(source.dramaSnapshot),
      phase: "producing",
    });
  await prisma.orderItemAccount.create({
    data: {
      orderItemId: item.id,
      channelAccountId: fixture.channelAccountId,
      platform: "douyin",
      createdAt: api.clock.now(),
    },
  });
  const r = api.runtime,
    tickets = await r.tx.run(async (tx) => {
      await prepareTicketAssignees(tx, order.id);
      return createTickets(
        tx,
        {
          tx: r.tx,
          clock: r.clock,
          assembly: r.assembly,
          flow: r.flow,
          events: r.events,
          sla: createSla({ clock: r.clock, assembly: r.assembly }),
        },
        fixture.actor.ctx,
        { dramaOrderId: order.id },
      );
    });
  started = {
    orderId: order.id,
    itemId: item.id,
    planId: tickets.deliveryPlanId,
    ticketId: tickets.deliveryTicketIds[0]!,
  };
  await data(
    await request(
      `/admin/delivery-plans/${started.planId}/draft`,
      {
        method: "PUT",
        headers: { "Idempotency-Key": uuidv7() },
        json: {
          draftLockVersion: 0,
          content: {
            focusCodes: ["W115F"],
            referenceAssetIds: [],
            note: null,
            launchMode: "merchant_self",
            items: [
              {
                orderItemId: item.id,
                channelAccountIds: [fixture.channelAccountId],
                placements: [],
                agreedLaunchDate: addDays(calendarDate(api.clock.now()), 30),
                expectedDeliveryDate: null,
              },
            ],
          },
        },
      },
      true,
    ),
  );
  await data(
    await request(
      `/admin/delivery-plans/${started.planId}/push`,
      {
        method: "POST",
        json: { draftLockVersion: 1 },
        headers: { "Idempotency-Key": uuidv7() },
      },
      true,
    ),
  );
  await data(
    await request(`/m/delivery-plans/${started.planId}/confirm`, {
      method: "POST",
      json: { versionNo: 1 },
      headers: { "Idempotency-Key": uuidv7() },
    }),
  );
}, 180000);
it(
  "三GET开工前为null，真实确认后工单/方案/里程碑来自同一事实且零业务写",
  { timeout: 90000 },
  async () => {
    const prisma = await h.db.prisma(),
      snapshot = async () => ({
        orders: await prisma.dramaOrder.findMany({
          where: { entityId: scope.entityId },
          orderBy: { id: "asc" },
        }),
        items: await prisma.orderItem.findMany({
          where: { entityId: scope.entityId },
          orderBy: { id: "asc" },
        }),
        tickets: await prisma.deliveryTicket.findMany({
          where: { entityId: scope.entityId },
          orderBy: { id: "asc" },
        }),
        plans: await prisma.deliveryPlan.findMany({
          where: { entityId: scope.entityId },
          orderBy: { id: "asc" },
        }),
        ledger: await prisma.ledgerOperation.count(),
        audit: await prisma.auditLog.count(),
        history: await prisma.statusTransition.count(),
        events: await prisma.outboxEvent.count(),
      }),
      before = await snapshot();
    const unstarted = OrderDetailSchema.parse(await get(`/m/orders/${pending.orderId}`));
    expect(unstarted.deliveryPlan).toBeNull();
    expect(unstarted.items[0]!.ticketStep).toBeNull();
    expect(
      unstarted.items[0]!.timeline.filter((n) => n.key !== "submitted").every(
        (n) => n.state !== "done",
      ),
    ).toBe(true);
    expect(
      OrderItemDetailSchema.parse(await get(`/m/order-items/${pending.itemId}`)).ticketStep,
    ).toBeNull();
    const unstartedAdmin = AdminOrderDetailSchema.parse(
      await get(`/admin/orders/${pending.orderId}`, true),
    );
    expect(unstartedAdmin.deliveryPlan).toBeNull();
    expect(unstartedAdmin.items[0]!.ticket).toBeNull();
    const ticket = await prisma.deliveryTicket.findUniqueOrThrow({
        where: { id: started.ticketId },
      }),
      detail = OrderDetailSchema.parse(await get(`/m/orders/${started.orderId}`));
    expect(ticket.step).toBe("sample_making");
    expect(detail).toMatchObject({
      status: "producing",
      subStatus: "sample_making",
      deliveryPlan: {
        deliveryPlanId: started.planId,
        summaryVersionNo: 1,
        confirmedVersionNo: 1,
        focus: [{ code: "W115F", name: "主推服务" }],
        launchMode: "merchant_self",
      },
    });
    expect(detail.items[0]!.ticketStep).toBe(ticket.step);
    for (const [key, at] of [
      ["manager_assigned", ticket.assignedAt],
      ["plan_confirmed", ticket.planConfirmedAt],
      ["ads_confirmed", ticket.adsReadyAt],
    ] as const)
      expect(detail.items[0]!.timeline.find((n) => n.key === key)).toMatchObject({
        state: "done",
        at: at!.toISOString(),
      });
    expect(
      OrderItemDetailSchema.parse(await get(`/m/order-items/${started.itemId}`)).ticketStep,
    ).toBe(ticket.step);
    const adminDetail = AdminOrderDetailSchema.parse(
      await get(`/admin/orders/${started.orderId}`, true),
    );
    expect(adminDetail.deliveryPlan).toMatchObject({
      deliveryPlanId: started.planId,
      currentVersionNo: 1,
      confirmedVersionNo: 1,
      launchMode: "merchant_self",
    });
    expect(adminDetail.items[0]!.ticket).toEqual({
      deliveryTicketId: ticket.id,
      ticketNo: ticket.ticketNo,
      step: ticket.step,
      isPaused: false,
    });
    expect(await snapshot()).toEqual(before);
  },
);
