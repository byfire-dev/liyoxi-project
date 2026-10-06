import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runUntilCrash, useSeededDatabase } from "../testing/index.js";
import { runTimer } from "../timers/index.js";
import { startHarness, startSnapshot } from "./__fixtures__/start-harness.js";
import type { StartHarness } from "./__fixtures__/start-harness.js";

const db = useSeededDatabase("services");
let h: StartHarness;
beforeAll(async () => {
  h = startHarness(await db.prisma());
}, 120000);
afterAll(() => h?.clear());
async function dispatch(id: string) {
  const timer = await h.prisma.timer.findFirstOrThrow({
    where: { subjectId: id, kind: "order.start" },
  });
  await h.prisma.timer.update({
    where: { id: timer.id },
    data: {
      status: "dispatched",
      dispatchNo: 1,
      leaseUntil: new Date(h.clock.now().getTime() + 300000),
    },
  });
  return { timerId: timer.id, kind: "order.start", dispatchNo: 1 };
}
const timing = () => ({
  ...h.deps,
  registry: h.deps.timers.registry,
  alerts: { raise: async () => {} },
});
describe("真实定时器重复与进程中断", { timeout: 120000 }, () => {
  it("同一条消息再送达是stale，资金/工单/审计/历史/事件均不再写", async () => {
    const p = await h.pending({ count: 2 }),
      ref = await dispatch(p.id);
    expect(await runTimer(timing(), ref)).toBe("fired");
    const before = await startSnapshot(h, p.b.entity.id);
    expect(await runTimer(timing(), ref)).toBe("stale");
    expect(await startSnapshot(h, p.b.entity.id)).toEqual(before);
  });
  it("真实capture后SIGKILL：另一连接看不到未提交写，整笔回滚，同一消息重试只扣/建一次", async () => {
    const p = await h.pending({ count: 2 }),
      ref = await dispatch(p.id),
      before = await startSnapshot(h, p.b.entity.id);
    const crash = await runUntilCrash({
      module: new URL("./__fixtures__/start-crash.ts", import.meta.url),
      crashAt: "capture-complete",
      payload: {
        databaseUrl: await db.url(),
        now: h.clock.now().toISOString(),
        timerId: ref.timerId,
      },
      onReach: async () => {
        expect(await startSnapshot(h, p.b.entity.id)).toEqual(before);
      },
      timeoutMs: 60000,
    });
    expect(crash, crash.output).toMatchObject({
      killed: true,
      signal: "SIGKILL",
      reached: ["capture-complete"],
    });
    expect(await startSnapshot(h, p.b.entity.id)).toEqual(before);
    expect(await h.prisma.timer.findUnique({ where: { id: ref.timerId } })).toMatchObject({
      status: "dispatched",
      dispatchNo: 1,
    });
    expect(await runTimer(timing(), ref)).toBe("fired");
    for (const item of p.items) {
      expect(
        await h.prisma.ledgerOperation.count({
          where: { opKey: `capture:point_hold:${item.pointHoldId}` },
        }),
      ).toBe(1);
      expect(await h.prisma.deliveryTicket.count({ where: { orderItemId: item.id } })).toBe(1);
    }
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: p.id, eventType: "order.started" },
      }),
    ).toBe(1);
    const after = await startSnapshot(h, p.b.entity.id);
    expect(await runTimer(timing(), ref)).toBe("stale");
    expect(await startSnapshot(h, p.b.entity.id)).toEqual(after);
  });
});
