import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTxRunner } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { startOrder } from "./start.js";
import { executeCancel } from "./ad-cancel.js";
import { cancelHarness } from "./cancel-execute.fixture.js";
import type { CancelHarness } from "./cancel-execute.fixture.js";
const db = useSeededDatabase("services", { max: 1 });
let h: CancelHarness, clients: PrismaClient[], runners: TxRunner[];
beforeAll(async () => {
  h = cancelHarness(await db.prisma());
  const connectionString = await db.url();
  clients = Array.from({ length: 2 }, () => createPrismaClient({ connectionString, max: 1 }));
  runners = clients.map((prisma) => createTxRunner({ prisma, appEnv: "test" }));
}, 120000);
afterAll(async () => {
  await h?.close();
  await Promise.all(clients?.map((c) => c.$disconnect()) ?? []);
});
function fence() {
  let count = 0,
    open!: () => void;
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    if (++count === 2) open();
    await ready;
  };
}
describe("取消执行的两个真实客户端", { timeout: 180000 }, () => {
  it("3轮同申请并发执行，各明细只有一笔真实退回与一次终态事件", async () => {
    for (let round = 0; round < 3; round++) {
      const p = await h.atStage("pending_start", "merchant_request", 2),
        r = await h.request(p, p.quote, p.actor, await h.staff()),
        executor = await h.staff(),
        aligned = fence(),
        pids = new Set<number>();
      const values = await Promise.all(
        runners.map((runner) =>
          runner.run(async (tx) => {
            const [pid] = await tx.$queryRaw<
              { pid: number }[]
            >`SELECT pg_backend_pid()::int AS pid`;
            pids.add(pid!.pid);
            await aligned();
            return executeCancel(tx, h.cancelDeps, executor, r.id, {
              confirm: r.confirm,
              confirmChecks: ["order_points_checked"],
            });
          }),
        ),
      );
      expect(pids.size).toBe(2);
      expect(values.every((v) => v.status === "done")).toBe(true);
      for (const i of p.items)
        expect(
          await h.prisma.ledgerOperation.count({
            where: { pointHoldId: i.pointHoldId, opType: "release" },
          }),
        ).toBe(1);
      expect(
        await h.prisma.outboxEvent.count({
          where: { aggregateId: r.id, eventType: "cancel.executed" },
        }),
      ).toBe(1);
      expect(
        await h.prisma.statusTransition.count({
          where: { subjectId: r.id, event: "cancel.execute" },
        }),
      ).toBe(1);
    }
  });
  it("3轮开工与取消输入交错：实际最多扣一次、最多一工单，复核不容许旧release快照退已扣资金", async () => {
    for (let round = 0; round < 3; round++) {
      const p = await h.atStage("pending_start"),
        approver = await h.staff(),
        executor = await h.staff(),
        aligned = fence(),
        pids = new Set<number>();
      const txs: TxRunner[] = runners.map((runner) => ({
        run: (fn, options) =>
          runner.run(async (tx) => {
            const [pid] = await tx.$queryRaw<
              { pid: number }[]
            >`SELECT pg_backend_pid()::int AS pid`;
            pids.add(pid!.pid);
            await aligned();
            return fn(tx);
          }, options),
      }));
      const outcomes = await Promise.allSettled([
        txs[0]!.run((tx) => startOrder(tx, h.deps, p.out.orderId)),
        h.request(p, p.quote, p.actor, approver, txs[1]!),
      ]);
      expect(pids.size).toBe(2);
      const started = outcomes[0],
        submitted = outcomes[1];
      expect(started.status).toBe("fulfilled");
      expect(submitted.status).toBe("fulfilled");
      if (started.status !== "fulfilled" || submitted.status !== "fulfilled")
        throw new Error("missing start/cancel outcome");
      const captures = await h.prisma.ledgerOperation.count({
        where: { pointHoldId: p.items[0]!.pointHoldId, opType: "capture" },
      });
      const tickets = await h.prisma.deliveryTicket.count({
        where: { orderItemId: p.items[0]!.id },
      });
      expect(captures).toBe(started.value === "fired" ? 1 : 0);
      expect(tickets).toBe(captures);
      if (captures === 0)
        expect(await h.execute(executor, submitted.value)).toMatchObject({ status: "done" });
      else
        await expect(h.execute(executor, submitted.value)).rejects.toMatchObject({
          error: "PRECONDITION_CHANGED",
        });
      expect(
        await h.prisma.ledgerOperation.count({
          where: { pointHoldId: p.items[0]!.pointHoldId, opType: "capture" },
        }),
      ).toBe(captures);
      expect(await h.prisma.deliveryTicket.count({ where: { orderItemId: p.items[0]!.id } })).toBe(
        tickets,
      );
    }
  });
});
