import { afterAll, beforeAll, expect, it } from "vitest";
import { createPrismaClient } from "@liyoxi/db";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import { useSeededDatabase, notificationFixture } from "../testing/index.js";
import { createNotifyDispatcher } from "./service.js";

const db = useSeededDatabase("services");
let h: ReturnType<typeof notificationFixture>;
let other: ReturnType<typeof createPrismaClient>;
let second: ReturnType<typeof createNotifyDispatcher>;
beforeAll(async () => {
  h = notificationFixture(await db.prisma());
  other = createPrismaClient({ connectionString: await db.url(), max: 1 });
  second = createNotifyDispatcher({
    ...h.deps,
    tx: createTxRunner({ prisma: other, appEnv: "test" }),
  });
  const staff = await h.make.staff();
  await h.prisma.paramValue.create({
    data: {
      id: uuidv7(),
      key: "notify.fanout.batch",
      value: 2,
      effectiveAt: h.clock.now(),
      createdAt: h.clock.now(),
      createdByStaffId: staff.id,
      reason: "虚构公告分页边界，只隔离测试容量",
    },
  });
  await Promise.all([
    h.make.subscribedMerchant(),
    h.make.subscribedMerchant(),
    h.make.subscribedMerchant(),
  ]);
}, 120_000);
afterAll(async () => {
  await Promise.all([h?.service.close(), second?.close()]);
  await other?.$disconnect();
});
async function notice() {
  const staff = await h.make.staff(),
    now = h.clock.now();
  const row = await h.prisma.siteNotice.create({
    data: {
      id: uuidv7(),
      kind: "plan_revision",
      refId: uuidv7(),
      title: "虚构公告分页",
      summary: "虚构通知，不包含真实法规或价格",
      summaryNoPrice: "虚构通知摘要",
      effectiveAt: new Date(now.getTime() + 7 * 86_400_000),
      announcedAt: now,
      leadDays: 7,
      link: { route: "wallet.home", params: {} },
      createdByStaffId: staff.id,
      createdAt: now,
      updatedAt: now,
    },
  });
  const event = {
    id: uuidv7(),
    type: "site_notice.announced",
    payload: { v: 1, siteNoticeId: row.id },
  };
  await h.tx.run((tx) => h.service.onEvent(tx, event));
  const task = await h.prisma.notificationFanout.findFirstOrThrow({
    where: { siteNoticeId: row.id },
  });
  return { row, staff, event, task };
}
const taskAt = (id: string) => h.prisma.notificationFanout.findUniqueOrThrow({ where: { id } });
const messages = (id: string) =>
  h.prisma.merchantMessage.findMany({
    where: { notification: { bizId: id, notifySceneKey: "m.rule_change_notice" } },
    orderBy: [{ merchantUserId: "asc" }, { entityId: "asc" }],
  });
async function finish(id: string) {
  for (let n = 0; n < 20 && (await taskAt(id)).status === "pending"; n++)
    await h.service.deliver({ fanoutId: id });
  expect((await taskAt(id)).status).toBe("sent");
}

it("batch+1真实探测只生成持久task，两个连接同页CAS且分页游标/消息同时提交、重入不重复", async () => {
  expect(await h.deps.params.get("notify.fanout.batch")).toBe(2);
  const { row, event, task } = await notice();
  const recipients = await h.tx.run((tx) =>
    h.noticeRecipientsPage(tx, { after: null, take: 10_001 }),
  );
  expect(recipients.length).toBeGreaterThan(2);
  expect(await messages(row.id)).toHaveLength(0);
  await h.tx.run((tx) => h.service.onEvent(tx, { ...event, id: uuidv7() }));
  expect(await h.prisma.notificationFanout.count({ where: { siteNoticeId: row.id } })).toBe(1);
  const jobs: string[] = [];
  await h.service.scan(async (ref) => {
    if ("fanoutId" in ref && ref.fanoutId === task.id) jobs.push(ref.pageKey);
  });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const local = createNotifyDispatcher({
    ...h.deps,
    purchaseMode: async () => {
      enter();
      await gate;
      return "in_app";
    },
  });
  const running = local.deliver({ fanoutId: task.id });
  try {
    await entered;
    await second.deliver({ fanoutId: task.id });
    expect((await taskAt(task.id)).status).toBe("sending");
    release();
    await running;
  } finally {
    release();
    await Promise.allSettled([running]);
    await local.close();
  }
  const first = await taskAt(task.id);
  expect(first).toMatchObject({
    status: "pending",
    attemptNo: 0,
    leaseUntil: null,
    cursorMerchantUserId: recipients[1]!.merchantUserId,
    cursorEntityId: recipients[1]!.entityId,
  });
  expect(await messages(row.id)).toHaveLength(2);
  await h.service.scan(async (ref) => {
    if ("fanoutId" in ref && ref.fanoutId === task.id) jobs.push(ref.pageKey);
  });
  expect(jobs).toHaveLength(2);
  expect(jobs[0]).not.toBe(jobs[1]);
  await finish(task.id);
  expect((await messages(row.id)).map((item) => [item.merchantUserId, item.entityId])).toEqual(
    recipients.map((item) => [item.merchantUserId, item.entityId]),
  );
  await h.service.deliver({ fanoutId: task.id });
  expect(await messages(row.id)).toHaveLength(recipients.length);
  expect(
    await h.prisma.notificationDelivery.count({
      where: {
        notification: { bizId: row.id },
        channel: { not: "inbox" },
      },
    }),
  ).toBe(0);
});

it("页租约在业务TX内过期使最后CAS失败，已写站内消息全回滚而游标保持", async () => {
  const { row, task } = await notice();
  let calls = 0;
  const local = createNotifyDispatcher({
    ...h.deps,
    purchaseMode: async () => {
      if (++calls === 2) h.clock.advance(61_000);
      return "in_app";
    },
  });
  try {
    await local.deliver({ fanoutId: task.id });
    expect(calls).toBe(2);
    expect(await messages(row.id)).toHaveLength(0);
    expect(await taskAt(task.id)).toMatchObject({
      status: "pending",
      attemptNo: 1,
      cursorMerchantUserId: null,
      cursorEntityId: null,
      leaseUntil: null,
    });
    h.clock.advance(31_000);
    await finish(task.id);
  } finally {
    await local.close();
  }
});

it("每页真实业务错误整页回滚，三次上限保留failed且不把部分页推进为成功", async () => {
  const { row, task } = await notice();
  let calls = 0;
  const local = createNotifyDispatcher({
    ...h.deps,
    purchaseMode: async () => {
      if (++calls % 2 === 0) throw new Error("fictional page rollback");
      return "in_app";
    },
  });
  try {
    for (let n = 1; n <= 3; n++) {
      await local.deliver({ fanoutId: task.id });
      expect(await messages(row.id)).toHaveLength(0);
      expect(await taskAt(task.id)).toMatchObject({
        status: n === 3 ? "failed" : "pending",
        attemptNo: n,
        cursorMerchantUserId: null,
        cursorEntityId: null,
        leaseUntil: null,
      });
      h.clock.advance(n === 1 ? 31_000 : 121_000);
    }
    await local.deliver({ fanoutId: task.id });
    expect(calls).toBe(6);
  } finally {
    await local.close();
  }
});

it("公告共享守卫锁真实阻挡另一连接撤回，当前页提交后下一页取消；撤回有独立task", async () => {
  const { row, task, staff } = await notice();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const local = createNotifyDispatcher({
    ...h.deps,
    purchaseMode: async () => {
      enter();
      await gate;
      return "in_app";
    },
  });
  const [backend] = await other.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  if (!backend) throw new Error("虚构撤回连接未返回 backend PID");
  const { pid } = backend;
  const sending = local.deliver({ fanoutId: task.id });
  let withdraw: Promise<unknown> | undefined;
  try {
    await entered;
    withdraw = other.siteNotice
      .update({
        where: { id: row.id },
        data: {
          status: "withdrawn",
          withdrawnAt: h.clock.now(),
          withdrawnByStaffId: staff.id,
        },
      })
      .then((value) => value);
    let blocked = false;
    for (let n = 0; n < 100 && !blocked; n++) {
      const [state] = await h.prisma.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${pid} AND NOT granted) AS waiting`;
      blocked = state?.waiting === true;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    expect(await messages(row.id)).toHaveLength(0);
    release();
    await Promise.all([sending, withdraw]);
    expect(await messages(row.id)).toHaveLength(2);
    await h.service.deliver({ fanoutId: task.id });
    expect((await taskAt(task.id)).status).toBe("cancelled");
    await h.tx.run((tx) =>
      h.service.onEvent(tx, {
        id: uuidv7(),
        type: "site_notice.withdrawn",
        payload: { v: 1, siteNoticeId: row.id },
      }),
    );
    const cancellation = await h.prisma.notificationFanout.findFirstOrThrow({
      where: { siteNoticeId: row.id, notifySceneKey: "m.rule_change_withdrawn" },
    });
    expect(cancellation.id).not.toBe(task.id);
    await finish(cancellation.id);
  } finally {
    release();
    await Promise.allSettled([sending, withdraw]);
    await local.close();
  }
});

it("关闭等待在途分页TX，未提交页回滚并恢复task而不丢掉后续接收人", async () => {
  const { row, task } = await notice();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const local = createNotifyDispatcher({
    ...h.deps,
    purchaseMode: async () => {
      enter();
      await gate;
      return "in_app";
    },
  });
  const sending = local.deliver({ fanoutId: task.id });
  let shutdown: Promise<void> | undefined,
    shut = false;
  try {
    await entered;
    shutdown = local.close().then(() => {
      shut = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shut).toBe(false);
    release();
    await Promise.all([sending, shutdown]);
    expect(await messages(row.id)).toHaveLength(0);
    expect(await taskAt(task.id)).toMatchObject({
      status: "pending",
      attemptNo: 0,
      cursorMerchantUserId: null,
      cursorEntityId: null,
      leaseUntil: null,
    });
    await finish(task.id);
  } finally {
    release();
    await Promise.allSettled([sending, shutdown]);
    await local.close();
  }
});
