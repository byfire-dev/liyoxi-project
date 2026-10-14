import { PassThrough, Readable, Transform } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNotInTransaction,
  createTxRunner,
  guardProviderCall,
  uuidv7,
} from "../kernel/index.js";
import { guardProviders } from "../providers/types.js";
import {
  assembleForTest,
  createClock,
  createFakeProviders,
  createFakeStorage,
  useSeededDatabase,
} from "../testing/index.js";
import { armRecurringSlot, claimTimers, recurringKey } from "../timers/index.js";
import { BACKUP_STALE_MS, backupProbeRules } from "./backup-probe-rules.js";
import type { BackupConfig, BackupProcessRunner } from "./backup.js";
import { buildWorkerServices } from "./worker.js";

const db = useSeededDatabase("services", { label: "backup", max: 1 });
let prisma: Awaited<ReturnType<typeof db.prisma>>;
const workers: ReturnType<typeof buildWorkerServices>[] = [];
const clock = createClock(new Date("2026-10-14T04:00:00Z"));
const config: BackupConfig = {
  databaseUrl:
    "postgresql://backup_reader:fictional-private-password@db.example.invalid:5432/fictional",
  recipient: "age1ntnnfzy39drf2yscy0yr9e93frec8yzh8jelk5yrjmnra600adyse8ycjw",
  maxBytes: 1024,
  target: { bucket: "fictional-backups", prefix: "worker/" },
};
beforeEach(async () => {
  await db.reset();
  prisma = await db.prisma();
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const worker of workers.splice(0)) {
    await worker.closeBackups?.();
    await worker.shutdownMediaJobs?.();
    await Promise.allSettled([
      worker.closeProbes?.(),
      worker.closeCertificates?.(),
      worker.closeDocs(),
      worker.closeNotify(),
      worker.closeAnalytics?.(),
      worker.closeStaff?.(),
      worker.closeSmsHealth?.(),
      worker.closeModelBudget?.(),
      worker.closeProfile?.(),
      worker.documentConverter?.close(),
    ]);
    worker.closeWebhooks?.();
    worker.closeOrder?.();
    worker.closeBillingTimers?.();
    worker.closePublish?.();
    worker.closeDelivery?.();
    worker.closeMediaJobs?.();
    worker.closeInvitations?.();
    worker.closeApproval?.();
    await Promise.allSettled([worker.closeStorageDrivers?.(), worker.closeMediaDrivers?.()]);
    await worker.closeAlertFacts?.();
  }
}, 60_000);

function build(processRunner: BackupProcessRunner, configured = true) {
  const storage = createFakeStorage({ clock, backup: config.target });
  const providers = guardProviders(
    { ...createFakeProviders({ clock }), storage },
    guardProviderCall,
  );
  const worker = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock,
    providers,
    assembly: assembleForTest({ entry: "worker" }),
    keys: configured ? { BACKUP: config } : {},
    backupProcessRunner: processRunner,
    channel: { enqueue: async () => {}, downForMs: () => 0 },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  workers.push(worker);
  return { worker, storage };
}

describe("备份真实worker、原定时器与只读陈旧探针", { timeout: 60_000 }, () => {
  it("实际登记03:10 job写成功result；失败沿原租约三次耗尽，缺配也失败且零进程", async () => {
    const [databaseNow] = await prisma.$queryRawUnsafe<Array<{ at: Date }>>("SELECT now() AS at");
    clock.set(databaseNow!.at);
    let fail = false;
    const processRunner = vi.fn<BackupProcessRunner>((command, args) => {
      assertNotInTransaction("backup-test.process");
      if (fail && command === "pg_dump" && !args.includes("--version"))
        throw new Error(config.databaseUrl);
      const cipher = new Transform({
        transform(_chunk, _encoding, done) {
          done();
        },
        flush(done) {
          this.push(Buffer.alloc(60, 0xa7));
          done();
        },
      });
      return {
        stdin: command === "age" ? cipher : new PassThrough(),
        stdout:
          command === "age"
            ? cipher
            : Readable.from([
                args.includes("--version") ? "pg_dump (PostgreSQL) 17.6\n" : "PGDMP fictional rows",
              ]),
        stderr: Readable.from([]),
        exited: Promise.resolve({ code: 0, signal: null }),
        kill: vi.fn(),
      };
    });
    const { worker, storage } = build(processRunner);
    const job = worker.assembly.recurringJob("backup.pgdump")!;
    expect(job).toBe(worker.assembly.recurringJobs.find((item) => item.kind === "backup.pgdump"));
    expect(job).toMatchObject({
      schedule: { every: "day", at: "03:10" },
      mode: "job",
      leaseSec: 1800,
      maxAttempts: 3,
      deadlineMin: 180,
      catchUp: true,
      missSeverity: "P1",
    });
    expect(
      worker.timers.registry.recurringJobs.find((item) => item.kind === job.kind),
    ).toMatchObject(job);
    const tx = createTxRunner({ prisma, appEnv: "test" });
    const successfulSlot = new Date(clock.now().getTime() - 2 * 86400000);
    const failedSlot = new Date(clock.now().getTime() - 86400000);
    const arm = async (slot: Date) => {
      await tx.run((handle) => armRecurringSlot(handle, job.kind, slot));
      return prisma.timer.findFirstOrThrow({ where: { dedupeKey: recurringKey(job.kind, slot) } });
    };
    const claim = async (timerId: string) => {
      const claimed = await tx.run((handle) =>
        claimTimers(handle, worker.timers.registry, clock.now(), 1),
      );
      const ref = claimed.claimed.find((item) => item.timerId === timerId);
      expect(ref).toBeDefined();
      return ref!;
    };
    const success = await arm(successfulSlot),
      ref = await claim(success.id);
    expect(await worker.runTimer(ref)).toBe("fired");
    expect(await worker.runTimer(ref)).toBe("stale");
    const completed = await prisma.timer.findUniqueOrThrow({ where: { id: success.id } });
    expect(completed).toMatchObject({
      status: "fired",
      attempts: 0,
      leaseUntil: null,
      firedAt: expect.any(Date),
    });
    expect(completed.result).toEqual({
      key: `daily/${new Date(successfulSlot.getTime() + 28800000).toISOString().slice(0, 10)}.dump.age`,
      bytes: 60,
      seconds: expect.any(Number),
      pgDumpVersion: "17.6",
    });
    expect(storage.backupObjects.size).toBeGreaterThanOrEqual(1);
    fail = true;
    const failing = await arm(failedSlot);
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1)
        await prisma.timer.update({ where: { id: failing.id }, data: { leaseUntil: new Date(0) } });
      expect(await worker.runTimer(await claim(failing.id))).toBe(
        attempt === 3 ? "failed" : "retry",
      );
      const row = await prisma.timer.findUniqueOrThrow({ where: { id: failing.id } });
      expect(row).toMatchObject({
        status: attempt === 3 ? "failed" : "dispatched",
        attempts: attempt,
        result: null,
        firedAt: null,
      });
      expect(row.lastError).toBe("Error: 备份任务失败或已取消");
      expect(row.leaseUntil === null).toBe(attempt === 3);
      expect(JSON.stringify(row)).not.toContain(config.databaseUrl);
      expect(JSON.stringify(row)).not.toContain("fictional-private-password");
    }
    expect(await prisma.timer.count()).toBe(3); // 成功期、失败期及原claim补上的下一期。
    expect(
      await prisma.alertEvent.findFirstOrThrow({ where: { rule: "backup.failed" } }),
    ).toMatchObject({ severity: "P1", lastValue: { reason: "failed" } });
    const noProcess = vi.fn<BackupProcessRunner>();
    const unconfigured = build(noProcess, false).worker;
    await expect(
      unconfigured.assembly.recurringJob(job.kind)!.run({ scheduledFor: clock.now() }),
    ).rejects.toThrow("备份任务未配置");
    expect(noProcess).not.toHaveBeenCalled();
    const closing = unconfigured.closeBackups!();
    expect(unconfigured.closeBackups!()).toBe(closing);
    await closing;
    expect(() =>
      unconfigured.assembly.recurringJob(job.kind)!.run({ scheduledFor: clock.now() }),
    ).toThrow("已经关闭");
  });

  it("严格26小时边界；业务主体/失败/别kind摘要不能冒充成功，损坏或未来事实未知且读侧零写", async () => {
    const at = new Date("2026-10-14T04:00:00Z");
    const result = {
      key: "daily/2026-10-13.dump.age",
      bytes: 60,
      seconds: 1,
      pgDumpVersion: "17.6",
    };
    const businessId = uuidv7(),
      failedId = uuidv7();
    await prisma.timer.createMany({
      data: [
        {
          id: businessId,
          kind: "backup.pgdump",
          subjectType: "lyxtest_row",
          subjectId: uuidv7(),
          fireAt: at,
          dedupeKey: `lyxtest:business:${businessId}`,
          status: "fired",
          firedAt: at,
          result,
        },
        {
          id: failedId,
          kind: "backup.pgdump",
          fireAt: at,
          dedupeKey: `lyxtest:failed:${failedId}`,
          status: "failed",
          result,
        },
      ],
    });
    const rule = backupProbeRules(prisma)[0]!;
    expect(rule.targets).toEqual([{ rule: "backup.stale" }]);
    const snapshot = async () => ({
      timers: await prisma.timer.findMany({ orderBy: { id: "asc" } }),
      alerts: await prisma.alertEvent.findMany({ orderBy: { id: "asc" } }),
    });
    const sample = async (now: Date) => {
      const before = await snapshot();
      try {
        return await rule.sample(now);
      } finally {
        expect(await snapshot()).toEqual(before);
      }
    };
    expect(await sample(at)).toEqual([
      { rule: "backup.stale", severity: "P1", detail: { reason: "missing" } },
    ]);
    const genuineId = uuidv7();
    await prisma.timer.create({
      data: {
        id: genuineId,
        kind: "backup.pgdump",
        fireAt: new Date(at.getTime() - BACKUP_STALE_MS),
        dedupeKey: `lyxtest:genuine:${genuineId}`,
        status: "fired",
        firedAt: new Date(at.getTime() - BACKUP_STALE_MS),
        result,
      },
    });
    expect(await sample(at)).toEqual([]);
    expect(await sample(new Date(at.getTime() + 1))).toEqual([
      { rule: "backup.stale", severity: "P1", detail: { ageSeconds: 26 * 3600 } },
    ]);
    await prisma.timer.update({
      where: { id: businessId },
      data: { kind: "ops.cert_check", subjectType: null, subjectId: null },
    });
    expect(await sample(at)).toEqual([]);
    for (const corrupt of [{}, { ...result, status: "succeeded" }]) {
      await prisma.timer.update({ where: { id: genuineId }, data: { result: corrupt } });
      await expect(sample(at)).rejects.toThrow("备份成功事实无法验证");
    }
    await prisma.timer.update({
      where: { id: genuineId },
      data: { result, firedAt: new Date(at.getTime() + 1) },
    });
    await expect(sample(at)).rejects.toThrow("备份成功事实无法验证");
    expect(await prisma.timer.count()).toBe(3);
    expect(await prisma.alertEvent.count()).toBe(0);
  });
});
