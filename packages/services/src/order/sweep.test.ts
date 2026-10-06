import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { runTimer } from "../timers/index.js";
import { lockRows } from "../kernel/index.js";
import { armOrderStart } from "./start-timer.js";
import { sweepPendingStarts } from "./sweep.js";
import { startHarness, pendingCancel } from "./__fixtures__/start-harness.js";
import type { StartHarness } from "./__fixtures__/start-harness.js";
const db = useSeededDatabase("services");
let h: StartHarness;
beforeAll(async () => {
  h = startHarness(await db.prisma());
}, 120000);
afterAll(() => h?.clear());
describe("五分钟补偿与跳过复活", { timeout: 120000 }, () => {
  it("真实处理器gate跳过，同键arm复活后只开工一次；登记critical/rearmAfterSkip", async () => {
    const p = await h.pending({ gate: "parallel" });
    const row = await h.tx.run(async (tx) => {
      await lockRows(tx, "drama_order", [p.id]);
      return armOrderStart(
        tx,
        h.deps,
        await tx.dramaOrder.findUniqueOrThrow({ where: { id: p.id } }),
      );
    });
    await h.prisma.timer.update({
      where: { id: row.id },
      data: {
        status: "dispatched",
        dispatchNo: 1,
        leaseUntil: new Date(h.clock.now().getTime() + 300000),
      },
    });
    const timerDeps = {
        ...h.deps,
        registry: h.deps.timers.registry,
        alerts: { raise: async () => {} },
      },
      ref = { timerId: row.id, kind: "order.start", dispatchNo: 1 };
    expect(await runTimer(timerDeps, ref)).toBe("skipped");
    expect(await h.prisma.timer.findUnique({ where: { id: row.id } })).toMatchObject({
      status: "skipped",
    });
    expect(h.assembly.timerHandler("order.start")).toMatchObject({
      critical: true,
      rearmAfterSkip: true,
    });
    await h.prisma.store.update({
      where: { id: p.b.store.id },
      data: { qualificationStatus: "verified" },
    });
    expect(await h.tx.run((tx) => sweepPendingStarts(tx, h.deps))).toMatchObject({ repaired: 1 });
    expect(await h.prisma.timer.findUnique({ where: { id: row.id } })).toMatchObject({
      status: "scheduled",
    });
    await h.prisma.timer.update({
      where: { id: row.id },
      data: {
        status: "dispatched",
        dispatchNo: 2,
        leaseUntil: new Date(h.clock.now().getTime() + 300000),
      },
    });
    expect(await runTimer(timerDeps, { ...ref, dispatchNo: 2 })).toBe("fired");
    expect(await runTimer(timerDeps, ref)).toBe("stale");
    expect(await h.prisma.deliveryTicket.count({ where: { dramaOrderId: p.id } })).toBe(1);
  });
  it("无行/failed/skipped补登记或复活；scheduled/dispatched/在途取消/未通过不动，P3逐命中", async () => {
    const no = await h.pending(),
      failed = await h.pending(),
      skipped = await h.pending(),
      scheduled = await h.pending(),
      dispatched = await h.pending(),
      cancelled = await h.pending(),
      parallel = await h.pending({ gate: "parallel" });
    await h.prisma.timer.deleteMany({ where: { subjectId: no.id } });
    await h.prisma.timer.updateMany({
      where: { subjectId: failed.id },
      data: { status: "failed", attempts: 6, lastError: "测试失败" },
    });
    await h.prisma.timer.updateMany({
      where: { subjectId: skipped.id },
      data: { status: "skipped", firedAt: h.clock.now() },
    });
    await h.prisma.timer.updateMany({
      where: { subjectId: dispatched.id },
      data: {
        status: "dispatched",
        dispatchNo: 1,
        leaseUntil: new Date(h.clock.now().getTime() + 300000),
      },
    });
    await pendingCancel(h, cancelled);
    const preserved = await h.prisma.timer.findMany({
      where: { subjectId: { in: [scheduled.id, dispatched.id, cancelled.id] } },
      orderBy: { id: "asc" },
    });
    const before = h.alerts.length;
    expect(await h.tx.run((tx) => sweepPendingStarts(tx, h.deps))).toEqual({ repaired: 3 });
    expect(h.alerts.slice(before)).toHaveLength(3);
    expect(h.alerts.slice(before).every((a) => a.severity === "P3")).toBe(true);
    for (const p of [no, failed, skipped])
      expect(await h.prisma.timer.findFirst({ where: { subjectId: p.id } })).toMatchObject({
        status: "scheduled",
      });
    expect(
      await h.prisma.timer.findMany({
        where: { subjectId: { in: [scheduled.id, dispatched.id, cancelled.id] } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(preserved);
    expect(await h.prisma.timer.count({ where: { subjectId: parallel.id } })).toBe(0);
    expect(await h.tx.run((tx) => sweepPendingStarts(tx, h.deps))).toEqual({ repaired: 0 });
    expect(
      h.assembly.recurringJobs.find((j) => j.kind === "order.pending_start_sweep"),
    ).toMatchObject({ schedule: { every: "minutes", minutes: 5 }, mode: "tx", missSeverity: "P2" });
  });
});
