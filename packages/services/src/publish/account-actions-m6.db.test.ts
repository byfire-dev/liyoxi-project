import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createIdentityContext, merchantFactsOf, uuidv7 } from "../kernel/index.js";
import {
  createPatrolTestRuntime,
  createPatrolTestSubject,
  sampleStaffContext,
  snapshotTables,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import type { PublishViewer } from "./context.js";
import { accountOf } from "./repo.js";
import { accountCard } from "./views.js";

const db = useSeededDatabase("services", { max: 2 }),
  redis = useTestRedis();
let stack: ReturnType<typeof createPatrolTestRuntime>;
beforeAll(async () => {
  stack = createPatrolTestRuntime({
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
});
beforeEach(() => stack.clock.set(new Date("2026-01-05T04:00:00Z")));
afterAll(async () => {
  await stack?.runtime.close();
});
const subject = async () => createPatrolTestSubject(stack.runtime, await db.prisma());
const readTables = [
  "channel_account",
  "channel_account_submission",
  "approval_request",
  "order_item_account",
  "takedown_task",
  "status_transition",
  "audit_log",
  "outbox_event",
  "timer",
  "file_ref",
];

it("真实账号状态流转同步动作；后台只向有权限的可用账号提供标记异常", async () => {
  const h = await subject(),
    account = await h.bindAccount(false),
    manager = await sampleStaffContext(h.prisma, h.manager.id),
    filter = { storeId: h.merchant.store.id, page: 1, pageSize: 20 };
  expect(await h.publish.accountDetail(h.staff, account.id)).toMatchObject({ actions: [] });
  expect(await h.publish.channelAccounts(h.viewer, { limit: 20 })).toMatchObject({
    items: [{ channelAccountId: account.id, actions: ["unbind"] }],
  });
  await h.publish.approveAccount(h.adminCtx, h.staff, account.sub.id, account.approvalBody);
  const before = await snapshotTables(h.prisma, readTables);
  expect(await h.health.list(h.staff, filter)).toMatchObject({
    items: [{ channelAccountId: account.id, actions: ["mark-abnormal"] }],
  });
  expect(await h.publish.accountDetail(h.staff, account.id)).toMatchObject({
    actions: ["mark-abnormal"],
  });
  expect(await h.health.list(manager, filter)).toMatchObject({
    items: [{ channelAccountId: account.id, actions: [] }],
  });
  expect(await h.publish.accountDetail(manager, account.id)).toMatchObject({ actions: [] });
  const publisher = await sampleStaffContext(h.prisma, h.publisher.id);
  // 核验角色队列可见并不授予普通账号的门店范围。
  expect(await h.publish.accountSubmission(publisher, account.sub.id)).toMatchObject({
    account: { actions: [] },
  });
  expect(await snapshotTables(h.prisma, readTables)).toEqual(before);
  const reason = await h.prisma.dictItem.findFirstOrThrow({
    where: {
      dictTypeKey: "reject_reason",
      isEnabled: true,
      ext: { path: ["scene"], equals: "account_verify" },
    },
  });
  const body = { reasonCode: reason.code, note: "账号动作回归" };
  await expect(
    h.health.markAbnormal(
      createIdentityContext({ actor: { type: "staff", id: h.publisher.id, client: "admin" } }),
      publisher,
      account.id,
      body,
    ),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  await expect(
    h.health.markAbnormal(
      createIdentityContext({ actor: { type: "staff", id: h.manager.id, client: "admin" } }),
      manager,
      account.id,
      body,
    ),
  ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
  expect(await h.health.markAbnormal(h.adminCtx, h.staff, account.id, body)).toMatchObject({
    status: "abnormal",
    actions: [],
  });
  expect(await h.publish.channelAccounts(h.viewer, { limit: 20 })).toMatchObject({
    items: [{ actions: ["submit", "unbind"] }],
  });
  await expect(h.health.markAbnormal(h.adminCtx, h.staff, account.id, body)).rejects.toMatchObject({
    error: "STATE_NOT_ALLOWED",
  });
  expect(
    await h.publish.resubmit(h.viewer, account.id, {
      accountType: "none",
      screenshotFileIds: account.sub.screenshotFileIds,
    }),
  ).toMatchObject({ status: "pending_verify", actions: ["unbind"] });
  expect(await h.health.unbind(h.viewer, account.id)).toMatchObject({
    status: "unbound",
    actions: [],
  });
  expect(await h.publish.accountDetail(h.staff, account.id)).toMatchObject({ actions: [] });
});

it("只有同主体同店老板获得解绑；首页事实无完整观察者时保留旧动作且读取零写", async () => {
  const h = await subject(),
    foreign = await subject(),
    account = await h.bindAccount(false),
    clerk: PublishViewer = {
      ctx: createIdentityContext({
        actor: { type: "merchant", id: h.merchant.user.id, client: "weapp", role: "clerk" },
        entityId: h.merchant.entity.id,
        storeId: h.merchant.store.id,
      }),
      membership: { ...h.viewer.membership, role: "clerk" },
    };
  await h.publish.rejectAccount(h.adminCtx, h.staff, account.sub.id, {
    reasonCode: "R12",
    note: "补充资料",
    compareRows: account.approvalBody.compareRows,
  });
  const before = await snapshotTables(h.prisma, readTables);
  await h.runtime.tx.run(async (tx) => {
    const row = await accountOf(tx, account.id);
    for (const viewer of [
      undefined,
      clerk,
      foreign.viewer,
      { ...h.viewer, membership: { ...h.viewer.membership, entityId: foreign.merchant.entity.id } },
      { ...h.viewer, membership: { ...h.viewer.membership, storeId: foreign.merchant.store.id } },
      { ...h.viewer, ctx: h.adminCtx },
    ]) {
      expect(await accountCard(tx, row, viewer)).toMatchObject({ actions: ["submit"] });
    }
    expect(await accountCard(tx, row, h.viewer)).toMatchObject({ actions: ["submit", "unbind"] });
    for (const viewerRole of ["owner", "clerk"] as const) {
      const facts = await merchantFactsOf(h.runtime.assembly).source(tx, "publish", {
        entityId: h.merchant.entity.id,
        storeIds: [h.merchant.store.id],
        viewerRole,
        merchantUserId: h.merchant.user.id,
        now: h.runtime.clock.now(),
      });
      expect(facts.stores[h.merchant.store.id]?.channelAccountAttention).toMatchObject({
        actions: ["submit"],
      });
    }
  });
  await expect(h.publish.channelAccounts(clerk, { limit: 20 })).rejects.toMatchObject({
    error: "ROLE_FORBIDDEN",
  });
  await expect(h.health.unbind(clerk, account.id)).rejects.toMatchObject({
    error: "ROLE_FORBIDDEN",
  });
  await expect(h.health.unbind(foreign.viewer, account.id)).rejects.toMatchObject({
    error: "NOT_FOUND",
  });
  const limited = await sampleStaffContext(h.prisma, foreign.publisher.id);
  expect(
    await h.health.list(limited, { storeId: h.merchant.store.id, page: 1, pageSize: 20 }),
  ).toMatchObject({ items: [], total: 0 });
  await expect(h.publish.accountDetail(limited, account.id)).rejects.toMatchObject({
    error: "NOT_FOUND",
  });
  expect(await snapshotTables(h.prisma, readTables)).toEqual(before);
});

it.each(["pending_start", "producing", "to_launch", "live"] as const)(
  "%s 订单引用隐藏解绑，写操作仍重新校验占用",
  async (phase) => {
    const h = await subject();
    let id: string;
    if (phase === "live") {
      id = (await h.launch()).accountId;
    } else {
      id = (await h.bindAccount()).id;
      // 历史未完工引用仅作为读侧守卫输入；不证明订购/交付生产链。
      const order = await h.make.dramaOrder({
          entityId: h.merchant.entity.id,
          storeId: h.merchant.store.id,
          status: phase,
        }),
        item = await h.make.orderItem({ dramaOrderId: order.id, phase });
      await h.prisma.orderItemAccount.create({
        data: {
          orderItemId: item.id,
          channelAccountId: id,
          platform: "douyin",
          createdAt: h.runtime.clock.now(),
        },
      });
    }
    expect(await h.publish.channelAccounts(h.viewer, { limit: 20 })).toMatchObject({
      items: [{ channelAccountId: id, actions: [] }],
    });
    await expect(h.health.unbind(h.viewer, id)).rejects.toMatchObject({
      error: "CHANNEL_ACCOUNT_IN_USE",
    });
  },
);

it.each(["pending_merchant", "merchant_confirmed"] as const)(
  "%s 下架任务独立阻止解绑，不依赖活跃订单引用",
  async (status) => {
    const h = await subject(),
      account = await h.bindAccount(),
      now = h.runtime.clock.now();
    // 仅准备历史取消项及未关闭下架守卫输入，不伪造下架完成或上线核验。
    const order = await h.make.dramaOrder({
        entityId: h.merchant.entity.id,
        storeId: h.merchant.store.id,
        status: "cancelled",
      }),
      item = await h.make.orderItem({ dramaOrderId: order.id, phase: "cancelled" }),
      ticket = await h.make.deliveryTicket({ orderItemId: item.id, step: "terminated" }),
      launch = await h.prisma.launchTask.create({
        data: {
          id: uuidv7(),
          entityId: item.entityId,
          storeId: item.storeId,
          orderItemId: item.id,
          deliveryTicketId: ticket.id,
          channelAccountId: account.id,
          platform: "douyin",
          reviewStatus: "pending",
          createdAt: now,
          updatedAt: now,
        },
      });
    await h.prisma.takedownTask.create({
      data: {
        id: uuidv7(),
        entityId: item.entityId,
        storeId: item.storeId,
        orderItemId: item.id,
        deliveryTicketId: ticket.id,
        launchTaskId: launch.id,
        channelAccountId: account.id,
        triggerKind: "terminated_after_delivery",
        basis: "delivered_unverified",
        usageEndDate: now,
        dueDate: now,
        status,
        ...(status === "merchant_confirmed"
          ? {
              merchantMethod: "not_published",
              merchantConfirmedAt: now,
              merchantConfirmedByUserId: h.merchant.user.id,
              checkDueAt: now,
              slaSnapshot: {},
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      },
    });
    expect(await h.publish.channelAccounts(h.viewer, { limit: 20 })).toMatchObject({
      items: [
        {
          channelAccountId: account.id,
          usage: { inProgressCount: 0, toLaunchCount: 0, liveCount: 0 },
          openTakedownTaskCount: 1,
          actions: [],
        },
      ],
    });
    await expect(h.health.unbind(h.viewer, account.id)).rejects.toMatchObject({
      error: "CHANNEL_ACCOUNT_IN_USE",
    });
  },
);
