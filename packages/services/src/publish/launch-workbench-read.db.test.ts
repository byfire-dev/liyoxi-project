import { beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@liyoxi/db";
import { AdminLaunchTaskListQuerySchema, LaunchTaskSummaryQuerySchema } from "@liyoxi/contract";
import { addDays, calendarDate, startOfDay } from "@liyoxi/shared/time";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import {
  createClock,
  createFactories,
  sampleStaffContext,
  useSeededDatabase,
} from "../testing/index.js";
import { createLaunchWorkbench } from "./launch-workbench.js";

const db = useSeededDatabase("services");
const at = (day: string, time = "12:00:00") => new Date(`${day}T${time}+08:00`);
const date = (day: string) => new Date(`${day}T00:00:00.000Z`);
const clock = createClock(at("2026-11-10"));
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let make: ReturnType<typeof createFactories>;
let workbench: ReturnType<typeof createLaunchWorkbench>;
let admin: Awaited<ReturnType<typeof sampleStaffContext>>;
beforeAll(async () => {
  prisma = await db.prisma();
  make = createFactories({ db: prisma, clock });
  workbench = createLaunchWorkbench({ tx: createTxRunner({ prisma, appEnv: "test" }), clock });
  admin = await sampleStaffContext(prisma, (await make.staff({ staffRoleKey: "super_admin" })).id);
}, 120000);

// 本文件仅测试历史输入的只读投影，不把这些行当作制作、核验或撤销用例的成功证据。
// 真实写链、跨域收尾及 R2/R6 另由 launch-workbench.db.test.ts 验证。
async function fixture(
  options: {
    title?: string;
    managerId?: string;
    publisherId?: string;
    agreed?: string | null;
    delivered?: Date | null;
    phase?: "producing" | "to_launch";
    withTask?: boolean;
    reviewStatus?: "pending" | "need_fix";
    verified?: number;
  } = {},
) {
  const manager = options.managerId ?? (await make.staff()).id;
  const item = await make.orderItem({
    phase: options.phase ?? "to_launch",
    agreedLaunchDate: options.agreed === null ? null : date(options.agreed ?? "2026-11-03"),
    dramaSnapshot: { title: options.title ?? "历史读侧夹具" },
    usageEndDate: date("2100-12-31"),
  });
  const ticket = await make.deliveryTicket({
    orderItemId: item.id,
    deliveryManagerId: manager,
    ...(options.publisherId ? { publisherId: options.publisherId } : {}),
    step: options.phase === "producing" ? "delivering" : "awaiting_launch",
    deliveredAt: options.delivered === undefined ? at("2026-11-02") : options.delivered,
    deliveryTargetAt: at("2026-11-01"),
  });
  if (options.withTask === false) return { item, ticket, task: null };
  const accountId = uuidv7();
  const account = await prisma.channelAccount.create({
    data: {
      id: accountId,
      entityId: item.entityId,
      storeId: item.storeId,
      platform: "douyin",
      accountName: "读侧历史账号",
      accountUid: accountId,
      accountUidNorm: accountId,
      status: "pending_verify",
      submittedAt: clock.now(),
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  });
  await prisma.orderItemAccount.create({
    data: {
      orderItemId: item.id,
      channelAccountId: account.id,
      platform: account.platform,
      createdAt: clock.now(),
    },
  });
  const count = options.verified ?? 0;
  const task = await prisma.launchTask.create({
    data: {
      id: uuidv7(),
      entityId: item.entityId,
      storeId: item.storeId,
      orderItemId: item.id,
      deliveryTicketId: ticket.id,
      channelAccountId: account.id,
      platform: account.platform,
      reviewStatus: options.reviewStatus ?? "pending",
      currentRoundNo: options.reviewStatus === "need_fix" ? 2 : 0,
      verifiedEpisodeCount: count,
      firstLaunchDate: count ? date("2026-11-01") : null,
      createdAt: ticket.deliveredAt ?? clock.now(),
      updatedAt: clock.now(),
    },
  });
  return { item, ticket, task };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function history(
  f: Fixture,
  rows: Array<{ day: string; state: string; event: string; payload?: Prisma.InputJsonObject }>,
) {
  let previous: string | null = null;
  for (const row of rows) {
    const occurredAt = at(row.day, "00:00:00");
    await prisma.statusTransition.create({
      data: {
        id: uuidv7(),
        machine: "launch_task",
        subjectId: f.task!.id,
        stateField: "review_status",
        entityId: f.item.entityId,
        storeId: f.item.storeId,
        fromState: previous,
        toState: row.state,
        event: row.event,
        actorType: "system",
        occurredAt,
        bizDate: date(calendarDate(occurredAt)),
        ...(row.payload ? { payload: row.payload } : {}),
      },
    });
    previous = row.state;
  }
}
const summary = (orderItemId: string) =>
  workbench.summary(admin, LaunchTaskSummaryQuerySchema.parse({ orderItemId }));
async function counts() {
  return {
    items: await prisma.orderItem.findMany({ orderBy: { id: "asc" } }),
    tickets: await prisma.deliveryTicket.findMany({ orderBy: { id: "asc" } }),
    tasks: await prisma.launchTask.findMany({ orderBy: { id: "asc" } }),
    audit: await prisma.auditLog.count(),
    history: await prisma.statusTransition.count(),
    events: await prisma.outboxEvent.count(),
    reminders: await prisma.manualReminderLog.count(),
    followUps: await prisma.followUp.count(),
    files: await prisma.fileObject.count(),
    zip: await prisma.zipBundle.count(),
  };
}

describe("上线工作台真实库只读投影", () => {
  it("三处工单范围一致，manager/q/readyOnly正确且统计先于limit，所有GET零写", async () => {
    clock.set(at("2026-11-10"));
    const publisherA = await make.staff({ staffRoleKey: "publisher" });
    const publisherB = await make.staff({ staffRoleKey: "publisher" });
    const managerA = await make.staff();
    const managerB = await make.staff();
    const staffA = await sampleStaffContext(prisma, publisherA.id);
    const staffB = await sampleStaffContext(prisma, publisherB.id);
    const key = uuidv7();
    const overdue = await fixture({
      title: key,
      publisherId: publisherA.id,
      managerId: managerA.id,
    });
    const outside = await fixture({
      title: key,
      publisherId: publisherB.id,
      managerId: managerB.id,
    });
    const producing = await fixture({
      title: key,
      publisherId: publisherA.id,
      managerId: managerA.id,
      phase: "producing",
      agreed: "2026-11-12",
      delivered: null,
      withTask: false,
    });
    const ready = await fixture({
      title: key,
      publisherId: publisherA.id,
      managerId: managerA.id,
      agreed: "2026-11-11",
      delivered: at("2026-11-09"),
    });
    for (const row of [overdue, outside, ready])
      await history(row, [{ day: "2026-11-02", state: "pending", event: "launch.create" }]);
    await prisma.manualReminderLog.create({
      data: {
        id: uuidv7(),
        subjectType: "order_item",
        subjectId: overdue.item.id,
        scene: "golive",
        bizDate: date("2026-11-10"),
        sentByStaffId: publisherA.id,
        createdAt: clock.now(),
      },
    });
    for (let i = 0; i < 4; i++)
      await prisma.followUp.create({
        data: {
          id: uuidv7(),
          subjectType: "order_item",
          subjectId: overdue.item.id,
          entityId: overdue.item.entityId,
          storeId: overdue.item.storeId,
          content: `真实跟进 ${i}`,
          ownerStaffId: publisherA.id,
          actorType: "staff",
          actorId: publisherA.id,
          client: "admin",
          createdAt: at(`2026-11-0${i + 1}`),
          updatedAt: at(`2026-11-0${i + 1}`),
        },
      });
    const before = await counts();
    const list = await workbench.list(staffA, AdminLaunchTaskListQuerySchema.parse({ q: key }));
    expect(list.items.map((row) => row.orderItem.orderItemId)).toEqual([overdue.item.id]);
    expect(list.items[0]).toMatchObject({ followUpCount: 4, isRemindedToday: true, actions: [] });
    expect(list.items[0]!.followUps.map((row) => row.content)).toEqual([
      "真实跟进 3",
      "真实跟进 2",
      "真实跟进 1",
    ]);
    expect(
      (await workbench.list(staffB, AdminLaunchTaskListQuerySchema.parse({ q: key }))).items.map(
        (row) => row.orderItem.orderItemId,
      ),
    ).toEqual([outside.item.id]);
    const upcoming = await workbench.list(
      staffA,
      AdminLaunchTaskListQuerySchema.parse({ tab: "upcoming", q: key }),
    );
    expect(upcoming.items.map((row) => row.orderItem.orderItemId)).toEqual([
      ready.item.id,
      producing.item.id,
    ]);
    expect(
      (
        await workbench.list(
          staffA,
          AdminLaunchTaskListQuerySchema.parse({ tab: "upcoming", q: key, readyOnly: "true" }),
        )
      ).total,
    ).toBe(1);
    expect(
      await workbench.summary(staffA, LaunchTaskSummaryQuerySchema.parse({ q: key })),
    ).toMatchObject({ overdue: 1, upcoming: 1, deliveringSoon: 1, all: 2 });
    expect(
      await workbench.summary(
        staffA,
        LaunchTaskSummaryQuerySchema.parse({ q: key, readyOnly: "true" }),
      ),
    ).toMatchObject({ overdue: 1, upcoming: 1, deliveringSoon: 0, all: 2 });
    expect(
      await workbench.summary(
        staffA,
        LaunchTaskSummaryQuerySchema.parse({ q: key, managerId: managerB.id }),
      ),
    ).toMatchObject({ overdue: 0, upcoming: 0, deliveringSoon: 0, all: 0 });
    const calendar = await workbench.calendar(staffA, {
      from: "2026-11-01",
      to: "2026-11-16",
      managerId: managerA.id,
      limit: 1,
    });
    expect(calendar).toMatchObject({
      total: 3,
      isTruncated: true,
      stats: { total: 3, overdue: 1, producing: 1, toLaunch: 1, verifying: 0 },
    });
    expect(calendar.days.flatMap((day) => day.items).map((row) => row.orderItemId)).toEqual([
      overdue.item.id,
    ]);
    expect(
      (await workbench.calendar(staffA, { month: "2026-11", managerId: managerB.id })).total,
    ).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it("旧部分核验历史按当时参数还原，不用今天的开关抹掉待补充区间", async () => {
    clock.set(at("2026-11-10"));
    const f = await fixture({
      agreed: "2026-11-01",
      delivered: at("2026-11-01"),
      reviewStatus: "need_fix",
      verified: 1,
    });
    for (const [day, value] of [
      ["2026-10-01", false],
      ["2026-11-07", true],
    ] as const) {
      await prisma.paramValue.create({
        data: {
          id: uuidv7(),
          key: "launch.partial_goes_live",
          value,
          effectiveAt: at(day),
          createdByStaffId: admin.staff.id,
          createdAt: at(day),
        },
      });
    }
    await history(f, [
      { day: "2026-11-01", state: "pending", event: "launch.create" },
      { day: "2026-11-02", state: "verifying", event: "launch.submit" },
      {
        day: "2026-11-03",
        state: "passed",
        event: "launch.verify_pass",
        payload: { roundNo: 1, verifiedEpisodeCount: 1 },
      },
      { day: "2026-11-04", state: "verifying", event: "launch.submit" },
      { day: "2026-11-05", state: "need_fix", event: "launch.return" },
    ]);
    const before = await counts();
    expect((await summary(f.item.id)).last30Days).toEqual({
      overdueItemCount: 1,
      avgOverdueDays: 6,
      liveItemCount: 0,
    });
    expect(await counts()).toEqual(before);
  });

  it("方案未确认仅取已推送当前版本的日期与账号，不泄露未推送草稿", async () => {
    clock.set(at("2026-11-10"));
    const f = await fixture({ agreed: null, phase: "producing", delivered: null, withTask: false });
    await prisma.deliveryTicket.update({
      where: { id: f.ticket.id },
      data: { step: "plan_confirm" },
    });
    const accountId = uuidv7();
    await prisma.channelAccount.create({
      data: {
        id: accountId,
        entityId: f.item.entityId,
        storeId: f.item.storeId,
        platform: "douyin",
        accountName: "方案发布账号",
        accountUid: accountId,
        accountUidNorm: accountId,
        status: "pending_verify",
        submittedAt: clock.now(),
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    const content = {
      focusTags: [],
      referenceAssetIds: [],
      note: null,
      launchMode: "merchant_self",
      items: [
        {
          orderItemId: f.item.id,
          accounts: [{ channelAccountId: accountId, platform: "douyin" }],
          placements: [],
          agreedLaunchDate: "2026-11-12",
          expectedDeliveryDate: "2026-11-11",
        },
      ],
    };
    const plan = await prisma.deliveryPlan.create({
      data: {
        id: uuidv7(),
        entityId: f.item.entityId,
        storeId: f.item.storeId,
        dramaOrderId: f.item.dramaOrderId,
        status: "drafting",
        draft: content,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    const query = { month: "2026-11", managerId: f.ticket.deliveryManagerId! };
    expect((await workbench.calendar(admin, query)).total).toBe(0);
    await prisma.deliveryPlanVersion.create({
      data: {
        id: uuidv7(),
        entityId: f.item.entityId,
        storeId: f.item.storeId,
        deliveryPlanId: plan.id,
        versionNo: 1,
        contentSnapshot: content,
        pushedByStaffId: admin.staff.id,
        pushedAt: clock.now(),
        createdAt: clock.now(),
      },
    });
    await prisma.deliveryPlan.update({
      where: { id: plan.id },
      data: {
        status: "pending_confirm",
        currentVersionNo: 1,
        pushedAt: clock.now(),
      },
    });
    const before = await counts();
    const view = await workbench.calendar(admin, query);
    expect(view.total).toBe(1);
    expect(view.days[0]!.items[0]).toMatchObject({
      orderItemId: f.item.id,
      agreedLaunchDate: "2026-11-12",
      isDateTentative: true,
      calendarStatus: "producing",
      accounts: [{ channelAccountId: accountId }],
      tasks: [],
      isDeliveryLate: true,
    });
    expect(await counts()).toEqual(before);
  });

  it("撤销历史的isLive=false恢复等待区间，不把曾上线误当永久上线", async () => {
    clock.set(at("2026-11-10"));
    const f = await fixture({
      agreed: "2026-11-01",
      delivered: at("2026-11-01"),
      reviewStatus: "need_fix",
    });
    await history(f, [
      { day: "2026-11-01", state: "pending", event: "launch.create" },
      { day: "2026-11-02", state: "verifying", event: "launch.submit" },
      {
        day: "2026-11-03",
        state: "passed",
        event: "launch.verify_pass",
        payload: { roundNo: 1, verifiedEpisodeCount: 3 },
      },
      {
        day: "2026-11-05",
        state: "verifying",
        event: "launch.verify_revoke",
        payload: { roundNo: 2, verifiedEpisodeCount: 0, isLive: false },
      },
      { day: "2026-11-06", state: "need_fix", event: "launch.return" },
    ]);
    expect((await summary(f.item.id)).last30Days).toEqual({
      overdueItemCount: 1,
      avgOverdueDays: 5,
      liveItemCount: 0,
    });
  });

  it("真实只增改期审计的prevDate保留改期前逾期，未来新日期不会清零历史", async () => {
    const f = await fixture({ agreed: "2099-01-01" });
    const audit = await prisma.auditLog.create({
      data: {
        id: uuidv7(),
        stream: "activity",
        category: "delivery",
        action: "delivery.order_item.reschedule_launch",
        summary: "读侧历史夹具：改约定上线日",
        actorType: "staff",
        actorId: admin.staff.id,
        client: "admin",
        actorName: "测试管理员",
        actorRole: "超级管理员",
        targetType: "order_item",
        targetId: f.item.id,
        entityId: f.item.entityId,
        storeId: f.item.storeId,
        before: { agreedLaunchDate: "2020-01-01" },
        after: { agreedLaunchDate: "2099-01-01" },
        meta: {
          orderItemId: f.item.id,
          deliveryTicketId: f.ticket.id,
          prevDate: "2020-01-01",
          newDate: "2099-01-01",
        },
      },
    });
    // audit.created_at 由真实只增触发器赋值；围绕实际落库日布置历史，不改审计时刻。
    const auditDay = calendarDate(audit.createdAt);
    const delivered = startOfDay(addDays(auditDay, -5));
    await prisma.deliveryTicket.update({
      where: { id: f.ticket.id },
      data: { deliveredAt: delivered },
    });
    await history(f, [{ day: addDays(auditDay, -5), state: "pending", event: "launch.create" }]);
    clock.set(new Date(audit.createdAt.getTime() + 5 * 86_400_000));
    const before = await counts();
    const expectedDays = audit.createdAt.getTime() === startOfDay(auditDay).getTime() ? 4 : 5;
    expect((await summary(f.item.id)).last30Days).toEqual({
      overdueItemCount: 1,
      avgOverdueDays: expectedDays,
      liveItemCount: 0,
    });
    expect(await counts()).toEqual(before);
  });
});
