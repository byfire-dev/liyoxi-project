import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClock,
  createFakeProviders,
  assembleForTest,
  useSeededDatabase,
} from "../testing/index.js";
import { ok } from "../providers/types.js";
import type { TlsCertificateProbe } from "./cert.js";
import { buildWorkerServices } from "./worker.js";

const db = useSeededDatabase("services", { label: "cert" });
const workers: ReturnType<typeof buildWorkerServices>[] = [];
beforeEach(() => db.reset(), 60_000);
afterEach(async () => {
  for (const worker of workers.splice(0)) {
    await worker.closeCertificates?.();
    await worker.shutdownMediaJobs?.();
    await Promise.allSettled([
      worker.closeDocs(),
      worker.closeNotify(),
      worker.closeAnalytics?.(),
      worker.closeStaff?.(),
      worker.closeSmsHealth?.(),
      worker.closeModelBudget?.(),
      worker.documentConverter?.close(),
    ]);
    worker.closeWebhooks?.();
    worker.closeOrder?.();
    worker.closeBillingTimers?.();
    worker.closePublish?.();
    worker.closeDelivery?.();
    worker.closeMediaJobs?.();
    worker.closeProfile?.();
    worker.closeInvitations?.();
    worker.closeApproval?.();
    await Promise.allSettled([worker.closeStorageDrivers?.(), worker.closeMediaDrivers?.()]);
    await worker.closeAlertFacts?.();
  }
});
const clock = createClock(new Date("2026-10-13T01:00:00Z"));
async function build(domains: readonly string[], probe: TlsCertificateProbe) {
  const worker = buildWorkerServices({
    appEnv: "test",
    prisma: await db.prisma(),
    clock,
    assembly: assembleForTest({ entry: "worker" }),
    providers: createFakeProviders({ clock }),
    keys: { CERT_DOMAINS: domains },
    certificateProbe: probe,
    channel: {
      enqueue: async () => {
        throw new Error("此用例不入队");
      },
      downForMs: () => 0,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  workers.push(worker);
  return worker;
}
const reply = (days: number) =>
  ok({
    expiresAt: new Date(clock.now().getTime() + days * 86400000),
    validFrom: new Date(clock.now().getTime() - 86400000),
    trusted: true,
  });
const schedule = (day: number) => new Date(`2026-10-${day}T01:00:00Z`);

describe("证书每日任务实际worker装配与唯一告警writer", () => {
  it("每日09:00登记与索引一致；重复/旧期不重复计数，P1不降级，三个独立正常观测才恢复", async () => {
    let days = 6;
    const probe = vi.fn<TlsCertificateProbe>(async () => reply(days));
    const worker = await build(["api.example.invalid"], probe),
      prisma = await db.prisma();
    const job = worker.assembly.recurringJob("ops.cert_check")!;
    expect(job).toBe(worker.assembly.recurringJobs.find((item) => item.kind === "ops.cert_check"));
    expect(job).toMatchObject({
      schedule: { every: "day", at: "09:00" },
      mode: "job",
      missSeverity: "P3",
    });
    expect(await job.run({ scheduledFor: schedule(13) })).toMatchObject({
      status: "degraded",
      configured: true,
    });
    await job.run({ scheduledFor: schedule(13) });
    expect(await prisma.alertEvent.findFirstOrThrow()).toMatchObject({
      rule: "cert.expiry",
      fingerprint: "cert.expiry:api.example.invalid",
      kind: "probe",
      status: "open",
      severity: "P1",
      occurrences: 1,
      okStreak: 0,
    });
    days = 10;
    await job.run({ scheduledFor: schedule(14) });
    expect(await prisma.alertEvent.findFirstOrThrow()).toMatchObject({
      severity: "P1",
      occurrences: 2,
    });
    days = 30;
    await job.run({ scheduledFor: schedule(15) });
    await job.run({ scheduledFor: schedule(15) });
    await job.run({ scheduledFor: schedule(14) });
    expect(await prisma.alertEvent.findFirstOrThrow()).toMatchObject({
      okStreak: 1,
      status: "open",
    });
    await job.run({ scheduledFor: schedule(16) });
    expect(await prisma.alertEvent.findFirstOrThrow()).toMatchObject({
      okStreak: 2,
      status: "open",
    });
    await job.run({ scheduledFor: schedule(17) });
    expect(await prisma.alertEvent.findFirstOrThrow()).toMatchObject({
      okStreak: 3,
      status: "resolved",
      resolvedAt: clock.now(),
      notifyCount: 0,
    });
    days = 6;
    await job.run({ scheduledFor: schedule(14) });
    await job.run({ scheduledFor: schedule(17) });
    expect(await prisma.alertEvent.count()).toBe(1);
    expect(await prisma.alertEvent.findFirstOrThrow()).toMatchObject({
      okStreak: 3,
      status: "resolved",
    });
    days = 10;
    await job.run({ scheduledFor: schedule(18) });
    expect(await prisma.alertEvent.count()).toBe(2);
    expect(await prisma.alertEvent.findFirstOrThrow({ where: { status: "open" } })).toMatchObject({
      severity: "P2",
      occurrences: 1,
      okStreak: 0,
    });
  });
  it("两个worker证书闭包互不串用；关闭取消在途探测零迟到写，另一个缺配明记且零网络", async () => {
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const probe = vi.fn<TlsCertificateProbe>(
      (_domain, { signal }) =>
        new Promise((_, reject) => {
          entered();
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    const first = await build(["api.example.invalid"], probe),
      noNetwork = vi.fn<TlsCertificateProbe>();
    const second = await build([], noNetwork),
      prisma = await db.prisma();
    const one = first.assembly.recurringJob("ops.cert_check")!,
      two = second.assembly.recurringJob("ops.cert_check")!;
    expect(one).not.toBe(two);
    const active = one.run({ scheduledFor: schedule(13) });
    const stopped = expect(active).rejects.toThrow();
    await entry;
    const closing = first.closeCertificates!();
    expect(first.closeCertificates!()).toBe(closing);
    await closing;
    await stopped;
    expect(() => one.run({ scheduledFor: schedule(14) })).toThrow("已经关闭");
    expect(await prisma.alertEvent.count()).toBe(0);
    expect(await two.run({ scheduledFor: schedule(13) })).toEqual({
      status: "unconfigured",
      configured: false,
      domains: 0,
    });
    await two.run({ scheduledFor: schedule(13) });
    expect(noNetwork).not.toHaveBeenCalled();
    expect(await prisma.alertEvent.findFirstOrThrow()).toMatchObject({
      rule: "cert.unconfigured",
      kind: "event",
      severity: "P3",
      status: "open",
      occurrences: 1,
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
