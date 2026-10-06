import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { createTxRunner, lockRows, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { runTimer } from "../timers/index.js";
import { armOrderStart } from "./start-timer.js";
import { sweepPendingStarts } from "./sweep.js";
import { startHarness } from "./__fixtures__/start-harness.js";
import type { StartHarness } from "./__fixtures__/start-harness.js";

const db = useSeededDatabase("services");
let h: StartHarness, connections: PrismaClient[], runners: TxRunner[];
beforeAll(async () => {
  h = startHarness(await db.prisma());
  const connectionString = await db.url();
  connections = Array.from({ length: 3 }, () => createPrismaClient({ connectionString, max: 1 }));
  runners = connections.map((prisma) => createTxRunner({ prisma, appEnv: "test" }));
}, 120000);
afterAll(async () => {
  h?.clear();
  await Promise.all(connections?.map((p) => p.$disconnect()) ?? []);
});
function fence(count: number) {
  let arrived = 0,
    open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return async () => {
    if (++arrived === count) open();
    await wait;
  };
}
describe("三路开工真实独立连接", { timeout: 300000 }, () => {
  it("20轮：原定时器、补偿同键复活后再次执行、资质订阅者并发，每项只扣/建/迁移一次", async () => {
    for (let round = 0; round < 20; round++) {
      const p = await h.pending({ count: 2, gate: "parallel" });
      const armed = await h.tx.run(async (tx) => {
        await lockRows(tx, "drama_order", [p.id]);
        return armOrderStart(
          tx,
          h.deps,
          await tx.dramaOrder.findUniqueOrThrow({ where: { id: p.id } }),
        );
      });
      const timing = {
        ...h.deps,
        registry: h.deps.timers.registry,
        alerts: { raise: async () => {} },
      };
      await h.prisma.timer.update({
        where: { id: armed.id },
        data: {
          status: "dispatched",
          dispatchNo: 1,
          leaseUntil: new Date(h.clock.now().getTime() + 300000),
        },
      });
      expect(
        await runTimer(timing, { timerId: armed.id, kind: "order.start", dispatchNo: 1 }),
      ).toBe("skipped");
      await h.prisma.store.update({
        where: { id: p.b.store.id },
        data: { qualificationStatus: "verified" },
      });
      expect(await h.tx.run((tx) => sweepPendingStarts(tx, h.deps))).toEqual({ repaired: 1 });
      expect(await h.prisma.timer.findFirst({ where: { subjectId: p.id } })).toMatchObject({
        id: armed.id,
        status: "scheduled",
      });
      await h.prisma.timer.update({
        where: { id: armed.id },
        data: {
          status: "dispatched",
          dispatchNo: 2,
          leaseUntil: new Date(h.clock.now().getTime() + 300000),
        },
      });
      const aligned = fence(3),
        pids = new Set<number>();
      const txs: TxRunner[] = runners.map((runner) => ({
        run: (fn, options) =>
          runner.run(async (tx) => {
            const [row] = await tx.$queryRaw<
              { pid: number }[]
            >`SELECT pg_backend_pid()::int AS pid`;
            pids.add(row!.pid);
            await aligned();
            return fn(tx);
          }, options),
      }));
      const ref = { timerId: armed.id, kind: "order.start", dispatchNo: 2 };
      const event = {
        id: uuidv7(),
        type: "store.qualification.approved",
        payload: {
          v: 1,
          storeId: p.b.store.id,
          entityId: p.b.entity.id,
          submissionId: uuidv7(),
          kind: "initial",
        },
      };
      const results = await Promise.all([
        runTimer({ ...timing, tx: txs[0]! }, ref),
        runTimer({ ...timing, tx: txs[1]! }, ref),
        txs[2]!.run((tx) =>
          h.assembly.subscriber("order.onQualificationDecided")!.handle(tx, event),
        ),
      ]);
      expect(pids.size).toBe(3);
      expect(results.slice(0, 2).filter((r) => r === "fired")).toHaveLength(1);
      expect(
        results.slice(0, 2).every((r) => ["fired", "skipped", "stale"].includes(String(r))),
      ).toBe(true);
      for (const item of p.items) {
        expect(
          await h.prisma.ledgerOperation.count({
            where: { opKey: `capture:point_hold:${item.pointHoldId}` },
          }),
        ).toBe(1);
        expect(await h.prisma.deliveryTicket.count({ where: { orderItemId: item.id } })).toBe(1);
        expect(
          await h.prisma.statusTransition.count({
            where: { subjectId: item.id, event: "order.start" },
          }),
        ).toBe(1);
      }
      expect(
        await h.prisma.statusTransition.count({ where: { subjectId: p.id, event: "order.start" } }),
      ).toBe(1);
      expect(
        await h.prisma.outboxEvent.count({
          where: { aggregateId: p.id, eventType: "order.started" },
        }),
      ).toBe(1);
      expect(await h.prisma.deliveryPlan.count({ where: { dramaOrderId: p.id } })).toBe(1);
    }
  });
});
