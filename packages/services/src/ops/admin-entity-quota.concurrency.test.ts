import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { describe, expect, it } from "vitest";
import { createTxRunner, isAppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx, TxRunner } from "../kernel/index.js";
import type { Tenant } from "../tenant/index.js";
import { connectTestDatabase, snapshotTables, useSeededDatabase } from "../testing/index.js";
import { quotaCall, quotaHarness, SLOW } from "./__fixtures__/admin-entity-quota.js";
import type { QuotaHarness, QuotaWorld } from "./__fixtures__/admin-entity-quota.js";

const db = useSeededDatabase("services", { label: "quotarace" });
interface Scenario {
  h: QuotaHarness;
  clients: PrismaClient[];
  runners: TxRunner[];
  sides: Tenant[];
  pids: number[];
}
async function scenario(run: (s: Scenario) => Promise<void>) {
  const url = await db.url();
  const clients = [0, 1].map(() => createPrismaClient({ connectionString: url, max: 1 }));
  let h: QuotaHarness | undefined;
  try {
    h = await quotaHarness(clients[0]!);
    const runners = [h.tx, createTxRunner({ prisma: clients[1]!, appEnv: "test" })];
    const sides = runners.map((runner) => h!.service(runner));
    const pids = await Promise.all(
      clients.map(async (client) => {
        const [row] = await client.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        if (!row) throw new Error("业务连接缺少真实PID");
        return row.pid;
      }),
    );
    expect(new Set(pids).size).toBe(2);
    await run({ h, clients, runners, sides, pids });
  } finally {
    try {
      await h?.close();
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
function quotaPause(s: Scenario, w: QuotaWorld, version: number, failure?: Error) {
  return pause(
    s,
    async (tx) =>
      (
        await tx.entity.findUniqueOrThrow({
          where: { id: w.entityId },
          select: { lockVersion: true },
        })
      ).lockVersion ===
      version + 1,
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
  throw new Error("2秒内未观察到唯一两业务连接的实际锁阻塞");
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
        throw new Error("holder未进入真实事务尾栅栏");
      }),
    ]);
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
async function exactlyOne(s: Scenario, w: QuotaWorld, version: number, limit: number) {
  expect(await s.h.prisma.entity.findUniqueOrThrow({ where: { id: w.entityId } })).toMatchObject({
    lockVersion: version + 1,
    storeLimitOverride: limit,
  });
  expect(
    await s.h.prisma.auditLog.count({
      where: {
        entityId: w.entityId,
        action: "admin.entity.quota.update",
      },
    }),
  ).toBe(1);
  expect(
    await s.h.prisma.idempotencyRecord.count({
      where: {
        scope: "admin.entity.quota.update",
        actorKey: `staff:${w.staff.staff.id}`,
      },
    }),
  ).toBe(1);
}

describe("后台额度：两max1业务连接的真实等待和公开占位竞争", { timeout: SLOW }, () => {
  it.each(["same_version", "same_key", "holder_rollback"] as const)(
    "%s：完整事务唯一成功/收据，等待者在提交或回滚后重读",
    async (mode) =>
      scenario(async (s) => {
        const w = await s.h.world(),
          body = await s.h.input(w),
          key = uuidv7();
        const before = await snapshotTables(s.h.prisma, ["outbox_event", "status_transition"]);
        const failure = new Error("holder写和audit后真实回滚");
        const hold = quotaPause(
          s,
          w,
          body.lockVersion,
          mode === "holder_rollback" ? failure : undefined,
        );
        const [first, second] = await race(
          s,
          hold,
          (tenant) => quotaCall(tenant, w, body, key),
          (tenant) => quotaCall(tenant, w, body, mode === "same_key" ? key : uuidv7()),
        );
        if (mode === "holder_rollback")
          expect(first).toEqual({ status: "rejected", reason: failure });
        else expect(first.status).toBe("fulfilled");
        if (mode === "same_version") expect(code(second)).toBe("VERSION_CONFLICT");
        else expect(second.status).toBe("fulfilled");
        if (mode === "same_key") expect(second).toEqual(first);
        await exactlyOne(s, w, body.lockVersion, 4);
        expect(await snapshotTables(s.h.prisma, ["outbox_event", "status_transition"])).toEqual(
          before,
        );
        if (mode === "same_key" && first.status === "fulfilled") {
          const once = await s.h.state();
          expect(await quotaCall(s.sides[1]!, w, body, key)).toEqual(first.value);
          expect(await s.h.state()).toEqual(once);
        }
      }),
  );

  it("等待者携带新version和旧confirm，锁后精确CONFIRM_MISMATCH", async () =>
    scenario(async (s) => {
      const w = await s.h.world(),
        body = await s.h.input(w);
      const [first, second] = await race(
        s,
        quotaPause(s, w, body.lockVersion),
        (tenant) => quotaCall(tenant, w, body),
        (tenant) =>
          quotaCall(tenant, w, {
            ...body,
            lockVersion: body.lockVersion + 1,
            storeLimitOverride: 7,
          }),
      );
      expect(first.status).toBe("fulfilled");
      expect(code(second)).toBe("CONFIRM_MISMATCH");
      await exactlyOne(s, w, body.lockVersion, 4);
    }));

  it.each(["disabled", "role", "group", "lead"] as const)(
    "%s：真实staff20排他锁阻塞SHARE，提交前变更后fresh拒绝零额度写",
    async (change) =>
      scenario(async (s) => {
        const w = await s.h.world(),
          body = await s.h.input(w);
        const group =
          change === "group"
            ? await s.h.prisma.staffGroup.create({
                data: {
                  id: uuidv7(),
                  name: `额度锁组${uuidv7()}`,
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
          (tenant) => quotaCall(tenant, w, body),
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
  ] as const)("$lock锁等待跨$elapsed ms：fresh StepUp精确边界", async ({ lock, elapsed }) =>
    scenario(async (s) => {
      const w = await s.h.world(),
        body = await s.h.input(w),
        before = await s.h.state();
      const original = s.h.clock.now(),
        hold = pause(s, async () => true);
      try {
        const [first, second] = await race(
          s,
          hold,
          () =>
            hold.runner.run((tx) =>
              lockRows(tx, lock, [lock === "staff" ? w.staff.staff.id : w.entityId]),
            ),
          (tenant) => quotaCall(tenant, w, body),
          () => s.h.clock.set(new Date(original.getTime() + elapsed)),
        );
        expect(first.status).toBe("fulfilled");
        if (elapsed === 600_001) {
          expect(code(second)).toBe("STEP_UP_REQUIRED");
          expect(await s.h.state()).toEqual(before);
        } else {
          expect(second).toMatchObject({
            status: "fulfilled",
            value: { lockVersion: body.lockVersion + 1 },
          });
          await exactlyOne(s, w, body.lockVersion, 4);
        }
      } finally {
        s.h.clock.set(original);
      }
    }),
  );

  it.each([
    { producer: "create", first: "producer" },
    { producer: "create", first: "quota" },
    { producer: "restore", first: "producer" },
    { producer: "restore", first: "quota" },
  ] as const)("$producer/$first先提交：公开占位和下调共用entity100", async ({ producer, first }) =>
    scenario(async (s) => {
      const w = await s.h.world();
      await s.h.prisma.entity.update({
        where: { id: w.entityId },
        data: { storeLimitOverride: 3 },
      });
      await s.h.prisma.storeProfile.create({
        data: {
          storeId: w.storeId,
          entityId: w.entityId,
          brandName: "实际复制源品牌",
          businessHours: [],
          createdAt: s.h.clock.now(),
          updatedAt: s.h.clock.now(),
        },
      });
      const target = producer === "restore" ? await s.h.create(w) : null;
      if (target) await s.h.tenant.archiveStore(w.merchant, { storeId: target.storeId });
      const body = await s.h.input(w, { storeLimitOverride: 1 });
      const before = await snapshotTables(s.h.prisma, [
        "store",
        "store_profile",
        "store_service_item",
        "store_profile_media",
        "store_asset",
        "store_asset_file",
        "store_asset_tag",
        "file_ref",
        "file_object",
        "media_job",
      ]);
      const produce = (tenant: Tenant) =>
        target
          ? tenant.restoreStore(w.merchant, { storeId: target.storeId })
          : s.h.create(w, tenant, { copyFromStoreId: w.storeId, copyOptions: ["basic"] });
      const hold =
        first === "quota"
          ? quotaPause(s, w, body.lockVersion)
          : pause(s, async (tx) =>
              target
                ? (await tx.store.findUniqueOrThrow({ where: { id: target.storeId } }))
                    .lifecycle === "active"
                : (await tx.store.count({
                    where: { entityId: w.entityId, name: "公开额度分店" },
                  })) === 1,
            );
      const [winner, waiter] = await race(
        s,
        hold,
        first === "quota" ? (tenant) => quotaCall(tenant, w, body) : produce,
        first === "quota" ? produce : (tenant) => quotaCall(tenant, w, body),
      );
      expect(winner.status).toBe("fulfilled");
      if (first === "quota") {
        expect(code(waiter)).toBe("STORE_LIMIT_REACHED");
        expect(await snapshotTables(s.h.prisma, Object.keys(before))).toEqual(before);
      } else {
        expect(waiter.status).toBe("fulfilled");
        const rows = await s.h.prisma.store.findMany({
          where: { entityId: w.entityId, lifecycle: "active" },
        });
        expect(rows).toHaveLength(2);
        if (target) expect(rows.some((row) => row.id === target.storeId)).toBe(true);
        else {
          const copied = await s.h.prisma.storeProfile.findFirstOrThrow({
            where: {
              entityId: w.entityId,
              copiedFromStoreId: w.storeId,
            },
          });
          expect(copied.copyOptions).toEqual(["basic"]);
          expect(copied.brandName).toBe("实际复制源品牌");
        }
      }
      const card = await s.h.tenant.adminEntityGet(w.staff, w.entityId);
      expect(card.usage).toMatchObject({
        storeLimit: 1,
        storesUsed: first === "quota" ? 1 : 2,
        storesOver: first === "quota" ? 0 : 1,
        isOverLimit: first !== "quota",
      });
      await exactlyOne(s, w, body.lockVersion, 1);
    }),
  );
});
