import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLicenseConvergenceFixture,
  createFactories,
  sampleStaffContext,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { createIdentityContext, createTxRunner, lockRows } from "../kernel/index.js";
import type { Tx, TxRunner } from "../kernel/index.js";
import { reconcileLetters } from "./license-convergence.js";

const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
type Fixture = Awaited<ReturnType<typeof createLicenseConvergenceFixture>>;
const fixtures: Fixture[] = [],
  connections: PrismaClient[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of connections.splice(0)) await c.$disconnect();
  for (const f of fixtures.splice(0)) await f.close();
});
async function fresh() {
  const f = await createLicenseConvergenceFixture(await db.prisma(), {
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
  fixtures.push(f);
  await f.start();
  return f;
}
async function runner(): Promise<TxRunner> {
  const connection = createPrismaClient({ connectionString: await db.url(), max: 1 });
  connections.push(connection);
  return createTxRunner({ prisma: connection, appEnv: "test" });
}
const gate = () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
};
const pid = async (tx: Tx) =>
  (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0]!.pid;
async function blocked(waiter: number, blocker: number) {
  const prisma = await db.prisma();
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] = await prisma.$queryRaw<
      { waiting: boolean }[]
    >`SELECT ${blocker}::int=ANY(pg_blocking_pids(${waiter}::int)) AS waiting`;
    if (row?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("未观测到真实PostgreSQL锁屏障");
}
const rows = async (f: Fixture) =>
  (await db.prisma()).licenseLetter.findMany({
    where: { orderItemId: f.order.itemId },
    include: { revisions: true },
  });

describe("授权独立连接锁竞争", { timeout: 120000 }, () => {
  it("两路真实item锁排队，只各建双信/首版一次", async () => {
    const f = await fresh(),
      a = await runner(),
      b = await runner(),
      ready = gate(),
      release = gate(),
      entered = gate();
    let firstPid = 0,
      secondPid = 0;
    const first = a.run(async (tx) => {
      firstPid = await pid(tx);
      const result = await reconcileLetters(tx, f.licenseDeps, [f.order.itemId], "parallel:first");
      ready.release();
      await release.wait;
      return result;
    });
    await ready.wait;
    const second = b.run(async (tx) => {
      secondPid = await pid(tx);
      entered.release();
      return reconcileLetters(tx, f.licenseDeps, [f.order.itemId], "parallel:second");
    });
    const settled = Promise.allSettled([first, second]);
    try {
      await entered.wait;
      expect(firstPid).not.toBe(secondPid);
      await blocked(secondPid, firstPid);
    } finally {
      release.release();
    }
    const results = await settled;
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await first).toMatchObject({ created: 2 });
    expect(await second).toMatchObject({ created: 0, revised: 0, voided: 0 });
    const saved = await rows(f);
    expect(saved).toHaveLength(2);
    expect(saved.every((letter) => letter.revisions.length === 1)).toBe(true);
  });

  it("整个批次先持有两个item170，再在第一封letter240等待，没有逐项反向补锁", async () => {
    const f = await fresh(),
      other = await fresh();
    await f.runtime.tx.run((tx) =>
      reconcileLetters(tx, f.licenseDeps, [f.order.itemId, other.order.itemId], "batch:initial"),
    );
    const firstLetter = [...(await rows(f)), ...(await rows(other))].sort((a, b) =>
      a.id.localeCompare(b.id),
    )[0]!;
    const holder = await runner(),
      writer = await runner(),
      probe = await runner(),
      ready = gate(),
      release = gate(),
      entered = gate(),
      probeEntered = gate();
    let holderPid = 0,
      writerPid = 0,
      probePid = 0;
    const holding = holder.run(async (tx) => {
      holderPid = await pid(tx);
      await lockRows(tx, "license_letter", [firstLetter.id]);
      ready.release();
      await release.wait;
    });
    await ready.wait;
    const writing = writer.run(async (tx) => {
      writerPid = await pid(tx);
      entered.release();
      return reconcileLetters(
        tx,
        f.licenseDeps,
        [other.order.itemId, f.order.itemId],
        "batch:repeat",
      );
    });
    let probing: Promise<void> | undefined;
    const writingSettled = Promise.allSettled([holding, writing]);
    try {
      await entered.wait;
      await blocked(writerPid, holderPid);
      // If the writer locked only the first item, this independent probe would finish instead of waiting.
      probing = probe.run(async (tx) => {
        probePid = await pid(tx);
        probeEntered.release();
        await lockRows(tx, "order_item", [other.order.itemId]);
      });
      await probeEntered.wait;
      await blocked(probePid, writerPid);
    } finally {
      release.release();
      await writingSettled;
      await probing;
    }
    expect(await writing).toMatchObject({ created: 0, revised: 0, voided: 0 });
    expect((await rows(f)).every((letter) => letter.revisions.length === 1)).toBe(true);
    expect((await rows(other)).every((letter) => letter.revisions.length === 1)).toBe(true);
  });

  it("真实取消已写终态未提交时旧started对齐等待，提交后只作废、不复活、不新增版次", async () => {
    const f = await fresh();
    await f.runtime.tx.run((tx) =>
      reconcileLetters(tx, f.licenseDeps, [f.order.itemId], "cancel:initial"),
    );
    const prisma = await db.prisma(),
      make = createFactories({ db: prisma, clock: f.clock });
    const staffActor = async () => {
      const row = await make.staff({ staffRoleKey: "super_admin" });
      return {
        ctx: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
        staff: await sampleStaffContext(prisma, row.id, { stepUpAt: f.clock.now() }),
      };
    };
    const requester = await staffActor(),
      approver = await staffActor(),
      executor = await staffActor();
    const quote = await f.runtime.cancelRequests.quote(requester, f.order.id, {
      reasonCode: "merchant_request",
    });
    let request = await f.runtime.cancelRequests.create(requester, f.order.id, {
      reasonCode: "merchant_request",
      note: "授权竞争测试真实取消退款",
      expect: quote.expect,
    });
    request = await f.runtime.cancelRequests.approve(approver, request.cancelRequestId, {
      lockVersion: request.approval.lockVersion,
      confirm: { requestNo: request.requestNo, totalRefundPoints: request.totalRefundPoints },
      confirmChecks: ["stage_rule_amount_checked"],
    });
    const ready = gate(),
      release = gate(),
      entered = gate(),
      lateRunner = await runner(),
      original = f.runtime.events.emit;
    let cancelPid = 0,
      latePid = 0;
    vi.spyOn(f.runtime.events, "emit").mockImplementation(async (tx, ctx, event) => {
      if (event.type === "cancel.executed") {
        cancelPid = await pid(tx);
        ready.release();
        await release.wait;
      }
      return original(tx, ctx, event);
    });
    const cancelling = f.runtime.cancelRequests.execute(executor, request.cancelRequestId, {
      confirm: { requestNo: request.requestNo, totalRefundPoints: request.totalRefundPoints },
      confirmChecks: ["order_points_checked"],
    });
    const cancelSettled = Promise.allSettled([cancelling]);
    let late: ReturnType<typeof reconcileLetters> | undefined;
    try {
      await ready.wait;
      late = lateRunner.run(async (tx) => {
        latePid = await pid(tx);
        entered.release();
        return reconcileLetters(tx, f.licenseDeps, [f.order.itemId], "late:actual-started");
      });
      await entered.wait;
      await blocked(latePid, cancelPid);
    } finally {
      release.release();
      await cancelSettled;
    }
    expect((await cancelling).status).toBe("done");
    expect(await late).toMatchObject({ created: 0, revised: 0, voided: 2 });
    const saved = await rows(f);
    expect(saved).toHaveLength(2);
    expect(
      saved.every((letter) => letter.status === "voided" && letter.revisions.length === 1),
    ).toBe(true);
  });
});
