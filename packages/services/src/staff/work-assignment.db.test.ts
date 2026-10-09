import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockRows, staffWorkSourcesOf, uuidv7 } from "../kernel/index.js";
import { sampleStaffContext, useSeededDatabase } from "../testing/index.js";
import { pickNext, prepareAssignmentPools, recommendedStaff } from "./assignment.js";
import { fullStaffWorld } from "./__fixtures__/full.js";
import type { FullStaffWorld } from "./__fixtures__/full.js";
import { assignPublisher } from "../delivery/index.js";

const db = useSeededDatabase("services", { label: "staffwork" });
const SLOW = 180_000;
let w: FullStaffWorld;
beforeAll(async () => {
  w = await fullStaffWorld(await db.prisma());
}, SLOW);
afterAll(() => w?.scope.close());
async function managerGraph() {
  const from = await w.person("delivery_manager"),
    to = await w.person("delivery_manager");
  const merchant = await w.make.subscribedMerchant();
  await w.prisma.store.update({
    where: { id: merchant.store.id },
    data: { deliveryManagerId: from.id },
  });
  const order = await w.make.dramaOrder({
    entityId: merchant.entity.id,
    storeId: merchant.store.id,
    deliveryManagerId: from.id,
  });
  const item = await w.make.orderItem({ dramaOrderId: order.id });
  const ticket = await w.make.deliveryTicket({ orderItemId: item.id, deliveryManagerId: from.id });
  const follow = await w.prisma.followUp.create({
    data: {
      id: uuidv7(),
      subjectType: "store",
      subjectId: merchant.store.id,
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      content: "过期未结联系",
      ownerStaffId: from.id,
      nextFollowAt: new Date(w.clock.now().getTime() - 60_000),
      actorType: "staff",
      actorId: w.operator.id,
      client: "admin",
      createdAt: w.clock.now(),
      updatedAt: w.clock.now(),
    },
  });
  return { from, to, merchant, order, item, ticket, follow };
}
describe("员工在办来源与原子改派", { timeout: SLOW }, () => {
  it("真实门店、未结单、工单、过期未结跟进，分项样本有界；已结订单不算", async () => {
    const g = await managerGraph();
    const summary = await w.service.openWork(w.ctx, g.from.id);
    expect(summary.total).toBe(4);
    expect(summary.bySource).toMatchObject([
      { source: "follow_up_owner", subjectType: "follow_up", count: 1 },
      { source: "store_manager", subjectType: "delivery_ticket", count: 1 },
      { source: "store_manager", subjectType: "drama_order", count: 1 },
      { source: "store_manager", subjectType: "store", count: 1 },
    ]);
    await w.prisma.dramaOrder.update({
      where: { id: g.order.id },
      data: { status: "cancelled", subStatus: "cancelled_before_start", closedAt: w.clock.now() },
    });
    expect((await w.service.openWork(w.ctx, g.from.id)).total).toBe(3);
    const emptyAssembly = { portEntries: () => new Map() };
    await expect(
      w.tx.run((tx) =>
        staffWorkSourcesOf(emptyAssembly).read(tx, { staffId: g.from.id, now: w.clock.now() }),
      ),
    ).rejects.toMatchObject({ error: "INTERNAL" });
  });
  it("禁用同一TX改四真实归属、历史/outbox/时限、清会话与池；错误确认不改任何行", async () => {
    const g = await managerGraph();
    await expect(
      w.service.disable(w.ctx, w.actor, g.from.id, {
        reason: "resigned",
        confirm: { staffNo: g.from.staffNo, openWorkCount: 4 },
      }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    expect(
      (await w.prisma.store.findUniqueOrThrow({ where: { id: g.merchant.store.id } }))
        .deliveryManagerId,
    ).toBe(g.from.id);
    const bad = {
      reason: "resigned" as const,
      handoverToStaffId: g.to.id,
      confirm: { staffNo: g.from.staffNo, openWorkCount: 3 },
    };
    await expect(w.service.disable(w.ctx, w.actor, g.from.id, bad)).rejects.toMatchObject({
      error: "CONFIRM_MISMATCH",
    });
    expect((await w.prisma.staff.findUniqueOrThrow({ where: { id: g.from.id } })).status).toBe(
      "active",
    );
    expect(await w.prisma.assignmentHistory.count({ where: { fromStaffId: g.from.id } })).toBe(0);
    const result = await w.service.disable(w.ctx, w.actor, g.from.id, {
      ...bad,
      confirm: { ...bad.confirm, openWorkCount: 4 },
    });
    expect(result.staff.status).toBe("disabled");
    expect(result.batchId).not.toBeNull();
    expect(
      (await w.prisma.store.findUniqueOrThrow({ where: { id: g.merchant.store.id } }))
        .deliveryManagerId,
    ).toBe(g.to.id);
    expect(
      (await w.prisma.dramaOrder.findUniqueOrThrow({ where: { id: g.order.id } }))
        .deliveryManagerId,
    ).toBe(g.to.id);
    expect(
      (await w.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: g.ticket.id } }))
        .deliveryManagerId,
    ).toBe(g.to.id);
    expect(
      (await w.prisma.followUp.findUniqueOrThrow({ where: { id: g.follow.id } })).ownerStaffId,
    ).toBe(g.to.id);
    const history = await w.prisma.assignmentHistory.findMany({
      where: { batchId: result.batchId! },
    });
    expect(history).toHaveLength(4);
    const contact = history.find((r) => r.subjectType === "store")!;
    expect(contact.contactDueAt).not.toBeNull();
    expect(contact.slaSnapshot).toMatchObject({ policy: "manager.first_contact" });
    expect(await w.prisma.timer.findFirst({ where: { subjectId: contact.id } })).toMatchObject({
      kind: "sla.breach",
      dedupeKey: `sla.breach:assignment_history:${contact.id}`,
    });
    expect(
      await w.prisma.outboxEvent.count({
        where: {
          eventType: "assignment.transferred",
          dedupeKey: `assignment.transferred:${result.batchId}`,
        },
      }),
    ).toBe(1);
  });
  it("移交任何后段失败整TX回滚；下一次真实改派仍能完成", async () => {
    const g = await managerGraph();
    const events = w.deps.events;
    w.deps.events = {
      emit: async () => {
        throw new Error("injected_emit_failure");
      },
    };
    await expect(
      w.service.handover(w.ctx, w.actor, g.from.id, {
        handoverToStaffId: g.to.id,
        reason: "reassigned",
      }),
    ).rejects.toThrow("injected_emit_failure");
    w.deps.events = events;
    expect(
      (await w.prisma.followUp.findUniqueOrThrow({ where: { id: g.follow.id } })).ownerStaffId,
    ).toBe(g.from.id);
    expect(await w.prisma.assignmentHistory.count({ where: { fromStaffId: g.from.id } })).toBe(0);
    await w.service.handover(w.ctx, w.actor, g.from.id, {
      handoverToStaffId: g.to.id,
      reason: "reassigned",
    });
    expect((await w.prisma.staff.findUniqueOrThrow({ where: { id: g.from.id } })).status).toBe(
      "active",
    );
  });
  it("已有指派持有员工共享锁时禁用等待；晚到指派锁后重读 disabled 拒绝", async () => {
    const from = await w.person("delivery_manager"),
      to = await w.person("delivery_manager");
    const store = await w.make.store();
    let acquired!: () => void, release!: () => void;
    const held = new Promise<void>((r) => {
      acquired = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const assignment = w.tx.run(async (tx) => {
      await lockRows(tx, "staff", [from.id], "share");
      acquired();
      await gate;
      await lockRows(tx, "store", [store.id]);
      await tx.store.update({ where: { id: store.id }, data: { deliveryManagerId: from.id } });
    });
    await held;
    const disabling = w.service.disable(w.ctx, w.actor, from.id, {
      handoverToStaffId: to.id,
      reason: "reassigned",
      confirm: { staffNo: from.staffNo, openWorkCount: 1 },
    });
    release();
    await Promise.all([assignment, disabling]);
    expect(
      (await w.prisma.store.findUniqueOrThrow({ where: { id: store.id } })).deliveryManagerId,
    ).toBe(to.id);
    await expect(
      w.tx.run(async (tx) => {
        await prepareAssignmentPools(tx, [], [from.id]);
        const row = await tx.staff.findUniqueOrThrow({ where: { id: from.id } });
        if (row.status !== "active") throw new Error("disabled_current_fact");
      }),
    ).rejects.toThrow("disabled_current_fact");
  });
  it("显示推荐零游标写，真实双连接轮询一人一次并回绕，同TX重入不倒退锁序", async () => {
    const a = await w.person("editor"),
      b = await w.person("editor");
    await w.prisma.assignmentPoolMember.createMany({
      data: [a, b].map((r) => ({
        pool: "editor",
        staffId: r.id,
        cityCode: "",
        onDuty: true,
        createdAt: w.clock.now(),
        updatedAt: w.clock.now(),
      })),
    });
    await w.prisma.assignmentCursor.deleteMany({ where: { pool: "editor", scopeKey: "all" } });
    await w.tx.run(async (tx) => {
      expect((await recommendedStaff(tx, "editor"))?.staffId).toBe([a.id, b.id].sort()[0]);
    });
    expect(
      await w.prisma.assignmentCursor.count({ where: { pool: "editor", scopeKey: "all" } }),
    ).toBe(0);
    const picks = await Promise.all(
      [1, 2].map(() => w.tx.run((tx) => pickNext(tx, "editor", "all"))),
    );
    expect(new Set(picks.map((r) => r?.staffId))).toEqual(new Set([a.id, b.id]));
    const again = await w.tx.run(async (tx) => {
      await prepareAssignmentPools(tx, [{ pool: "editor", scopeKey: "all" }]);
      const one = await pickNext(tx, "editor", "all");
      const two = await pickNext(tx, "editor", "all");
      return [one?.staffId, two?.staffId];
    });
    expect(new Set(again)).toEqual(new Set([a.id, b.id]));
  });
  it("城市池优先，空城市回退无限制池；客服离岗不参与", async () => {
    const exact = await w.person("delivery_manager"),
      fallback = await w.person("delivery_manager"),
      cs = await w.person("cs");
    await w.prisma.assignmentPoolMember.createMany({
      data: [
        {
          pool: "delivery_manager",
          staffId: exact.id,
          cityCode: "310100",
          onDuty: true,
          createdAt: w.clock.now(),
          updatedAt: w.clock.now(),
        },
        {
          pool: "delivery_manager",
          staffId: fallback.id,
          cityCode: "",
          onDuty: true,
          createdAt: w.clock.now(),
          updatedAt: w.clock.now(),
        },
        {
          pool: "cs",
          staffId: cs.id,
          cityCode: "",
          onDuty: false,
          createdAt: w.clock.now(),
          updatedAt: w.clock.now(),
        },
      ],
    });
    expect((await w.tx.run((tx) => pickNext(tx, "delivery_manager", "310100")))?.staffId).toBe(
      exact.id,
    );
    expect((await w.tx.run((tx) => pickNext(tx, "delivery_manager", "330100")))?.staffId).toBe(
      fallback.id,
    );
    expect(await w.tx.run((tx) => pickNext(tx, "cs", "all"))).toBeNull();
  });
  it("裁剪 summary/group/session 与真实当前角色，不将其他组成员泄露", async () => {
    const role = await w.prisma.staffRole.findUniqueOrThrow({ where: { key: "finance" } });
    await w.prisma.staffRole.update({
      where: { key: "finance" },
      data: {
        moduleLevels: { ...(role.moduleLevels as Record<string, string>), system: "v" },
        dataScope: "own",
      },
    });
    const row = await w.person("finance", false);
    const peer = await w.person("finance", false);
    const ctx = await sampleStaffContext(w.prisma, row.id);
    expect(ctx.dataScope).toBe("own");
    expect(ctx.scope.kind === "staff" ? [...ctx.scope.staffIds] : []).toEqual([row.id]);
    const counts = await w.service.summary(ctx, {});
    expect(counts.total).toBe(1);
    const group = await w.service.groups(ctx, {});
    expect(group.items.find((r) => r.staffGroupId === row.staffGroupId)?.memberCount).toBe(1);
    expect((await w.service.get(w.ctx, peer.id)).staffId).toBe(peer.id);
  });
  it("公开指派发布专员消费真实工单；终止未核查的剪辑与发布责任各一份，改派不复制处理人", async () => {
    const editor = await w.person("editor"),
      editorTo = await w.person("editor");
    const publisher = await w.person("publisher"),
      publisherTo = await w.person("publisher");
    const merchant = await w.make.subscribedMerchant();
    const order = await w.make.dramaOrder({
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
    });
    const item = await w.make.orderItem({ dramaOrderId: order.id });
    const ticket = await w.make.deliveryTicket({
      orderItemId: item.id,
      step: "terminated",
      editorId: editor.id,
    });
    const account = await w.prisma.channelAccount.create({
      data: {
        id: uuidv7(),
        entityId: ticket.entityId,
        storeId: ticket.storeId,
        platform: "douyin",
        accountName: "待下架测试账号",
        accountUid: ticket.id,
        accountUidNorm: ticket.id,
        status: "pending_verify",
        submittedAt: w.clock.now(),
        createdAt: w.clock.now(),
        updatedAt: w.clock.now(),
      },
    });
    const launch = await w.prisma.launchTask.create({
      data: {
        id: uuidv7(),
        entityId: ticket.entityId,
        storeId: ticket.storeId,
        orderItemId: item.id,
        deliveryTicketId: ticket.id,
        channelAccountId: account.id,
        platform: "douyin",
        reviewStatus: "pending",
        createdAt: w.clock.now(),
        updatedAt: w.clock.now(),
      },
    });
    const task = await w.prisma.takedownTask.create({
      data: {
        id: uuidv7(),
        entityId: ticket.entityId,
        storeId: ticket.storeId,
        orderItemId: item.id,
        deliveryTicketId: ticket.id,
        launchTaskId: launch.id,
        channelAccountId: account.id,
        triggerKind: "terminated_after_delivery",
        basis: "delivered_unverified",
        usageEndDate: w.clock.now(),
        dueDate: w.clock.now(),
        status: "pending_merchant",
        createdAt: w.clock.now(),
        updatedAt: w.clock.now(),
      },
    });
    await w.tx.run((tx) =>
      assignPublisher(tx, {
        ticketId: ticket.id,
        publisherId: publisher.id,
        staff: w.ctx,
        ctx: w.actor,
        now: w.clock.now(),
      }),
    );
    expect(
      await w.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticket.id } }),
    ).toMatchObject({
      publisherId: publisher.id,
      editorId: editor.id,
    });
    expect(
      await w.prisma.auditLog.count({
        where: { action: "delivery.ticket.assign_publisher", targetId: ticket.id },
      }),
    ).toBe(1);
    expect((await w.service.openWork(w.ctx, publisher.id)).bySource).toEqual([
      {
        source: "ticket_publisher",
        subjectType: "delivery_ticket",
        count: 1,
        samples: [{ subjectId: ticket.id, label: ticket.ticketNo }],
      },
    ]);
    expect((await w.service.openWork(w.ctx, editor.id)).total).toBe(1);
    await w.service.handover(w.ctx, w.actor, publisher.id, {
      handoverToStaffId: publisherTo.id,
      reason: "reassigned",
    });
    await w.service.handover(w.ctx, w.actor, editor.id, {
      handoverToStaffId: editorTo.id,
      reason: "reassigned",
    });
    expect(
      await w.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticket.id } }),
    ).toMatchObject({
      publisherId: publisherTo.id,
      editorId: editorTo.id,
    });
    expect(
      await w.prisma.assignmentHistory.findMany({
        where: { subjectId: ticket.id },
        orderBy: { source: "asc" },
      }),
    ).toMatchObject([
      { source: "ticket_editor", fromStaffId: editor.id, toStaffId: editorTo.id },
      { source: "ticket_publisher", fromStaffId: publisher.id, toStaffId: publisherTo.id },
    ]);
    expect(await w.prisma.assignmentHistory.count({ where: { subjectId: ticket.id } })).toBe(2);
    expect(await w.prisma.takedownTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject(
      { deliveryTicketId: ticket.id, checkedByStaffId: null },
    );
    await w.prisma.takedownTask.update({
      where: { id: task.id },
      data: { status: "void", updatedAt: w.clock.now() },
    });
    expect((await w.service.openWork(w.ctx, publisherTo.id)).total).toBe(0);
    expect((await w.service.openWork(w.ctx, editorTo.id)).total).toBe(0);
  });
  it("真实公开指派持锁提交后禁用原子移交；晚到指派重读disabled拒绝且不新增审计", async () => {
    const from = await w.person("publisher"),
      to = await w.person("publisher");
    const merchant = await w.make.subscribedMerchant();
    const order = await w.make.dramaOrder({
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
    });
    const item = await w.make.orderItem({ dramaOrderId: order.id });
    const ticket = await w.make.deliveryTicket({ orderItemId: item.id, step: "plan_confirm" });
    let acquired!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const assignment = w.tx.run(async (tx) => {
      await assignPublisher(tx, {
        ticketId: ticket.id,
        publisherId: from.id,
        staff: w.ctx,
        ctx: w.actor,
        now: w.clock.now(),
      });
      acquired();
      await gate;
    });
    await held;
    const disabling = w.service.disable(w.ctx, w.actor, from.id, {
      handoverToStaffId: to.id,
      reason: "reassigned",
      confirm: { staffNo: from.staffNo, openWorkCount: 1 },
    });
    release();
    await Promise.all([assignment, disabling]);
    expect(
      await w.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticket.id } }),
    ).toMatchObject({ publisherId: to.id });
    expect(await w.prisma.staff.findUniqueOrThrow({ where: { id: from.id } })).toMatchObject({
      status: "disabled",
    });
    const auditCount = await w.prisma.auditLog.count({
      where: { action: "delivery.ticket.assign_publisher", targetId: ticket.id },
    });
    await expect(
      w.tx.run((tx) =>
        assignPublisher(tx, {
          ticketId: ticket.id,
          publisherId: from.id,
          staff: w.ctx,
          ctx: w.actor,
          now: w.clock.now(),
        }),
      ),
    ).rejects.toMatchObject({
      error: "ASSIGNEE_INVALID",
      details: { staffId: from.id, reason: "not_active" },
    });
    expect(
      await w.prisma.auditLog.count({
        where: { action: "delivery.ticket.assign_publisher", targetId: ticket.id },
      }),
    ).toBe(auditCount);
  });
});
