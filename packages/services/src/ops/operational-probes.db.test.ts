import { beforeEach, expect, it } from "vitest";
import { createQueueChannel, createTxRunner, uuidv7 } from "../kernel/index.js";
import {
  connectTestDatabase,
  createClock,
  createFactories,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { recurringKey } from "../timers/index.js";
import type { ScheduledJob } from "../timers/index.js";
import { writeAlertFact } from "./alert-facts.js";
import { EVENT_QUIET_MS } from "./alert-rules.js";
import { operationalProbeRules } from "./operational-probe-rules.js";
import { createProbe } from "./probe.js";

const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
beforeEach(() => db.reset(), 60_000);
const at = (time: string) => new Date(`2026-10-13T${time}+08:00`);
const job: ScheduledJob = {
  module: "ops",
  kind: "lyxtest.recurring",
  schedule: { every: "minutes", minutes: 10 },
  deadlineMin: 30,
  missSeverity: "P1",
  run: async () => undefined,
};

it("真实周期SQL按已过期限期次检查，长于节奏的期限仍能发现漏跑，失败旧期不被新期掩盖", async () => {
  const prisma = await db.prisma();
  const make = (time: string, status: "fired" | "failed" | "cancelled", kind = job.kind) =>
    prisma.timer.create({
      data: {
        id: uuidv7(),
        kind,
        fireAt: at(time),
        dedupeKey: recurringKey(kind, at(time)),
        status,
        ...(status === "fired" ? { firedAt: at(time) } : {}),
      },
    });
  await make("11:50:00", "fired");
  await make("12:30:00", "fired");
  const rule = operationalProbeRules(prisma, [job])[0]!;
  expect(await rule.sample(at("12:30:00"))).toEqual([]);
  expect(await rule.sample(at("12:30:00.001"))).toEqual([
    {
      rule: "recurring.missed",
      dimension: job.kind,
      severity: "P1",
      detail: { failed: false, status: "missing" },
    },
  ]);
  const missed = await make("12:00:00", "cancelled");
  expect((await rule.sample(at("12:35:00")))[0]!.detail.status).toBe("cancelled");
  await prisma.timer.update({
    where: { id: missed.id },
    data: { status: "fired", firedAt: at("12:35:00") },
  });
  expect(await rule.sample(at("12:35:00"))).toEqual([]);
  await make("11:40:00", "failed");
  expect((await rule.sample(at("12:35:00")))[0]!.detail.failed).toBe(true);
  const noDeadline = {
    ...job,
    kind: "lyxtest.no_deadline",
    deadlineMin: undefined,
    missSeverity: "P2" as const,
  };
  const failureOnly = operationalProbeRules(prisma, [noDeadline])[0]!;
  expect(await failureOnly.sample(at("12:35:00"))).toEqual([]);
  await make("11:40:00", "failed", noDeadline.kind);
  expect((await failureOnly.sample(at("12:35:00")))[0]!.severity).toBe("P2");
  expect(
    await operationalProbeRules(prisma, [{ ...job, missSeverity: undefined }])[0]!.sample(
      at("12:35:00"),
    ),
  ).toEqual([]);
});

it("数据库探针真实查询当前库与角色；聚合越限才发P2，坏读数不冒充正常", async () => {
  const prisma = await db.prisma(),
    rule = operationalProbeRules(prisma, [])[1]!;
  expect(await rule.sample(at("12:35:00"))).toEqual([]);
  // 两个实际连接，不等待60秒；角色切换遮住统计时必须报未知，不能误报零。
  const monitor = await connectTestDatabase(db.name, { role: null });
  try {
    await monitor.query("BEGIN");
    await expect(rule.sample(at("12:35:00"))).rejects.toThrow("统计可见性");
    const identity = await prisma.$queryRawUnsafe<{ login: string; active: string }[]>(
      "SELECT session_user::text AS login,current_user::text AS active",
    );
    expect(identity[0]!.login).not.toBe(identity[0]!.active);
    const visible = {
      async $queryRawUnsafe<T>(query: string) {
        return (await monitor.query(query)).rows as T;
      },
    };
    expect(await operationalProbeRules(visible, [])[1]!.sample(at("12:35:00"))).toEqual([]);
  } finally {
    await monitor.query("ROLLBACK");
    await monitor.end();
  }
  const aggregate = (count: unknown) => ({
    async $queryRawUnsafe<T>() {
      return [{ count, hidden: 0 }] as T;
    },
  });
  expect(await operationalProbeRules(aggregate(2), [])[1]!.sample(at("12:35:00"))).toEqual([
    { rule: "db.long_transaction", severity: "P2", detail: { count: 2 } },
  ]);
  await expect(
    operationalProbeRules(aggregate("bad"), [])[1]!.sample(at("12:35:00")),
  ).rejects.toThrow();
});

it("Redis探针消费真实通道ping，连接关闭能发现故障；未装配ping不伪造检查", async () => {
  const prisma = await db.prisma();
  await redis.flush();
  const channel = createQueueChannel({
    redisUrl: process.env.REDIS_URL!,
    prefix: `${redis.prefix}bull`,
  });
  try {
    await expect.poll(() => channel.ping(), { timeout: 2000, interval: 10 }).toBe(true);
    const rule = operationalProbeRules(prisma, [], () => channel.ping()).find(
      (one) => one.key === "redis",
    )!;
    expect(await rule.sample(at("12:35:00"))).toEqual([]);
    await channel.close();
    expect(await rule.sample(at("12:35:00"))).toEqual([
      { rule: "redis.unavailable", severity: "P2", detail: { available: false } },
    ]);
    expect(operationalProbeRules(prisma, []).some((one) => one.key === "redis")).toBe(false);
  } finally {
    await channel.close();
  }
});

it("主租约完成轮次只恢复超过六小时的事件，边界/探针保留，重复新发另留历史", async () => {
  const prisma = await db.prisma(),
    clock = createClock(at("12:35:00")),
    tx = createTxRunner({ prisma, appEnv: "test" });
  const old = new Date(clock.now().getTime() - EVENT_QUIET_MS - 1),
    edge = new Date(old.getTime() + 1);
  await tx.run(async (handle) => {
    for (const [dimension, time, kind] of [
      ["old", old, "event"],
      ["edge", edge, "event"],
      ["probe", old, "probe"],
    ] as const)
      await writeAlertFact(
        handle,
        { rule: "timer.failed", dimension, severity: "P2", detail: {} },
        kind,
        time,
      );
  });
  const original = await prisma.alertEvent.findFirstOrThrow({
    where: { fingerprint: "timer.failed:old" },
  });
  const staff = await createFactories({ db: prisma, clock }).staff();
  await prisma.alertEvent.update({
    where: { id: original.id },
    data: {
      status: "acked",
      ackedByStaffId: staff.id,
      ackedAt: old,
      notifyCount: 1,
      lastNotifiedAt: old,
    },
  });
  await prisma.$executeRawUnsafe(`INSERT INTO worker_lease(name,holder,holder_version,acquired_at,heartbeat_at)
    VALUES('primary','node-a:test','test',clock_timestamp(),clock_timestamp())`);
  let holder: string | undefined;
  const probe = createProbe({
    db: prisma,
    tx,
    clock,
    rules: [],
    holder: () => holder,
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    expect((await probe.run()).completed).toBe(false);
    expect(await prisma.alertEvent.count({ where: { status: "resolved" } })).toBe(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    holder = "node-a:test";
    expect((await probe.run()).completed).toBe(true);
    expect(await prisma.alertEvent.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject(
      {
        status: "resolved",
        resolvedAt: clock.now(),
        lastValue: { _recoveryReason: "quiet" },
        occurrences: 1,
        notifyCount: 1,
        ackedByStaffId: staff.id,
        ackedAt: old,
        lastNotifiedAt: old,
      },
    );
    expect(await prisma.alertEvent.count({ where: { status: "open" } })).toBe(2);
    await tx.run((handle) =>
      writeAlertFact(
        handle,
        { rule: "timer.failed", dimension: "old", severity: "P2", detail: {} },
        "event",
        clock.now(),
      ),
    );
    expect(await prisma.alertEvent.count({ where: { fingerprint: "timer.failed:old" } })).toBe(2);
    expect(
      (await prisma.workerLease.findUniqueOrThrow({ where: { name: "primary" } })).probeAt,
    ).toEqual(clock.now());
  } finally {
    await probe.close();
  }
});
