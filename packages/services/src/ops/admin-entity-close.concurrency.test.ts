import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { describe, expect, it } from "vitest";
import { createTxRunner, isAppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx, TxRunner } from "../kernel/index.js";
import type { Tenant } from "../tenant/index.js";
import { connectTestDatabase, useSeededDatabase } from "../testing/index.js";
import { closeCall, closeHarness, SLOW } from "./__fixtures__/admin-entity-close.js";
import type { CloseHarness, CloseWorld } from "./__fixtures__/admin-entity-close.js";

const db = useSeededDatabase("services", { label: "admincloserace" });
interface Scenario {
  h: CloseHarness;
  clients: PrismaClient[];
  runners: TxRunner[];
  sides: Tenant[];
  pids: number[];
}
async function scenario(run: (s: Scenario) => Promise<void>) {
  const url = await db.url();
  const clients = [0, 1].map(() => createPrismaClient({ connectionString: url, max: 1 }));
  let h: CloseHarness | undefined;
  try {
    h = closeHarness(clients[0]!);
    const runners = [h.tx, createTxRunner({ prisma: clients[1]!, appEnv: "test" })];
    const sides = runners.map((runner) => h!.service(runner));
    const pids = await Promise.all(
      clients.map(async (client) => {
        const [row] = await client.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        if (!row) throw new Error("关闭业务连接缺少真实PID");
        return row.pid;
      }),
    );
    expect(new Set(pids).size).toBe(2);
    await run({ h, clients, runners, sides, pids });
  } finally {
    try {
      h?.close();
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  }
}
function pause(
  s: Scenario,
  condition: (tx: Tx) => Promise<boolean>,
  afterGate?: (tx: Tx) => Promise<void>,
  failure?: Error,
) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner: TxRunner = {
    run: (fn, options) =>
      s.runners[0]!.run(async (tx) => {
        const result = await fn(tx);
        if (await condition(tx)) {
          enter();
          await gate;
          await afterGate?.(tx);
          if (failure) throw failure;
        }
        return result;
      }, options),
  };
  return { runner, service: s.h.service(runner), entered, release };
}
function closePause(s: Scenario, w: CloseWorld, failure?: Error) {
  return pause(
    s,
    async (tx) =>
      (await tx.entity.findUniqueOrThrow({ where: { id: w.entityId } })).lifecycle === "closed",
    undefined,
    failure,
  );
}
async function blocked(observer: Awaited<ReturnType<typeof connectTestDatabase>>, s: Scenario) {
  const until = Date.now() + 2_000;
  do {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
      [s.pids[1], s.pids[0]],
    );
    if (result.rows[0]?.blocked) {
      const all = await observer.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid() ORDER BY pid",
      );
      expect(all.rows.map((row) => row.pid)).toEqual([...s.pids].sort((a, b) => a - b));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < until);
  throw new Error("2秒内未观察到唯一两业务连接的关闭锁阻塞");
}
async function race(
  s: Scenario,
  hold: ReturnType<typeof pause>,
  firstAction: (service: Tenant) => Promise<unknown>,
  secondAction: (service: Tenant) => Promise<unknown>,
  whileHeld?: () => void,
) {
  const observer = await connectTestDatabase(db.name, { role: null });
  let first: Promise<PromiseSettledResult<unknown>[]> | undefined;
  let second: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await observer.query("SET default_transaction_read_only=on");
    first = Promise.allSettled([firstAction(hold.service)]);
    await Promise.race([
      hold.entered,
      first.then(() => {
        throw new Error("关闭holder未进入真实事务尾栅栏");
      }),
    ]);
    // second 的 preflight/required 均使用 side 1 独立max1，不借holder池排队伪装锁等待。
    second = Promise.allSettled([secondAction(s.sides[1]!)]);
    await blocked(observer, s);
    whileHeld?.();
    hold.release();
    return [(await first)[0]!, (await second)[0]!] as const;
  } finally {
    hold.release();
    await first;
    await second;
    await observer.end();
  }
}
function code(result: PromiseSettledResult<unknown>) {
  expect(result.status).toBe("rejected");
  const error: unknown = result.status === "rejected" ? result.reason : null;
  expect(isAppError(error)).toBe(true);
  return isAppError(error) ? error.error : null;
}
async function exactlyOne(s: Scenario, w: CloseWorld, version: number) {
  expect(await s.h.prisma.entity.findUniqueOrThrow({ where: { id: w.entityId } })).toMatchObject({
    lifecycle: "closed",
    lockVersion: version + 1,
  });
  expect(
    await s.h.prisma.store.count({ where: { entityId: w.entityId, lifecycle: "active" } }),
  ).toBe(0);
  expect(
    await s.h.prisma.entityMember.count({ where: { entityId: w.entityId, status: "active" } }),
  ).toBe(0);
  const history = await s.h.prisma.statusTransition.findMany({
    where: { entityId: w.entityId },
    orderBy: { seq: "asc" },
  });
  expect(history.map((row) => row.event)).toEqual([
    "entity.close",
    "entity_member.cascade_remove",
    "store.archive_by_entity",
  ]);
  const events = await s.h.prisma.outboxEvent.findMany({
    where: { entityId: w.entityId },
    orderBy: { seq: "asc" },
  });
  expect(events.map((row) => row.eventType)).toEqual([
    "entity.closed",
    "entity_member.removed",
    "store.archived",
  ]);
  const audits = await s.h.prisma.auditLog.findMany({ where: { entityId: w.entityId } });
  expect(audits).toHaveLength(3);
  expect(audits.filter((row) => row.action === "tenant.entity.close")).toHaveLength(1);
  expect(
    await s.h.prisma.idempotencyRecord.count({
      where: { scope: "admin.entity.close", actorKey: `staff:${w.staff.staff.id}` },
    }),
  ).toBe(1);
}

describe("后台关闭：两个max1真实公口竞争和readonly observer", { timeout: SLOW }, () => {
  it.each(["different_key", "same_key", "holder_rollback"] as const)(
    "%s：二十轮提交或回滚后重读，关闭/历史/事件/成功收据唯一",
    async (mode) =>
      scenario(async (s) => {
        for (let round = 0; round < 20; round++) {
          const w = await s.h.world(),
            body = await s.h.input(w),
            key = uuidv7();
          const entity = await s.h.prisma.entity.findUniqueOrThrow({ where: { id: w.entityId } });
          const failure = new Error(`第${round}轮关闭写闭包后回滚`);
          const hold = closePause(s, w, mode === "holder_rollback" ? failure : undefined);
          const [first, second] = await race(
            s,
            hold,
            (tenant) => closeCall(tenant, w, body, key),
            (tenant) => closeCall(tenant, w, body, mode === "same_key" ? key : uuidv7()),
          );
          if (mode === "holder_rollback")
            expect(first).toEqual({ status: "rejected", reason: failure });
          else expect(first.status).toBe("fulfilled");
          if (mode === "different_key") expect(code(second)).toBe("STATE_NOT_ALLOWED");
          else expect(second.status).toBe("fulfilled");
          if (mode === "same_key") expect(second).toEqual(first);
          const winner = mode === "holder_rollback" ? second : first;
          expect(winner).toMatchObject({
            status: "fulfilled",
            value: {
              entityId: w.entityId,
              lifecycle: "closed",
              owner: null,
              lockVersion: entity.lockVersion + 1,
              usage: { storesUsed: 0, activeMemberCount: 0 },
            },
          });
          await exactlyOne(s, w, entity.lockVersion);
          if (mode === "same_key" && first.status === "fulfilled") {
            const before = await s.h.state();
            expect(await closeCall(s.sides[1]!, w, body, key)).toEqual(first.value);
            expect(await s.h.state()).toEqual(before);
          }
        }
      }),
  );

  it.each(["disabled", "role", "group", "lead"] as const)(
    "%s：staff20排他锁真实阻塞SHARE，锁后当前员工变更拒绝且关闭零写",
    async (change) =>
      scenario(async (s) => {
        const w = await s.h.world(),
          body = await s.h.input(w);
        const group =
          change === "group"
            ? await s.h.prisma.staffGroup.create({
                data: {
                  id: uuidv7(),
                  name: `关闭锁组${uuidv7()}`,
                  staffRoleKey: "super_admin",
                  createdAt: s.h.clock.now(),
                  updatedAt: s.h.clock.now(),
                },
              })
            : null;
        const before = await s.h.state();
        const hold = pause(
          s,
          async () => true,
          async (tx) => {
            await tx.staff.update({
              where: { id: w.staff.staff.id },
              data:
                change === "disabled"
                  ? { status: "disabled", disabledAt: s.h.clock.now(), disabledReason: "other" }
                  : change === "role"
                    ? { staffRoleKey: "finance" }
                    : change === "group"
                      ? { staffGroupId: group!.id }
                      : { isLead: !w.staff.staff.isLead },
            });
          },
        );
        const [first, second] = await race(
          s,
          hold,
          () => hold.runner.run((tx) => lockRows(tx, "staff", [w.staff.staff.id])),
          (tenant) => closeCall(tenant, w, body),
        );
        expect(first.status).toBe("fulfilled");
        expect(code(second)).toBe("PERMISSION_DENIED");
        expect(await s.h.state()).toEqual(before);
      }),
  );

  it.each([
    { lock: "staff", elapsed: 600_000 },
    { lock: "staff", elapsed: 600_001 },
    { lock: "entity", elapsed: 600_000 },
    { lock: "entity", elapsed: 600_001 },
  ] as const)("$lock锁真实等待跨$elapsed ms：鲜时钟StepUp精确边界", async ({ lock, elapsed }) =>
    scenario(async (s) => {
      const w = await s.h.world(),
        body = await s.h.input(w),
        before = await s.h.state();
      const entity = await s.h.prisma.entity.findUniqueOrThrow({ where: { id: w.entityId } });
      const previous = s.h.clock.now(),
        hold = pause(s, async () => true);
      try {
        const [first, second] = await race(
          s,
          hold,
          () =>
            hold.runner.run((tx) =>
              lockRows(tx, lock, [lock === "staff" ? w.staff.staff.id : w.entityId]),
            ),
          (tenant) => closeCall(tenant, w, body),
          () => s.h.clock.set(new Date(previous.getTime() + elapsed)),
        );
        expect(first.status).toBe("fulfilled");
        if (elapsed === 600_001) {
          expect(code(second)).toBe("STEP_UP_REQUIRED");
          expect(await s.h.state()).toEqual(before);
        } else {
          expect(second).toMatchObject({ status: "fulfilled", value: { lifecycle: "closed" } });
          await exactlyOne(s, w, entity.lockVersion);
        }
      } finally {
        s.h.clock.set(previous);
      }
    }),
  );
});
