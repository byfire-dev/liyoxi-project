import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { createIdentityContext, createTxRunner, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { createInvitationExpiry, createTenant } from "../tenant/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";
import { createTimers } from "../timers/index.js";
import { createInvitationAssembly } from "./invitation-runtime.js";
import { runInvariants } from "./invariants/run.js";
import { selectChecks } from "./invariants/select.js";

const SLOW = 180_000,
  HOUR = 3_600_000;
const db = useSeededDatabase("services");
let prisma: Awaited<ReturnType<typeof db.prisma>>;
const scopes: ReturnType<typeof createInvitationAssembly>[] = [];
beforeAll(async () => {
  prisma = await db.prisma();
}, SLOW);
afterAll(() => {
  for (const scope of scopes) scope.close();
});
function runtime(clock = createClock(), runner?: TxRunner) {
  const scope = createInvitationAssembly(assembleForTest({ entry: "worker" }));
  scopes.push(scope);
  const assembly = scope.assembly,
    tx = runner ?? createTxRunner({ prisma, appEnv: "test" });
  const events = createEvents({ tx, clock, assembly });
  const flow = createFlow({ assembly, clock, events }),
    timers = createTimers({ assembly });
  const expiry = createInvitationExpiry({ clock, flow, timers });
  const tenant = createTenant({
    tx,
    clock,
    assembly,
    flow,
    events,
    invitations: { keyring: () => TEST_KEYRING, timers, checkRemark: async () => {} },
  });
  return { scope, assembly, tx, clock, events, flow, timers, expiry, tenant };
}
async function world(one: ReturnType<typeof runtime>) {
  const user = await createFactories({ db: prisma, clock: one.clock }).merchantUser();
  const root = createIdentityContext({ actor: { type: "merchant", id: user.id, client: "weapp" } });
  const created = await one.tenant.createEntity(root);
  const ctx = createIdentityContext({
    actor: root.actor,
    entityId: created.entityId,
    storeId: created.storeId,
  });
  const card = await one.tenant.createInvitation(ctx, { clientRequestId: uuidv7() });
  one.clock.set(new Date(new Date(card.expiresAt).getTime() + HOUR + 1));
  return { ...created, card };
}
const run = (one: ReturnType<typeof runtime>, entityId: string, mode: "full" | "quick" = "full") =>
  runInvariants(one, { mode, trigger: "manual", codes: ["tenant.I30"], entityIds: [entityId] });
const state = () =>
  snapshotTables(prisma, [
    "invitation",
    "timer",
    "status_transition",
    "audit_log",
    "outbox_event",
    "invariant_violation",
  ]);

describe("I30：真实实例绑定与原不变量落库", { timeout: SLOW }, () => {
  it("full/P2/heal_and_alert无周期；array和索引绑定同对象，quick不运行", async () => {
    const one = runtime(),
      check = one.assembly.invariant("tenant.I30")!;
    expect(check).toBe(one.assembly.invariants.find((item) => item.code === "tenant.I30"));
    expect(check).toMatchObject({
      module: "tenant",
      severity: "P2",
      modes: ["full"],
      heal: "heal_and_alert",
    });
    expect(check.every).toBeUndefined();
    expect(
      selectChecks(one.assembly.invariants, {
        mode: "quick",
        trigger: "manual",
        codes: [check.code],
      }),
    ).toEqual([]);
    expect(
      selectChecks(one.assembly.invariants, {
        mode: "full",
        trigger: "schedule",
        scheduledFor: new Date("2026-10-13T03:11:00.000Z"),
        codes: [check.code],
      }),
    ).toEqual([check]);
    one.scope.attach(one.expiry);
    const w = await world(one),
      before = await state();
    expect(await run(one, w.entityId, "quick")).toMatchObject({
      status: "succeeded",
      checksRun: 0,
      violationsFound: 0,
    });
    expect(await state()).toEqual(before);
    await expect(one.tx.run((tx) => check.run!(tx, {}))).rejects.toThrow("第三个参数");
    await expect(
      one.tx.run((tx) => check.run!(tx, {}, { now: new Date(Number.NaN) })),
    ).rejects.toThrow("有效业务时间");
  });

  it("缺失/重复I30拒绝，base未绑定及scoped未attach/关闭明确失败", async () => {
    const base = assembleForTest({ entry: "worker" }),
      tx = createTxRunner({ prisma, appEnv: "test" });
    const check = base.invariant("tenant.I30")!;
    expect(() =>
      createInvitationAssembly({
        ...base,
        invariants: base.invariants.filter((item) => item.code !== check.code),
      }),
    ).toThrow("唯一I30");
    expect(() =>
      createInvitationAssembly({ ...base, invariants: [...base.invariants, check] }),
    ).toThrow("唯一I30");
    await expect(
      tx.run((handle) => check.run!(handle, {}, { now: createClock().now() })),
    ).rejects.toThrow("运行时绑定");
    const one = runtime(),
      w = await world(one);
    expect(await run(one, w.entityId)).toMatchObject({
      status: "failed",
      checksRun: 0,
      errors: [{ code: "tenant.I30", message: expect.stringContaining("尚未绑定") }],
    });
    one.scope.attach(one.expiry);
    expect(() => one.scope.attach(one.expiry)).toThrow("只能绑定一次");
    one.scope.close();
    one.scope.close();
    expect(await run(one, w.entityId)).toMatchObject({
      status: "failed",
      errors: [{ code: "tenant.I30", message: expect.stringContaining("已经关闭") }],
    });
  });

  it("真实runInvariants同事务healed，保留未解决警报且二次不重复", async () => {
    const one = runtime();
    one.scope.attach(one.expiry);
    const w = await world(one),
      at = one.clock.now();
    const first = await run(one, w.entityId);
    expect(first).toMatchObject({
      status: "succeeded",
      checksRun: 1,
      violationsFound: 1,
      created: 1,
      autoClosed: 0,
      errors: [],
    });
    const rows = await prisma.invariantViolation.findMany({
      where: { code: "tenant.I30", subjectId: w.card.invitationId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      invariantRunId: first.runId,
      module: "tenant",
      severity: "P2",
      subjectType: "invitation",
      autoHealedAt: at,
      resolvedAt: null,
      detail: {
        expiresAt: w.card.expiresAt,
        entityId: w.entityId,
        healed: { action: "invitation.expire", at: at.toISOString() },
      },
    });
    expect(
      (await prisma.invitation.findUniqueOrThrow({ where: { id: w.card.invitationId } })).status,
    ).toBe("expired");
    expect(
      await prisma.timer.count({ where: { subjectId: w.card.invitationId, status: "cancelled" } }),
    ).toBe(1);
    const before = await state();
    expect(await run(one, w.entityId)).toMatchObject({
      status: "succeeded",
      violationsFound: 0,
      created: 0,
      autoClosed: 0,
    });
    expect(await state()).toEqual(before);
    expect(
      (await prisma.invariantViolation.findUniqueOrThrow({ where: { id: rows[0]!.id } }))
        .resolvedAt,
    ).toBeNull();
  });

  it("实例各用本身clock/flow，关闭另一实例不改变本实例", async () => {
    const first = runtime(),
      second = runtime();
    first.scope.attach(first.expiry);
    second.scope.attach(second.expiry);
    const w = await world(first);
    second.clock.set(new Date(new Date(w.card.expiresAt).getTime() + HOUR));
    expect(await run(second, w.entityId)).toMatchObject({ violationsFound: 0 });
    second.scope.close();
    expect(await run(first, w.entityId)).toMatchObject({ status: "succeeded", violationsFound: 1 });
    expect(
      await prisma.statusTransition.count({
        where: {
          subjectId: w.card.invitationId,
          event: "invitation.expire",
          occurredAt: first.clock.now(),
        },
      }),
    ).toBe(1);
  });

  it.each(["event", "violation"] as const)(
    "真实%s写入后抛错整项回滚，下一轮可完整自愈",
    async (point) => {
      const one = runtime(),
        w = await world(one),
        before = await state();
      let fail = true;
      const events = {
        ...one.events,
        emit: async (...args: Parameters<typeof one.events.emit>) => {
          const result = await one.events.emit(...args);
          if (point === "event" && fail) throw new Error("事件写后回滚");
          return result;
        },
      };
      one.scope.attach(
        createInvitationExpiry({
          clock: one.clock,
          flow: createFlow({ assembly: one.assembly, clock: one.clock, events }),
          timers: one.timers,
        }),
      );
      const runner: TxRunner = {
        run: (fn, options) =>
          one.tx.run(async (tx) => {
            const result = await fn(tx);
            if (
              point === "violation" &&
              fail &&
              (await tx.invariantViolation.count({
                where: { code: "tenant.I30", subjectId: w.card.invitationId },
              }))
            )
              throw new Error("违规写后回滚");
            return result;
          }, options),
      };
      expect(await run({ ...one, tx: runner }, w.entityId)).toMatchObject({
        status: "failed",
        checksRun: 0,
        errors: [{ code: "tenant.I30", message: expect.stringContaining("回滚") }],
      });
      expect(await state()).toEqual(before);
      fail = false;
      expect(await run(one, w.entityId)).toMatchObject({
        status: "succeeded",
        violationsFound: 1,
        created: 1,
      });
      expect(
        await prisma.statusTransition.count({ where: { subjectId: w.card.invitationId } }),
      ).toBe(2);
      expect(await prisma.outboxEvent.count({ where: { aggregateId: w.card.invitationId } })).toBe(
        2,
      );
    },
  );
});
