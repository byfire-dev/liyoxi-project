import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { createOrderService } from "./index.js";
import { createIdempotencyContext, uuidv7 } from "../kernel/index.js";
import type { OrderCreateBody } from "@liyoxi/contract";
import { harness, buyer, drama, body, version, residual } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness, connections: PrismaClient[], others: Harness[];
const rounds = 20,
  n = 5,
  k = 3;
beforeAll(async () => {
  h = harness(await db.prisma());
  await version(h);
  const connectionString = await db.url();
  connections = Array.from({ length: n }, () => createPrismaClient({ connectionString, max: 1 }));
  others = connections.map((prisma) => harness(prisma, { clock: h.clock }));
}, 120000);
afterAll(async () => {
  await Promise.all(connections?.map((p) => p.$disconnect()) ?? []);
});
const idem = (who: Awaited<ReturnType<typeof buyer>>, input: OrderCreateBody, key = uuidv7()) =>
  createIdempotencyContext({
    mode: "required",
    scope: "m.order.create",
    actor: who.actor.ctx.actor,
    key,
    request: { method: "POST", body: input, storeId: who.store.id },
    redact: ["items[].posterUrl"],
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
describe("真实独立连接订购并发", { timeout: 300000 }, () => {
  it(`n=${n}>k=${k}，${rounds}轮恰k单成功、失败零订单/冻结/同意，不超扣`, async () => {
    const d = await drama(h, 2444);
    for (let round = 0; round < rounds; round++) {
      const b = await buyer(h),
        input = await body(h, b, [d.id]),
        aligned = fence(n);
      const results = await Promise.allSettled(
        others.map(async (other) => {
          await other.prisma.$queryRaw`SELECT pg_backend_pid()`;
          await aligned();
          return other.order.create(b.actor, input, { idem: idem(b, input) });
        }),
      );
      const success = results.filter((r) => r.status === "fulfilled"),
        failures = results.filter((r) => r.status === "rejected");
      expect(success).toHaveLength(k);
      expect(failures).toHaveLength(n - k);
      for (const f of failures)
        if (f.status === "rejected")
          expect(f.reason).toMatchObject({ error: "POINTS_INSUFFICIENT" });
      expect(await residual(h, b.entity.id)).toEqual({
        orders: k,
        items: k,
        holds: k,
        consents: k,
      });
      const sums = await h.prisma.pointHold.aggregate({
        where: { entityId: b.entity.id },
        _sum: { qty: true },
      });
      expect(sums._sum.qty).toBe(6600);
      expect(
        (
          await h.prisma.pointLot.aggregate({
            where: { entityId: b.entity.id },
            _sum: { availableQty: true, heldQty: true },
          })
        )._sum,
      ).toMatchObject({ availableQty: 0, heldQty: 6600 });
    }
  });
  it("同键两连接只建一张单，后到真实幂等结果poster null且不再冻结", async () => {
    const b = await buyer(h),
      d = await drama(h),
      input = await body(h, b, [d.id]),
      key = uuidv7(),
      aligned = fence(2);
    const [a, z] = await Promise.all(
      others.slice(0, 2).map(async (other) => {
        await other.prisma.$queryRaw`SELECT pg_backend_pid()`;
        await aligned();
        return other.order.create(b.actor, input, { idem: idem(b, input, key) });
      }),
    );
    expect(a!.orderId).toBe(z!.orderId);
    expect([a!.replayed, z!.replayed].sort()).toEqual([false, true]);
    expect([a, z].find((o) => o!.replayed)!.items.every((i) => i.posterUrl === null)).toBe(true);
    expect(await residual(h, b.entity.id)).toEqual({ orders: 1, items: 1, holds: 1, consents: 1 });
  });
  it("另一连接实际持有账户锁：3到4秒ACCOUNT_BUSY，未被业务单号等锁伪装", async () => {
    const b = await buyer(h),
      d = await drama(h),
      input = await body(h, b, [d.id]);
    let ready!: () => void, release!: () => void;
    const acquired = new Promise<void>((r) => {
        ready = r;
      }),
      released = new Promise<void>((r) => {
        release = r;
      });
    const blocker = others[0]!.tx.run(
      async (tx) => {
        await tx.$queryRaw`SELECT entity_id FROM billing_account WHERE entity_id=${b.entity.id}::uuid FOR UPDATE`;
        ready();
        await released;
      },
      { timeoutMs: 10000 },
    );
    await acquired;
    const start = performance.now();
    try {
      await expect(
        others[1]!.order.create(b.actor, input, { idem: idem(b, input) }),
      ).rejects.toMatchObject({ error: "ACCOUNT_BUSY" });
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(3000);
      expect(elapsed).toBeLessThan(4000);
      expect(await residual(h, b.entity.id)).toEqual({
        orders: 0,
        items: 0,
        holds: 0,
        consents: 0,
      });
    } finally {
      release();
      await blocker;
    }
  });
  it("实际账户锁等待跨零点：Tc旧日、Tf新日，业务行/初始历史/定时器来自hold", async () => {
    h.clock.set(new Date("2026-04-01T15:59:59.000Z"));
    const b = await buyer(h),
      d = await drama(h),
      input = await body(h, b, [d.id]);
    let ready!: () => void, release!: () => void, entering!: () => void;
    const acquired = new Promise<void>((r) => {
        ready = r;
      }),
      released = new Promise<void>((r) => {
        release = r;
      }),
      entered = new Promise<void>((r) => {
        entering = r;
      });
    let blockerPid = 0,
      backendPid = 0;
    const blocker = others[0]!.tx.run(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
        blockerPid = row!.pid;
        await tx.$queryRaw`SELECT entity_id FROM billing_account WHERE entity_id=${b.entity.id}::uuid FOR UPDATE`;
        ready();
        await released;
      },
      { timeoutMs: 10000 },
    );
    await acquired;
    const deps = others[1]!.deps,
      real = deps.ledger.hold;
    const order = createOrderService({
      ...deps,
      ledger: {
        ...deps.ledger,
        hold: async (tx, arg) => {
          const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
          backendPid = row!.pid;
          entering();
          return real(tx, arg);
        },
      },
    });
    const pending = order.create(b.actor, input, { idem: idem(b, input) });
    try {
      await entered;
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [state] = await h.prisma.$queryRaw<
          { waiting: boolean }[]
        >`SELECT ${blockerPid}::int = ANY(pg_blocking_pids(${backendPid}::int)) AS waiting`;
        if (state?.waiting) {
          waiting = true;
          break;
        }
        await new Promise<void>((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true); // 后端实际已抵达账户锁，不能用序列排队或只拨时钟冒充。
      h.clock.advance(2000);
      release();
      await blocker;
      const out = await pending;
      expect(out.agreements[0]!.consentedAt).toBe("2026-04-01T15:59:59.000Z");
      expect(out.submittedAt).toBe("2026-04-01T16:00:01.000Z");
      const ids = [out.orderId, ...out.items.map((i) => i.orderItemId)];
      const histories = await h.prisma.statusTransition.findMany({
        where: { subjectId: { in: ids } },
      });
      expect(histories.every((r) => r.occurredAt.toISOString() === out.submittedAt)).toBe(true);
      const timer = await h.prisma.timer.findFirstOrThrow({ where: { subjectId: out.orderId } });
      expect(timer.status).toBe("scheduled");
      expect(timer.fireAt.getTime()).toBeGreaterThanOrEqual(new Date(out.submittedAt).getTime());
      const hold = await h.prisma.pointHold.findFirstOrThrow({
        where: { entityId: b.entity.id, refType: "order_item" },
      });
      expect(hold.heldAt.toISOString()).toBe(out.submittedAt);
    } finally {
      release();
      await blocker;
      await pending.catch(() => {});
      h.clock.set(new Date("2026-01-05T04:00:00Z"));
    }
  });
});
