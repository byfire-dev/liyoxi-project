import { afterEach, beforeEach, expect, it } from "vitest";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import { createClock, useSeededDatabase } from "../testing/index.js";
import { writeAlertFact, writeHealthyProbeFact, writeUnknownProbeFact } from "./alert-facts.js";
import { createProbe } from "./probe.js";
import { sqlProbeRules } from "./probe-rules.js";
import type { ProbeRule } from "./probe-rules.js";

const db = useSeededDatabase("services", { max: 1 });
const owners: ReturnType<typeof createProbe>[] = [];
beforeEach(() => db.reset(), 60_000);
afterEach(async () => {
  await Promise.allSettled(owners.splice(0).map((owner) => owner.close()));
});
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup() {
  const prisma = await db.prisma(),
    clock = createClock(),
    tx = createTxRunner({ prisma, appEnv: "test" });
  await prisma.$executeRawUnsafe(`INSERT INTO worker_lease(name,holder,holder_version,acquired_at,heartbeat_at)
    VALUES('primary','node-a:test','test',clock_timestamp(),clock_timestamp())
    ON CONFLICT(name) DO UPDATE SET holder='node-a:test',heartbeat_at=clock_timestamp(),probe_at=NULL`);
  const logs: Record<string, unknown>[] = [],
    log = (data: Record<string, unknown>) => {
      logs.push(data);
    };
  const make = (
    rules: readonly ProbeRule[],
    extra: Partial<Parameters<typeof createProbe>[0]> = {},
  ) => {
    const owner = createProbe({
      db: prisma,
      tx,
      clock,
      holder: () => "node-a:test",
      rules,
      logger: { info: log, warn: log, error: log },
      ...extra,
    });
    owners.push(owner);
    return owner;
  };
  const tick = async (owner: ReturnType<typeof createProbe>) => {
    clock.advance(60_000);
    const result = await owner.run();
    // 等已完成轮次清除 coalescing 标记；不等待下一分钟或扩大负载。
    await new Promise<void>((resolve) => setImmediate(resolve));
    return result;
  };
  return { prisma, clock, tx, make, logs, tick };
}

it("真实四组SQL写越限事实，三次不同正常观测恢复，probe_at取完成时间", async () => {
  const h = await setup(),
    at = h.clock.now(),
    old = new Date(at.getTime() - 700_000);
  const event = await h.prisma.outboxEvent.create({
    data: {
      id: uuidv7(),
      eventType: "lyxtest.probe",
      payload: { v: 1 },
      actorType: "system",
      occurredAt: old,
    },
  });
  const timer = await h.prisma.timer.create({
    data: { id: uuidv7(), kind: "lyxtest.probe", fireAt: old, dedupeKey: uuidv7() },
  });
  const violation = await h.prisma.invariantViolation.create({
    data: {
      id: uuidv7(),
      code: "lyxtest.I1",
      module: "ops",
      severity: "P2",
      detail: {},
      firstSeenAt: at,
      lastSeenAt: at,
    },
  });
  const webhook = await h.prisma.webhookEvent.create({
    data: {
      id: uuidv7(),
      provider: "asr",
      eventId: uuidv7(),
      eventType: "lyxtest.probe",
      mode: "inbox",
      receivedAt: old,
      payloadDigest: Buffer.alloc(32),
      processState: "received",
      nextAttemptAt: old,
    },
  });
  const rules = sqlProbeRules(h.prisma).map((rule) => ({
    ...rule,
    async sample(now: Date) {
      const result = await rule.sample(now);
      h.clock.advance(1);
      return result;
    },
  }));
  const owner = h.make(rules);
  expect(await owner.run()).toMatchObject({ completed: true, samples: 4, failed: 0 });
  expect(
    await h.prisma.alertEvent.findMany({
      select: { fingerprint: true, severity: true },
      orderBy: { fingerprint: "asc" },
    }),
  ).toEqual([
    { fingerprint: "invariant.unresolved:P2", severity: "P2" },
    { fingerprint: "outbox.unpublished", severity: "P1" },
    { fingerprint: "timer.lag", severity: "P1" },
    { fingerprint: "webhook.backlog", severity: "P2" },
  ]);
  expect(
    (await h.prisma.workerLease.findUniqueOrThrow({ where: { name: "primary" } })).probeAt,
  ).toEqual(h.clock.now());
  expect(h.clock.now().getTime()).toBeGreaterThan(at.getTime());
  await h.prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: at } });
  await h.prisma.timer.update({ where: { id: timer.id }, data: { status: "cancelled" } });
  await h.prisma.invariantViolation.update({
    where: { id: violation.id },
    data: { resolvedAt: at, autoHealedAt: at, resolution: "auto_healed" },
  });
  await h.prisma.webhookEvent.update({
    where: { id: webhook.id },
    data: { processState: "processed", processedAt: at, nextAttemptAt: null },
  });
  for (let n = 0; n < 2; n++) expect((await h.tick(owner)).completed).toBe(true);
  expect(await h.prisma.alertEvent.count({ where: { status: "resolved" } })).toBe(0);
  await h.tick(owner);
  expect(await h.prisma.alertEvent.count({ where: { status: "resolved", okStreak: 3 } })).toBe(4);
  await h.tx.run(async (tx) => {
    await writeAlertFact(
      tx,
      { rule: "outbox.unpublished", severity: "P1", detail: {} },
      "probe",
      h.clock.now(),
      at,
    );
    await writeHealthyProbeFact(tx, { rule: "outbox.unpublished" }, h.clock.now(), at);
    await writeUnknownProbeFact(tx, { rule: "outbox.unpublished" }, h.clock.now(), at);
  });
  expect(await h.prisma.alertEvent.count()).toBe(4);
  expect(await h.prisma.alertEvent.count({ where: { status: "resolved", okStreak: 3 } })).toBe(4);
});

it("采样失败三次才告警；一次未知打断业务与probe.failed连续正常计数", async () => {
  const h = await setup();
  await h.tx.run((tx) =>
    writeAlertFact(
      tx,
      { rule: "outbox.unpublished", severity: "P1", detail: {} },
      "probe",
      h.clock.now(),
      h.clock.now(),
    ),
  );
  let failing = true;
  const owner = h.make([
    {
      key: "outbox",
      targets: [{ rule: "outbox.unpublished" }],
      async sample() {
        if (failing) throw new Error("private-database-detail");
        return [];
      },
    },
  ]);
  for (let n = 0; n < 2; n++)
    expect(await h.tick(owner)).toMatchObject({ completed: true, failed: 1 });
  expect(await h.prisma.alertEvent.count({ where: { rule: "probe.failed" } })).toBe(0);
  await h.tick(owner);
  expect(
    await h.prisma.alertEvent.findFirstOrThrow({ where: { rule: "probe.failed" } }),
  ).toMatchObject({ severity: "P2", status: "open", okStreak: 0 });
  failing = false;
  await h.tick(owner);
  await h.tick(owner);
  expect(await h.prisma.alertEvent.count({ where: { okStreak: 2 } })).toBe(2);
  failing = true;
  await h.tick(owner);
  expect(await h.prisma.alertEvent.count({ where: { okStreak: 0, status: "open" } })).toBe(2);
  failing = false;
  await h.tick(owner);
  expect(await h.prisma.alertEvent.count({ where: { okStreak: 1, status: "open" } })).toBe(2);
  await h.tick(owner);
  await h.tick(owner);
  expect(await h.prisma.alertEvent.count({ where: { status: "resolved" } })).toBe(2);
  expect(JSON.stringify(h.logs)).not.toContain("private-database-detail");
});

it("定时器派发失联留两分钟给扫描接管，持续未恢复才告警", async () => {
  const h = await setup(),
    at = h.clock.now();
  const row = await h.prisma.timer.create({
    data: {
      id: uuidv7(),
      kind: "lyxtest.probe",
      fireAt: at,
      dedupeKey: uuidv7(),
      status: "dispatched",
      leaseUntil: at,
      isEnqueued: true,
      dispatchNo: 1,
    },
  });
  const rule = sqlProbeRules(h.prisma).find((one) => one.key === "timer")!;
  h.clock.advance(120_000);
  expect(await rule.sample(h.clock.now())).toEqual([]);
  h.clock.advance(1);
  expect(await rule.sample(h.clock.now())).toEqual([
    { rule: "timer.lost_dispatch", severity: "P2", detail: { value: 1 } },
  ]);
  await h.prisma.timer.update({
    where: { id: row.id },
    data: { leaseUntil: new Date(h.clock.now().getTime() + 60_000), dispatchNo: 2 },
  });
  expect(await rule.sample(h.clock.now())).toEqual([]);
});

it("只许主租约采样；并发上限三且运行中被接任后零迟到落库", async () => {
  const h = await setup(),
    entered = gate<void>(),
    release = gate<void>();
  let calls = 0,
    active = 0,
    peak = 0;
  const rules: ProbeRule[] = Array.from({ length: 4 }, (_, n) => ({
    key: `test${n}`,
    targets: [],
    async sample() {
      calls++;
      active++;
      peak = Math.max(peak, active);
      if (active === 3) entered.resolve();
      await release.promise;
      active--;
      return [{ rule: "outbox.dead", severity: "P1", detail: {} }];
    },
  }));
  const noLease = h.make(rules, { holder: () => undefined });
  expect((await noLease.run()).completed).toBe(false);
  expect(calls).toBe(0);
  const owner = h.make(rules),
    running = owner.run();
  expect(owner.run()).toBe(running);
  await entered.promise;
  expect(calls).toBe(3);
  expect(peak).toBe(3);
  await h.prisma.$executeRawUnsafe(
    "UPDATE worker_lease SET holder='node-b:test' WHERE name='primary'",
  );
  release.resolve();
  expect((await running).completed).toBe(false);
  await owner.close();
  expect(await h.prisma.alertEvent.count()).toBe(0);
  expect(
    (await h.prisma.workerLease.findUniqueOrThrow({ where: { name: "primary" } })).probeAt,
  ).toBeNull();
});

it("短预算退出不伪报完成，close等底层采样收完且禁止重入与迟到写", async () => {
  const h = await setup(),
    entered = gate<void>(),
    release = gate<void>();
  let calls = 0;
  const owner = h.make(
    [
      {
        key: "blocked",
        targets: [],
        async sample() {
          calls++;
          entered.resolve();
          await release.promise;
          return [{ rule: "outbox.dead", severity: "P1", detail: {} }];
        },
      },
    ],
    { budgetMs: 100, queryMs: 100 },
  );
  const running = owner.run();
  await entered.promise;
  expect((await running).completed).toBe(false);
  expect(owner.run()).toBe(running);
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(closed).toBe(false);
  release.resolve();
  await closing;
  await expect(owner.run()).rejects.toThrow("已关闭");
  expect(calls).toBe(1);
  expect(await h.prisma.alertEvent.count()).toBe(0);
  expect(
    (await h.prisma.workerLease.findUniqueOrThrow({ where: { name: "primary" } })).probeAt,
  ).toBeNull();
});
