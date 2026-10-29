import { beforeAll, describe, expect, it } from "vitest";
import { ChecklistItemsSchema, EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { HANDLERS } from "../src/routes/index.js";
import { deliveryOf } from "../src/routes/delivery.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
let api: TestApi,
  prisma: Awaited<ReturnType<typeof handle.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  admin: SignedInStaff,
  manager: SignedInStaff,
  outside: SignedInStaff,
  editor: SignedInStaff,
  publisher: SignedInStaff,
  reasonCode: string;
let peer = 0;
const routes = [
  ["admin.deliveryTicket.activity.list", "GET", "/delivery-tickets/:id/activities"],
  ["admin.deliveryTicket.assignEditor", "POST", "/delivery-tickets/:id/assign-editor"],
  ["admin.deliveryTicket.assignPublisher", "POST", "/delivery-tickets/:id/assign-publisher"],
  ["admin.deliveryTicket.forceTransition", "POST", "/delivery-tickets/:id/force-transition"],
  ["admin.deliveryTicket.reevaluate", "POST", "/delivery-tickets/:id/reevaluate"],
  ["admin.deliveryTicket.reissue.create", "POST", "/delivery-tickets/:id/reissues"],
  ["admin.deliveryTicket.remind", "POST", "/delivery-tickets/:id/remind"],
  ["admin.deliveryTicket.rework", "POST", "/delivery-tickets/:id/rework"],
  ["admin.orderItem.rescheduleLaunch", "POST", "/order-items/:id/reschedule-launch"],
  ["admin.reissue.cancel", "POST", "/reissues/:id/cancel"],
  ["admin.reissue.publish", "POST", "/reissues/:id/publish"],
] as const;
type Operation = (typeof routes)[number][0];
const requested = new Set<Operation>();
function request(
  operation: Operation,
  id: string,
  json?: unknown,
  actor = admin,
  key: string | null = uuidv7(),
  query = "",
) {
  requested.add(operation);
  const [, method, path] = routes.find((r) => r[0] === operation)!;
  return api.request(`/api/v1/admin${path.replace(":id", id)}${query}`, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: {
      ...actor.headers,
      ...(method === "POST" && key ? { "Idempotency-Key": key } : {}),
    },
    peer: `198.19.53.${++peer}`,
  });
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
const dateAfter = (days: number) =>
  new Date(api.clock.now().getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** 本域的初始业务行夹具；动作本身全部经真实 HTTP、鉴权、事务与状态机。 */
async function fixture(
  step = "plan_confirm",
  planState: "drafting" | "pending_confirm" | "confirmed" = "drafting",
) {
  const now = api.clock.now(),
    order = await make.dramaOrder({ status: "producing", deliveryManagerId: manager.staff.id }),
    item = await make.orderItem({
      dramaOrderId: order.id,
      phase: "producing",
      episodeCount: 2,
      agreedLaunchDate: new Date(dateAfter(20)),
      dramaSnapshot: { title: "W503 HTTP 虚构短剧", allowedPlacements: [] },
    }),
    ticket = await make.deliveryTicket({
      orderItemId: item.id,
      step,
      deliveryManagerId: manager.staff.id,
      publisherId: publisher.staff.id,
      ...(step === "awaiting_launch" ? { deliveredAt: now } : {}),
    });
  await prisma.store.update({
    where: { id: order.storeId },
    data: { deliveryManagerId: manager.staff.id },
  });
  await prisma.deliveryTicketStage.create({
    data: {
      id: uuidv7(),
      deliveryTicketId: ticket.id,
      step,
      visitNo: 1,
      enteredAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  const content = {
    focusTags: ["HTTP 验收"],
    referenceAssetIds: [],
    note: null,
    launchMode: "merchant_self",
    items: [
      {
        orderItemId: item.id,
        accounts: [],
        placements: [],
        agreedLaunchDate: dateAfter(20),
        expectedDeliveryDate: null,
      },
    ],
  };
  const plan = await prisma.deliveryPlan.create({
    data: {
      id: uuidv7(),
      entityId: order.entityId,
      storeId: order.storeId,
      dramaOrderId: order.id,
      status: planState,
      draft: content,
      currentVersionNo: planState === "drafting" ? 0 : 1,
      confirmedVersionNo: planState === "confirmed" ? 1 : null,
      ...(planState === "drafting" ? {} : { pushedAt: now }),
      ...(planState === "confirmed" ? { confirmedAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    },
  });
  if (planState !== "drafting")
    await prisma.deliveryPlanVersion.create({
      data: {
        id: uuidv7(),
        entityId: order.entityId,
        storeId: order.storeId,
        deliveryPlanId: plan.id,
        versionNo: 1,
        contentSnapshot: content,
        pushedByStaffId: manager.staff.id,
        pushedAt: now,
        createdAt: now,
        ...(planState === "confirmed"
          ? {
              decision: "confirmed",
              decidedAt: now,
              decideActorType: "staff",
              decideActorId: manager.staff.id,
              decideClient: "admin",
            }
          : {}),
      },
    });
  return { order, item, ticket, plan, content };
}
async function checks() {
  const template = await prisma.checklistTemplate.findFirstOrThrow({
    where: { code: "delivery.precheck", status: "active" },
  });
  return {
    checklistVersionNo: template.versionNo,
    results: ChecklistItemsSchema.parse(template.items).map((row) => ({
      key: row.key,
      result: "pass" as const,
    })),
  };
}
async function consumeNotificationEvent(id: string) {
  const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
  return api.runtime.tx.run((tx) =>
    api.runtime.notify.onEvent(tx, {
      id: event.id,
      type: event.eventType,
      payload: event.payload as Record<string, unknown>,
    }),
  );
}
beforeAll(async () => {
  api = await handle.start();
  prisma = await handle.db.prisma();
  make = createFactories({ db: prisma, clock: api.clock });
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  manager = await signInAsStaff(prisma, { roleKey: "delivery_manager", now: api.clock.now() });
  outside = await signInAsStaff(prisma, { roleKey: "delivery_manager", now: api.clock.now() });
  editor = await signInAsStaff(prisma, { roleKey: "editor", now: api.clock.now() });
  publisher = await signInAsStaff(prisma, { roleKey: "publisher", now: api.clock.now() });
  reasonCode = (
    await prisma.dictItem.findFirstOrThrow({
      where: { dictTypeKey: "reissue_reason", isEnabled: true },
    })
  ).code;
}, 180000);

describe("W5-03 十一条真实 HTTP", { timeout: 120000 }, () => {
  it("十一条 typed handler 都已挂载且要求真实员工会话", async () => {
    for (const [operation, method, path] of routes) {
      expect(
        HANDLERS.some((h) => h.route.operationId === operation),
        operation,
      ).toBe(true);
      expect(
        (
          await api.request(`/api/v1/admin${path.replace(":id", uuidv7())}`, {
            method,
            ...(method === "POST" ? { json: {} } : {}),
            peer: `198.19.53.${++peer}`,
          })
        ).status,
        operation,
      ).toBe(401);
    }
  });

  it("首次指派不造空来源改派行；改派、角色、员工集合与原 key 重放均真实", async () => {
    const f = await fixture(),
      first = uuidv7();
    await error(
      await request(
        "admin.deliveryTicket.assignEditor",
        f.ticket.id,
        { staffId: editor.staff.id },
        editor,
      ),
      403,
      "PERMISSION_DENIED",
    );
    await error(
      await request(
        "admin.deliveryTicket.assignEditor",
        f.ticket.id,
        { staffId: editor.staff.id },
        outside,
      ),
      404,
      "NOT_FOUND",
    );
    await error(
      await request(
        "admin.deliveryTicket.assignEditor",
        f.ticket.id,
        { staffId: editor.staff.id },
        manager,
      ),
      409,
      "ASSIGNEE_INVALID",
    );
    expect(
      await data(
        await request(
          "admin.deliveryTicket.assignEditor",
          f.ticket.id,
          { staffId: editor.staff.id },
          admin,
          first,
        ),
      ),
    ).toMatchObject({ editor: { staffId: editor.staff.id }, replayed: false });
    expect(await prisma.assignmentHistory.count({ where: { subjectId: f.ticket.id } })).toBe(0);
    expect(
      await data(
        await request(
          "admin.deliveryTicket.assignEditor",
          f.ticket.id,
          { staffId: editor.staff.id },
          admin,
          first,
        ),
      ),
    ).toMatchObject({ replayed: true });
    const replacement = await make.staff({ staffRoleKey: "editor" });
    await error(
      await request("admin.deliveryTicket.assignEditor", f.ticket.id, { staffId: replacement.id }),
      400,
      "VALIDATION_FAILED",
    );
    await data(
      await request("admin.deliveryTicket.assignEditor", f.ticket.id, {
        staffId: replacement.id,
        reasonCode: "workload",
        note: "重新平衡任务",
      }),
    );
    expect(
      await prisma.assignmentHistory.findMany({ where: { subjectId: f.ticket.id } }),
    ).toMatchObject([
      { source: "ticket_editor", fromStaffId: editor.staff.id, toStaffId: replacement.id },
    ]);
    const nextPublisher = await make.staff({ staffRoleKey: "publisher" });
    expect(
      await data(
        await request("admin.deliveryTicket.assignPublisher", f.ticket.id, {
          staffId: nextPublisher.id,
          reasonCode: "staff_change",
        }),
      ),
    ).toMatchObject({ publisher: { staffId: nextPublisher.id } });
    // 发布专员主管的 delivery 等级为 v，既有 assign_publisher 权限仍能执行改派。
    const leadPublisher = await signInAsStaff(prisma, {
        roleKey: "publisher",
        isLead: true,
        now: api.clock.now(),
      }),
      peerPublisher = await signInAsStaff(prisma, {
        roleKey: "publisher",
        now: api.clock.now(),
      }),
      ownPublisherTicket = await fixture();
    expect(
      await data(
        await request(
          "admin.deliveryTicket.assignPublisher",
          ownPublisherTicket.ticket.id,
          { staffId: peerPublisher.staff.id, reasonCode: "workload" },
          leadPublisher,
        ),
      ),
    ).toMatchObject({ publisher: { staffId: peerPublisher.staff.id } });
    const page = await data(
      await request("admin.deliveryTicket.activity.list", f.ticket.id, undefined, manager),
    );
    expect(page.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "delivery.ticket.assign_editor" }),
      ]),
    );
    await error(
      await request("admin.deliveryTicket.activity.list", f.ticket.id, undefined, outside),
      404,
      "NOT_FOUND",
    );
    await error(
      await request(
        "admin.deliveryTicket.activity.list",
        f.ticket.id,
        undefined,
        admin,
        null,
        "?limit=101",
      ),
      400,
      "VALIDATION_FAILED",
    );
  });

  it("人工纠偏走中央 step-up、确认、白名单、真实历史及 ops 活动合流", async () => {
    // 故意留下缺确认方案的旧 sample_making 行，以纠偏修复到合法 plan_confirm。
    const f = await fixture("sample_making"),
      body = {
        toStep: "plan_confirm",
        note: "经核对旧工单步骤错误需要回退",
        confirm: { ticketNo: f.ticket.ticketNo, fromStep: "sample_making" },
      },
      key = uuidv7();
    await error(
      await request("admin.deliveryTicket.forceTransition", f.ticket.id, { ...body, note: "太短" }),
      400,
      "VALIDATION_FAILED",
    );
    // 会话保持合法，注入时钟自然跨过十分钟再验证窗口。
    api.clock.advance(11 * 60_000);
    await error(
      await request("admin.deliveryTicket.forceTransition", f.ticket.id, body, admin, key),
      403,
      "STEP_UP_REQUIRED",
    );
    await prisma.staffSession.update({
      where: { id: admin.sessionId },
      data: { stepupAt: api.clock.now() },
    });
    await error(
      await request("admin.deliveryTicket.forceTransition", f.ticket.id, {
        ...body,
        confirm: { ...body.confirm, ticketNo: "错误工单" },
      }),
      409,
      "CONFIRM_MISMATCH",
    );
    await error(
      await request("admin.deliveryTicket.forceTransition", f.ticket.id, {
        ...body,
        toStep: "in_service",
      }),
      409,
      "CORRECTION_NOT_ALLOWED",
    );
    expect(
      await data(
        await request("admin.deliveryTicket.forceTransition", f.ticket.id, body, admin, key),
      ),
    ).toMatchObject({ step: "plan_confirm", replayed: false });
    const transitions = await prisma.statusTransition.findMany({
      where: { machine: "delivery_ticket", subjectId: f.ticket.id },
    });
    expect(transitions).toMatchObject([
      { fromState: "sample_making", toState: "plan_confirm", event: "admin.force", isForced: true },
    ]);
    expect(
      await data(
        await request("admin.deliveryTicket.forceTransition", f.ticket.id, body, admin, key),
      ),
    ).toMatchObject({ replayed: true });
    expect(await prisma.statusTransition.count({ where: { subjectId: f.ticket.id } })).toBe(1);
    const page = await data(await request("admin.deliveryTicket.activity.list", f.ticket.id));
    expect(page.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transition: expect.objectContaining({ isForced: true }) }),
      ]),
    );
  });

  it("求值无迁移也记 ops 审计；主管返工拒绝失效状态并真实退回", async () => {
    const f = await fixture(),
      key = uuidv7();
    expect(
      await data(await request("admin.deliveryTicket.reevaluate", f.ticket.id, {}, admin, key)),
    ).toMatchObject({ transitions: [], skippedReason: null, ticket: { step: "plan_confirm" } });
    expect(
      await data(await request("admin.deliveryTicket.reevaluate", f.ticket.id, {}, admin, key)),
    ).toMatchObject({ replayed: true });
    expect(
      await prisma.auditLog.count({
        where: { targetId: f.ticket.id, action: "delivery.ticket.reevaluate" },
      }),
    ).toBe(1);
    await error(
      await request("admin.deliveryTicket.rework", f.ticket.id, { reason: "返工原因" }),
      409,
      "STATE_NOT_ALLOWED",
    );
    const composed = await fixture("batch_compose", "confirmed");
    await error(
      await request(
        "admin.deliveryTicket.rework",
        composed.ticket.id,
        { reason: "返工原因" },
        manager,
      ),
      403,
      "PERMISSION_DENIED",
    );
    expect(
      await data(
        await request("admin.deliveryTicket.rework", composed.ticket.id, {
          reason: "主管核对后要求重新合成样片",
        }),
      ),
    ).toMatchObject({ step: "sample_making" });
    expect(
      await prisma.statusTransition.findFirstOrThrow({
        where: { subjectId: composed.ticket.id, event: "ticket.rework" },
      }),
    ).toMatchObject({ fromState: "batch_compose", toState: "sample_making" });
  });

  it("改期同步草稿和审计 before/after，原 key 不再增版本；首账号上线后拒绝", async () => {
    const f = await fixture(),
      key = uuidv7(),
      body = { agreedLaunchDate: dateAfter(30), reason: "与商家确认新的约定上线日" };
    await error(
      await request("admin.orderItem.rescheduleLaunch", f.item.id, body, outside),
      404,
      "NOT_FOUND",
    );
    expect(
      await data(await request("admin.orderItem.rescheduleLaunch", f.item.id, body, manager, key)),
    ).toMatchObject({ agreedLaunchDate: body.agreedLaunchDate });
    const plan = await prisma.deliveryPlan.findUniqueOrThrow({ where: { id: f.plan.id } });
    expect(plan).toMatchObject({
      draftLockVersion: 1,
      currentVersionNo: 0,
      draft: { items: [{ agreedLaunchDate: body.agreedLaunchDate }] },
    });
    expect(await prisma.deliveryPlanVersion.count({ where: { deliveryPlanId: f.plan.id } })).toBe(
      0,
    );
    expect(
      await prisma.auditLog.findFirstOrThrow({
        where: { targetId: f.item.id, action: "delivery.order_item.reschedule_launch" },
      }),
    ).toMatchObject({
      before: { agreedLaunchDate: dateAfter(20) },
      after: { agreedLaunchDate: body.agreedLaunchDate },
      reasonText: body.reason,
    });
    expect(
      await data(await request("admin.orderItem.rescheduleLaunch", f.item.id, body, manager, key)),
    ).toMatchObject({ replayed: true });
    expect(
      (await prisma.deliveryPlan.findUniqueOrThrow({ where: { id: f.plan.id } })).draftLockVersion,
    ).toBe(1);
    await prisma.orderItem.update({
      where: { id: f.item.id },
      data: { usageStartDate: new Date(dateAfter(0)) },
    });
    await error(
      await request(
        "admin.orderItem.rescheduleLaunch",
        f.item.id,
        { ...body, agreedLaunchDate: dateAfter(31) },
        manager,
      ),
      409,
      "LAUNCH_DATE_LOCKED",
    );
  });

  it("催办核真实负责人/场景及北京时间当日去重，重放不再发事件", async () => {
    const f = await fixture("plan_confirm", "pending_confirm"),
      key = uuidv7(),
      body = { scene: "confirm_plan" };
    await error(
      await request("admin.deliveryTicket.remind", f.ticket.id, body, outside),
      404,
      "NOT_FOUND",
    );
    expect(
      await data(await request("admin.deliveryTicket.remind", f.ticket.id, body, manager, key)),
    ).toMatchObject({
      scene: "confirm_plan",
      subjectType: "delivery_ticket",
      subjectId: f.ticket.id,
      replayed: false,
    });
    const count = await prisma.outboxEvent.count({ where: { eventType: "manual_reminder.sent" } });
    expect(
      await data(await request("admin.deliveryTicket.remind", f.ticket.id, body, manager, key)),
    ).toMatchObject({ replayed: true });
    expect(await prisma.outboxEvent.count({ where: { eventType: "manual_reminder.sent" } })).toBe(
      count,
    );
    await error(
      await request("admin.deliveryTicket.remind", f.ticket.id, body, manager),
      409,
      "REMINDED_TODAY",
    );
    await error(
      await request("admin.deliveryTicket.remind", f.ticket.id, { scene: "golive" }, manager),
      409,
      "REMIND_NOT_APPLICABLE",
    );
    expect(await prisma.manualReminderLog.count({ where: { subjectId: f.ticket.id } })).toBe(1);
    const owner = await prisma.entityMember.findFirstOrThrow({
        where: { entityId: f.order.entityId, role: "owner", status: "active" },
      }),
      clerk = await make.entityMember({ entityId: f.order.entityId });
    await make.storeMember({
      entityMemberId: clerk.id,
      storeId: f.order.storeId,
      addedByMemberId: owner.id,
    });
    const foreign = await fixture("plan_confirm", "pending_confirm"),
      reminder = await prisma.manualReminderLog.findFirstOrThrow({
        where: { subjectId: f.ticket.id, scene: "confirm_plan" },
      }),
      event = await prisma.outboxEvent.findFirstOrThrow({
        where: { eventType: "manual_reminder.sent", aggregateId: reminder.id },
      }),
      payload = EVENT_PAYLOAD_SCHEMAS["manual_reminder.sent"].parse(event.payload);
    // 消费时复核持久化提醒对象：伪改成其他门店的工单不能借原提醒行投递。
    expect(
      await api.runtime.tx.run((tx) =>
        api.runtime.notify.onEvent(tx, {
          id: event.id,
          type: event.eventType,
          payload: { ...payload, subjectId: foreign.ticket.id },
        }),
      ),
    ).toBe(0);
    expect(await prisma.notification.count({ where: { sourceOutboxEventId: event.id } })).toBe(0);
    const dispatch = () =>
      api.runtime.tx.run((tx) =>
        api.runtime.notify.onEvent(tx, {
          id: event.id,
          type: event.eventType,
          payload,
        }),
      );
    expect(await dispatch()).toBe(1);
    expect(await dispatch()).toBe(0);
    const notifications = await prisma.notification.findMany({
      where: { sourceOutboxEventId: event.id },
      include: { merchantMessage: true, notificationDeliveries: true },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      notifySceneKey: "m.plan_pending",
      node: "M",
      bizType: "delivery_plan",
      bizId: f.plan.id,
      merchantUserId: owner.merchantUserId,
      entityId: f.order.entityId,
      storeId: f.order.storeId,
      merchantMessage: {
        merchantUserId: owner.merchantUserId,
        entityId: f.order.entityId,
        storeId: f.order.storeId,
        isOwnerOnly: true,
        link: {
          route: "delivery.plan",
          params: { deliveryPlanId: f.plan.id, storeId: f.order.storeId },
        },
      },
      notificationDeliveries: expect.arrayContaining([
        expect.objectContaining({ channel: "inbox", status: "sent" }),
      ]),
    });
    expect(
      await prisma.merchantMessage.count({
        where: { notification: { sourceOutboxEventId: event.id } },
      }),
    ).toBe(1);
    expect(
      await prisma.merchantMessage.count({
        where: {
          merchantUserId: clerk.merchantUserId,
          notification: { sourceOutboxEventId: event.id },
        },
      }),
    ).toBe(0);

    // HTTP 成功后业务已离开待确认：正式 requestChange 改为 revising，再消费旧事件应为零。
    await data(await request("admin.deliveryTicket.remind", foreign.ticket.id, body, manager));
    const oldReminder = await prisma.manualReminderLog.findFirstOrThrow({
        where: { subjectId: foreign.ticket.id, scene: "confirm_plan" },
      }),
      oldEvent = await prisma.outboxEvent.findFirstOrThrow({
        where: { eventType: "manual_reminder.sent", aggregateId: oldReminder.id },
      }),
      foreignOwner = await prisma.entityMember.findFirstOrThrow({
        where: { entityId: foreign.order.entityId, role: "owner", status: "active" },
      });
    await deliveryOf(api.runtime).requestChange(
      {
        ctx: createIdentityContext({
          actor: {
            type: "merchant",
            id: foreignOwner.merchantUserId,
            role: "owner",
            client: "weapp",
          },
          entityId: foreign.order.entityId,
          storeId: foreign.order.storeId,
        }),
        membership: {
          memberId: foreignOwner.id,
          entityId: foreign.order.entityId,
          storeId: foreign.order.storeId,
          role: "owner",
          storeMode: "active",
        },
      },
      foreign.plan.id,
      { kinds: ["other"], note: "商家已提出新的方案修改意见" },
    );
    expect(
      (await prisma.deliveryPlan.findUniqueOrThrow({ where: { id: foreign.plan.id } })).status,
    ).toBe("revising");
    expect(
      await api.runtime.tx.run((tx) =>
        api.runtime.notify.onEvent(tx, {
          id: oldEvent.id,
          type: oldEvent.eventType,
          payload: EVENT_PAYLOAD_SCHEMAS["manual_reminder.sent"].parse(oldEvent.payload),
        }),
      ),
    ).toBe(0);
    expect(await prisma.notification.count({ where: { sourceOutboxEventId: oldEvent.id } })).toBe(
      0,
    );
    expect(
      await prisma.merchantMessage.count({
        where: { notification: { sourceOutboxEventId: oldEvent.id } },
      }),
    ).toBe(0);
    const originalTime = api.clock.now();
    api.clock.advance(24 * 60 * 60_000);
    try {
      const nextDayActor = await signInAsStaff(prisma, {
        roleKey: "super_admin",
        now: api.clock.now(),
      });
      const nextDay = await data(
        await request("admin.deliveryTicket.remind", f.ticket.id, body, nextDayActor),
      );
      const nextLog = await prisma.manualReminderLog.findFirstOrThrow({
        where: { subjectId: f.ticket.id, scene: "confirm_plan" },
        orderBy: { createdAt: "desc" },
      });
      expect(nextLog.bizDate.toISOString().slice(0, 10)).toBe(
        new Date(reminder.bizDate.getTime() + 86_400_000).toISOString().slice(0, 10),
      );
      expect(nextDay).toMatchObject({ replayed: false, subjectId: f.ticket.id });
      const nextEvent = await prisma.outboxEvent.findFirstOrThrow({
        where: { eventType: "manual_reminder.sent", aggregateId: nextLog.id },
      });
      expect(nextEvent.id).not.toBe(event.id);
      expect(await consumeNotificationEvent(nextEvent.id)).toBe(1);
      expect(await consumeNotificationEvent(nextEvent.id)).toBe(0);
      expect(await consumeNotificationEvent(event.id)).toBe(0);
      const inbox = await prisma.notification.findMany({
        where: { notifySceneKey: "m.plan_pending", node: "M", bizId: f.plan.id },
        include: { merchantMessage: true },
      });
      expect(inbox).toHaveLength(2);
      expect(inbox.map((n) => n.sourceOutboxEventId).sort()).toEqual(
        [event.id, nextEvent.id].sort(),
      );
      expect(
        inbox.every(
          (n) =>
            n.merchantUserId === owner.merchantUserId &&
            n.merchantMessage?.merchantUserId === owner.merchantUserId,
        ),
      ).toBe(true);
    } finally {
      api.clock.set(originalTime);
    }
  });

  it("补发创建/取消真实落库，发布缺替换行原子拒绝，十一 operationId 都实际调用", async () => {
    const invalid = await fixture();
    const body = { episodeNos: [1], reasonCode, note: "替换第一集中的错误文案" };
    await error(
      await request("admin.deliveryTicket.reissue.create", invalid.ticket.id, body),
      409,
      "REISSUE_NOT_ALLOWED",
    );
    const f = await fixture("awaiting_launch", "confirmed"),
      key = uuidv7();
    const opened = await data(
      await request("admin.deliveryTicket.reissue.create", f.ticket.id, body, manager, key),
    );
    const reissueId = opened.reissueId as string;
    expect(opened).toMatchObject({
      status: "open",
      episodeNos: [1],
      openedBy: { staffId: manager.staff.id },
      replayed: false,
    });
    expect(
      await data(
        await request("admin.deliveryTicket.reissue.create", f.ticket.id, body, manager, key),
      ),
    ).toMatchObject({ reissueId, replayed: true });
    await error(
      await request("admin.deliveryTicket.reissue.create", f.ticket.id, body, manager),
      409,
      "REISSUE_NOT_ALLOWED",
    );
    const before = [await prisma.deliveryRelease.count(), await prisma.downloadGrant.count()];
    await error(
      await request("admin.reissue.publish", reissueId, { precheck: await checks() }, publisher),
      409,
      "REISSUE_INCOMPLETE",
    );
    expect([await prisma.deliveryRelease.count(), await prisma.downloadGrant.count()]).toEqual(
      before,
    );
    expect(
      (await prisma.deliveryReissue.findUniqueOrThrow({ where: { id: reissueId } })).status,
    ).toBe("open");
    const cancelKey = uuidv7();
    expect(
      await data(
        await request(
          "admin.reissue.cancel",
          reissueId,
          { note: "本轮取消重做" },
          manager,
          cancelKey,
        ),
      ),
    ).toMatchObject({ status: "cancelled" });
    expect(
      await data(
        await request(
          "admin.reissue.cancel",
          reissueId,
          { note: "本轮取消重做" },
          manager,
          cancelKey,
        ),
      ),
    ).toMatchObject({ replayed: true });
    await error(
      await request("admin.reissue.cancel", reissueId, {}, manager),
      409,
      "STATE_NOT_ALLOWED",
    );
    expect([...requested].sort()).toEqual(routes.map(([operation]) => operation).sort());
  });

  it("W503通知：补发发起只发当前剪辑师，重验不误取当前发布人，取消后旧事件零通知", async () => {
    const f = await fixture("awaiting_launch", "confirmed"),
      firstEditor = await make.staff({ staffRoleKey: "editor" }),
      currentEditor = await make.staff({
        staffRoleKey: "editor",
        wecomUserid: `w503-${uuidv7()}`,
        wecomBindStatus: "bound",
        wecomBoundAt: api.clock.now(),
      });
    await data(
      await request("admin.deliveryTicket.assignEditor", f.ticket.id, { staffId: firstEditor.id }),
    );
    const opened = await data(
      await request(
        "admin.deliveryTicket.reissue.create",
        f.ticket.id,
        { episodeNos: [1], reasonCode, note: "测试正式补发通知收件人" },
        manager,
      ),
    );
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "package.reissue_opened", aggregateId: opened.reissueId as string },
    });
    await data(
      await request("admin.deliveryTicket.assignEditor", f.ticket.id, {
        staffId: currentEditor.id,
        reasonCode: "workload",
      }),
    );
    expect(await consumeNotificationEvent(event.id)).toBe(1);
    expect(await consumeNotificationEvent(event.id)).toBe(0);
    const rows = await prisma.notification.findMany({
      where: { sourceOutboxEventId: event.id },
      include: { staffMessage: true, notificationDeliveries: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      notifySceneKey: "s.delivery_progress",
      bizType: "delivery_reissue",
      bizId: opened.reissueId,
      staffId: currentEditor.id,
      merchantUserId: null,
      staffMessage: {
        staffId: currentEditor.id,
        link: { route: "delivery.ticket_detail", params: { deliveryTicketId: f.ticket.id } },
      },
    });
    const wecom = rows[0]!.notificationDeliveries.find((d) => d.channel === "wecom");
    expect(wecom).toBeDefined();
    const beforeDelivery = api.clock.now();
    if (wecom!.dueAt > beforeDelivery) api.clock.set(wecom!.dueAt);
    try {
      await api.runtime.notify.deliver({ deliveryId: wecom!.id });
    } finally {
      api.clock.set(beforeDelivery);
    }
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: wecom!.id } }),
    ).toMatchObject({ status: "sent", targetRef: currentEditor.wecomUserid });
    const cancelled = await fixture("awaiting_launch", "confirmed");
    await data(
      await request("admin.deliveryTicket.assignEditor", cancelled.ticket.id, {
        staffId: currentEditor.id,
      }),
    );
    const pending = await data(
      await request(
        "admin.deliveryTicket.reissue.create",
        cancelled.ticket.id,
        { episodeNos: [1], reasonCode, note: "取消前已产生的待消费通知" },
        manager,
      ),
    );
    const stale = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "package.reissue_opened", aggregateId: pending.reissueId as string },
    });
    await data(await request("admin.reissue.cancel", pending.reissueId as string, {}, manager));
    expect(await consumeNotificationEvent(stale.id)).toBe(0);
    expect(await prisma.notification.count({ where: { sourceOutboxEventId: stale.id } })).toBe(0);
  });

  it("W503通知：补发发布只发当前包的老板站内消息，旧包及错误关联事件零通知", async () => {
    // 仅为消费者准备合法的已发布关联事实，不造制作已检/QC记录，不据此验发布 API。
    const f = await fixture("awaiting_launch", "confirmed"),
      opened = await data(
        await request(
          "admin.deliveryTicket.reissue.create",
          f.ticket.id,
          { episodeNos: [1], reasonCode, note: "消费者已发布关联事实" },
          manager,
        ),
      ),
      owner = await prisma.entityMember.findFirstOrThrow({
        where: { entityId: f.order.entityId, role: "owner", status: "active" },
      }),
      precheck = await checks(),
      now = api.clock.now();
    const release = await prisma.deliveryRelease.create({
      data: {
        id: uuidv7(),
        entityId: f.order.entityId,
        storeId: f.order.storeId,
        orderItemId: f.item.id,
        deliveryTicketId: f.ticket.id,
        releaseNo: 1,
        kind: "reissue",
        state: "pushed",
        episodeCount: 2,
        totalBytes: 2n,
        manifestSnapshot: [{ episodeNo: 1 }, { episodeNo: 2 }],
        changedEpisodeNos: [1],
        checklistCode: "delivery.precheck",
        checklistVersionNo: precheck.checklistVersionNo,
        precheckResults: precheck.results,
        reasonCode,
        note: "仅测试通知关联事实",
        pushedByStaffId: publisher.staff.id,
        pushedAt: now,
        idempotencyKey: uuidv7(),
        createdAt: now,
        updatedAt: now,
      },
    });
    await prisma.deliveryReissue.update({
      where: { id: opened.reissueId as string },
      data: {
        status: "published",
        publishedDeliveryReleaseId: release.id,
        closedAt: now,
        updatedAt: now,
      },
    });
    const payload = {
      v: 1 as const,
      deliveryReissueId: opened.reissueId as string,
      deliveryReleaseId: release.id,
      deliveryTicketId: f.ticket.id,
      orderItemId: f.item.id,
      episodeNos: [1],
      grantExpiresAt: new Date(now.getTime() + 7 * 86400000).toISOString(),
    };
    const emitted = await api.runtime.tx.run((tx) =>
      api.runtime.events.emit(
        tx,
        createIdentityContext({ actor: { type: "system", job: "lyxtest.w503_notify_consumer" } }),
        {
          type: "package.reissued",
          aggregate: { type: "delivery_reissue", id: opened.reissueId as string },
          entityId: f.order.entityId,
          storeId: f.order.storeId,
          payload,
        },
      ),
    );
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "package.reissued", aggregateId: opened.reissueId as string },
    });
    expect(emitted).toBeDefined();
    expect(
      await api.runtime.tx.run((tx) =>
        api.runtime.notify.onEvent(tx, {
          id: event.id,
          type: event.eventType,
          payload: { ...payload, orderItemId: uuidv7() },
        }),
      ),
    ).toBe(0);
    expect(await consumeNotificationEvent(event.id)).toBe(1);
    expect(await consumeNotificationEvent(event.id)).toBe(0);
    const rows = await prisma.notification.findMany({
      where: { sourceOutboxEventId: event.id },
      include: { merchantMessage: true, notificationDeliveries: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      notifySceneKey: "m.order_progress",
      bizType: "delivery_release",
      bizId: release.id,
      merchantUserId: owner.merchantUserId,
      merchantMessage: {
        merchantUserId: owner.merchantUserId,
        isOwnerOnly: true,
        link: { route: "order.detail", params: { orderId: f.order.id, storeId: f.order.storeId } },
      },
    });
    expect(rows[0]!.notificationDeliveries).toMatchObject([{ channel: "inbox", status: "sent" }]);
    await prisma.deliveryRelease.update({
      where: { id: release.id },
      data: { state: "superseded", supersededAt: now, updatedAt: now },
    });
    const staleId = uuidv7();
    expect(
      await api.runtime.tx.run((tx) =>
        api.runtime.notify.onEvent(tx, { id: staleId, type: event.eventType, payload }),
      ),
    ).toBe(0);
    expect(await prisma.notification.count({ where: { sourceOutboxEventId: staleId } })).toBe(0);
  });

  it("W503通知：改期按当前日期发老板站内消息，同状态再次改期不被吞，旧日期零通知", async () => {
    const f = await fixture(),
      owner = await prisma.entityMember.findFirstOrThrow({
        where: { entityId: f.order.entityId, role: "owner", status: "active" },
      });
    const change = async (days: number) => {
      await data(
        await request(
          "admin.orderItem.rescheduleLaunch",
          f.item.id,
          { agreedLaunchDate: dateAfter(days), reason: "商家确认变更后的上线日期" },
          manager,
        ),
      );
      return prisma.outboxEvent.findFirstOrThrow({
        where: {
          eventType: "order.item.launch_rescheduled",
          aggregateId: f.item.id,
          payload: { path: ["newDate"], equals: dateAfter(days) },
        },
      });
    };
    const old = await change(30),
      current = await change(31);
    expect(await consumeNotificationEvent(old.id)).toBe(0);
    expect(await consumeNotificationEvent(current.id)).toBe(1);
    expect(await consumeNotificationEvent(current.id)).toBe(0);
    const next = await change(32);
    expect(await consumeNotificationEvent(next.id)).toBe(1);
    expect(await consumeNotificationEvent(current.id)).toBe(0);
    const rows = await prisma.notification.findMany({
      where: { notifySceneKey: "m.order_progress", bizType: "order_item", bizId: f.item.id },
      include: { merchantMessage: true, notificationDeliveries: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((n) => n.sourceOutboxEventId).sort()).toEqual([current.id, next.id].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        merchantUserId: owner.merchantUserId,
        entityId: f.order.entityId,
        storeId: f.order.storeId,
        merchantMessage: {
          merchantUserId: owner.merchantUserId,
          isOwnerOnly: true,
          link: {
            route: "order.detail",
            params: { orderId: f.order.id, storeId: f.order.storeId },
          },
        },
      });
      expect(row.notificationDeliveries).toMatchObject([{ channel: "inbox", status: "sent" }]);
    }
    expect(await prisma.notification.count({ where: { sourceOutboxEventId: old.id } })).toBe(0);
  });
});
