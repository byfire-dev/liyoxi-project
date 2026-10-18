import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../kernel/index.js";
import { assignPublisher } from "../delivery/index.js";
import { useSeededDatabase } from "./index.js";
import { fullStaffWorld } from "./staff-full.js";
import type { FullStaffWorld } from "./staff-full.js";

const db = useSeededDatabase("services", { label: "staffpub" });
const SLOW = 180_000;
let w: FullStaffWorld;
beforeAll(async () => {
  w = await fullStaffWorld(await db.prisma());
}, SLOW);
afterAll(() => w?.scope.close());

describe("员工公开指派与禁用的真实跨域消费", { timeout: SLOW }, () => {
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
