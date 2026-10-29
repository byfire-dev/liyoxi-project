import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createIdentityContext, createTxRunner, uuidv7 } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import {
  adminTransitionFixture,
  FORCE_EVENT,
  FORCE_NOTE,
  FORCE_REF,
  forceInput,
} from "./__fixtures__/admin-transition.js";
import type { ForceFixtureOptions } from "./__fixtures__/admin-transition.js";
import type { AdminTransitionInput } from "./transition.js";

const database = useSeededDatabase("services", { max: 1, label: "flowadmin" });
let prisma: PrismaClient;
let competitors: PrismaClient[] = [];
beforeAll(async () => {
  prisma = await database.prisma();
  const connectionString = await database.url();
  competitors = [
    createPrismaClient({ connectionString, max: 1 }),
    createPrismaClient({ connectionString, max: 1 }),
  ];
}, 60_000);
afterAll(async () => {
  await Promise.all(competitors.map((client) => client.$disconnect()));
});

async function setup(options: ForceFixtureOptions = {}) {
  const h = adminTransitionFixture(prisma, options);
  const actor = await h.actor();
  const ticket = await h.closedTicket(actor.employee.id);
  const input = forceInput(ticket);
  return { ...h, actor, ticket, input };
}

describe("flow.adminTransition：受控人工纠偏的真库事务", () => {
  it("白名单迁移、真实副作用、不变量、历史、ops审计与事件使用同一个事实", async () => {
    const h = await setup();
    const result = await h.tx.run((tx) =>
      h.flow.adminTransition(tx, h.actor.ctx, h.actor.staff, h.input),
    );
    expect(result).toMatchObject({ from: "closed", to: "processing", ref: FORCE_REF });
    expect(h.calls).toEqual(["guard", "effect", "invariants", "event"]);
    expect(
      await prisma.serviceTicket.findUniqueOrThrow({ where: { id: h.ticket.id } }),
    ).toMatchObject({
      status: "processing",
      closedAt: null,
      closeReason: null,
      closeNote: null,
      lockVersion: h.ticket.lockVersion + 1,
    });
    expect(
      await prisma.statusTransition.findMany({ where: { subjectId: h.ticket.id } }),
    ).toMatchObject([
      {
        id: result.id,
        machine: "service_ticket",
        stateField: "status",
        fromState: "closed",
        toState: "processing",
        event: "admin.force",
        isForced: true,
        note: FORCE_NOTE,
        actorType: "staff",
        actorId: h.actor.employee.id,
        requestId: h.actor.ctx.requestId,
      },
    ]);
    expect(await prisma.auditLog.findMany({ where: { targetId: h.ticket.id } })).toMatchObject([
      {
        id: result.auditId,
        stream: "ops",
        category: "system_ops",
        reasonCode: "manual_review",
        reasonText: FORCE_NOTE,
        actorId: h.actor.employee.id,
        requestId: h.actor.ctx.requestId,
      },
    ]);
    expect(
      await prisma.outboxEvent.findMany({ where: { aggregateId: h.ticket.id } }),
    ).toMatchObject([
      {
        id: result.eventId,
        eventType: FORCE_EVENT,
        aggregateType: "service_ticket",
        actorId: h.actor.employee.id,
        entityId: h.ticket.entityId,
        storeId: h.ticket.storeId,
        requestId: h.actor.ctx.requestId,
        payload: {
          v: 1,
          isForced: true,
          fromState: "closed",
          toState: "processing",
          transition: "admin.force",
        },
      },
    ]);
    expect(
      await prisma.serviceTicketEntry.findMany({ where: { serviceTicketId: h.ticket.id } }),
    ).toMatchObject([
      { kind: "system_event", tag: "status", body: FORCE_NOTE, actorId: h.actor.employee.id },
    ]);
  });

  it("普通transition仍拒绝admin.force，真实行与历史完全不变", async () => {
    const h = await setup();
    const before = await h.snapshot();
    await expect(
      h.tx.run((tx) =>
        h.flow.transition(tx, h.actor.ctx, {
          ...h.input,
          event: "admin.force",
        }),
      ),
    ).rejects.toMatchObject({ name: "FlowError", reason: "unknown_event" });
    expect(await h.snapshot()).toEqual(before);
  });

  it.each([
    ["没有权限", "permission", "PERMISSION_DENIED"],
    ["缺少再验证", "stepUp", "STEP_UP_REQUIRED"],
    ["再验证过期", "staleStepUp", "STEP_UP_REQUIRED"],
    ["身份与员工不一致", "identity", "PERMISSION_DENIED"],
    ["数据库员工已禁用", "disabled", "PERMISSION_DENIED"],
    ["数据库角色已变更", "roleChanged", "PERMISSION_DENIED"],
    ["数据库中没有员工", "missing", "PERMISSION_DENIED"],
  ] as const)("%s：在任何迁移写入之前拒绝", async (_name, mode, code) => {
    const h = await setup();
    let staff = h.actor.staff;
    let ctx = h.actor.ctx;
    if (mode === "permission") staff = { ...staff, permissions: new Set() };
    if (mode === "stepUp") staff = { ...staff, stepUpAt: null };
    if (mode === "staleStepUp")
      staff = { ...staff, stepUpAt: new Date(h.clock.now().getTime() - 600_001) };
    if (mode === "identity")
      ctx = createIdentityContext({ actor: { type: "staff", id: uuidv7(), client: "admin" } });
    if (mode === "disabled")
      await prisma.staff.update({
        where: { id: h.actor.employee.id },
        data: { status: "disabled", disabledAt: h.clock.now(), disabledReason: "other" },
      });
    if (mode === "roleChanged")
      await prisma.staff.update({
        where: { id: h.actor.employee.id },
        data: { staffRoleKey: "editor" },
      });
    if (mode === "missing") {
      const id = uuidv7();
      staff = { ...staff, staff: { ...staff.staff, id } };
      ctx = createIdentityContext({ actor: { type: "staff", id, client: "admin" } });
    }
    const before = await h.snapshot();
    await expect(
      h.tx.run((tx) => h.flow.adminTransition(tx, ctx, staff, h.input)),
    ).rejects.toMatchObject({ error: code });
    expect(h.calls).toEqual([]);
    expect(await h.snapshot()).toEqual(before);
  });

  it.each(["", "短原因", " ".repeat(10), "过".repeat(201)])(
    "trim后的原因长度不合法：%j",
    async (note) => {
      const h = await setup();
      const before = await h.snapshot();
      await expect(
        h.tx.run((tx) =>
          h.flow.adminTransition(tx, h.actor.ctx, h.actor.staff, { ...h.input, note }),
        ),
      ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
      expect(await h.snapshot()).toEqual(before);
    },
  );

  it("非白名单状态对与没有纠偏行的链均拒绝", async () => {
    const h = await setup();
    const before = await h.snapshot();
    await expect(
      h.tx.run((tx) =>
        h.flow.adminTransition(tx, h.actor.ctx, h.actor.staff, { ...h.input, to: "resolved" }),
      ),
    ).rejects.toMatchObject({ error: "CORRECTION_NOT_ALLOWED" });
    await expect(
      h.tx.run((tx) =>
        h.flow.adminTransition(tx, h.actor.ctx, h.actor.staff, {
          ...h.input,
          machine: "staff",
          stateField: "status",
          id: h.actor.employee.id,
          to: "active",
          audit: { ...h.input.audit, target: { type: "staff", id: h.actor.employee.id } },
        }),
      ),
    ).rejects.toMatchObject({ error: "CORRECTION_NOT_ALLOWED" });
    expect(await h.snapshot()).toEqual(before);
  });

  it("已登记守卫查询真实owner后拒绝：不运行副作用", async () => {
    const h = await setup();
    const other = await h.make.staff({ staffRoleKey: "super_admin" });
    await prisma.serviceTicket.update({
      where: { id: h.ticket.id },
      data: { ownerStaffId: other.id },
    });
    const before = await h.snapshot();
    await expect(
      h.tx.run((tx) => h.flow.adminTransition(tx, h.actor.ctx, h.actor.staff, h.input)),
    ).rejects.toMatchObject({ error: "CORRECTION_NOT_ALLOWED" });
    expect(h.calls).toEqual(["guard"]);
    expect(await h.snapshot()).toEqual(before);
  });

  it.each(["guard", "effect", "invariants", "staffReader"] as const)(
    "缺少%s显式登记时不放行",
    async (omit) => {
      const before = await adminTransitionFixture(prisma).snapshot();
      await expect(
        (async () => {
          const h = await setup({ omit });
          await h.tx.run((tx) => h.flow.adminTransition(tx, h.actor.ctx, h.actor.staff, h.input));
        })(),
      ).rejects.toMatchObject({ name: "FlowError", reason: "binding" });
      // setup的造数不是用例事务的一部分；无论构造时还是调用时拒绝，均不得落下迁移事实。
      const after = await adminTransitionFixture(prisma).snapshot();
      for (const table of [
        "status_transition",
        "audit_log",
        "outbox_event",
        "service_ticket_entry",
        "timer",
        "point_ledger_entry",
      ]) {
        expect(after[table]).toEqual(before[table]);
      }
    },
  );

  it("真实副作用遗漏导致结构不变量失败，状态、历史和所有追加行一起回滚", async () => {
    const h = await setup({ skipEntry: true });
    const before = await h.snapshot();
    await expect(
      h.tx.run((tx) => h.flow.adminTransition(tx, h.actor.ctx, h.actor.staff, h.input)),
    ).rejects.toMatchObject({
      error: "CORRECTION_NOT_ALLOWED",
      details: { failedInvariants: ["service_ticket.status_entry"] },
    });
    expect(h.calls).toEqual(["guard", "effect", "invariants"]);
    expect(await h.snapshot()).toEqual(before);
  });

  it("调用方在事务内catch结构不变量错误后提交，也不会留下局部迁移", async () => {
    const h = await setup({ skipEntry: true });
    const before = await h.snapshot();
    await h.tx.run(async (tx) => {
      await expect(
        h.flow.adminTransition(tx, h.actor.ctx, h.actor.staff, h.input),
      ).rejects.toMatchObject({
        error: "CORRECTION_NOT_ALLOWED",
        details: { failedInvariants: ["service_ticket.status_entry"] },
      });
      expect(
        await tx.serviceTicket.findUniqueOrThrow({ where: { id: h.ticket.id } }),
      ).toMatchObject({
        status: "closed",
        closedAt: h.ticket.closedAt,
        closeReason: h.ticket.closeReason,
        lockVersion: h.ticket.lockVersion,
      });
      expect(await tx.statusTransition.count({ where: { subjectId: h.ticket.id } })).toBe(0);
    });
    expect(h.calls).toEqual(["guard", "effect", "invariants"]);
    expect(await h.snapshot()).toEqual(before);
  });

  it.each([
    { failAfterEffect: true, calls: ["guard", "effect"], message: "after real force effect" },
    {
      failAfterEvent: true,
      calls: ["guard", "effect", "invariants", "event"],
      message: "after real force event",
    },
  ])("真实写入后注入故障也全部回滚：$message", async ({ calls, message, ...options }) => {
    const h = await setup(options);
    const before = await h.snapshot();
    await expect(
      h.tx.run((tx) => h.flow.adminTransition(tx, h.actor.ctx, h.actor.staff, h.input)),
    ).rejects.toThrow(message);
    expect(h.calls).toEqual(calls);
    expect(await h.snapshot()).toEqual(before);
  });

  it.each([
    { audit: undefined },
    {
      audit: {
        stream: "activity",
        category: "flow",
        action: "lyxtest.force.invalid",
        summary: "错误审计",
      },
    },
    { audit: { mergedInto: { approvalRequestId: uuidv7() } } },
    { emit: { none: true, primary: FORCE_EVENT } },
  ])("审计和出站事件不能省略或并入其他事实：%j", async (patch) => {
    const h = await setup();
    const before = await h.snapshot();
    await expect(
      h.tx.run((tx) =>
        h.flow.adminTransition(tx, h.actor.ctx, h.actor.staff, {
          ...h.input,
          ...patch,
        } as unknown as AdminTransitionInput),
      ),
    ).rejects.toMatchObject({ name: "FlowError" });
    expect(await h.snapshot()).toEqual(before);
  });

  it("合法ops审计混入mergedInto也必须在迁移前拒绝", async () => {
    const h = await setup();
    const audit = {
      ...h.input.audit,
      mergedInto: { approvalRequestId: uuidv7() },
    };
    // 结构类型允许变量带额外字段；入口仍须拒绝绕过独立审计的运行时标记。
    const input: AdminTransitionInput = { ...h.input, audit };
    const before = await h.snapshot();
    await expect(
      h.tx.run((tx) => h.flow.adminTransition(tx, h.actor.ctx, h.actor.staff, input)),
    ).rejects.toMatchObject({ name: "FlowError", reason: "audit_required" });
    expect(h.calls).toEqual([]);
    expect(await h.snapshot()).toEqual(before);
  });

  it("两个独立连接竞争相同纠偏目标，三轮均只提交一组历史、审计、事件与副作用", async () => {
    const runners = competitors.map((client) => createTxRunner({ prisma: client, appEnv: "test" }));
    for (let round = 0; round < 3; round += 1) {
      const h = await setup();
      const pids: number[] = [];
      let arrived = 0;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const outcomes = await Promise.allSettled(
        runners.map((runner) =>
          runner.run(async (tx) => {
            const rows = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
              "SELECT pg_backend_pid() AS pid",
            );
            pids.push(rows[0]!.pid);
            arrived += 1;
            if (arrived === 2) release();
            // 两边先开真实事务；同步点位于全部员工锁、对象锁之前。
            await ready;
            return h.flow.adminTransition(tx, h.actor.ctx, h.actor.staff, h.input);
          }),
        ),
      );
      expect(new Set(pids).size).toBe(2);
      const winners = outcomes.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value] : [],
      );
      const losers = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason as unknown] : [],
      );
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toMatchObject({ error: "CORRECTION_NOT_ALLOWED" });
      const winner = winners[0]!;
      expect(h.calls).toEqual(["guard", "effect", "invariants", "event"]);
      expect(
        await prisma.serviceTicket.findUniqueOrThrow({ where: { id: h.ticket.id } }),
      ).toMatchObject({
        status: "processing",
        lockVersion: h.ticket.lockVersion + 1,
      });
      expect(
        await prisma.statusTransition.findMany({ where: { subjectId: h.ticket.id } }),
      ).toMatchObject([
        {
          id: winner.id,
          fromState: "closed",
          toState: "processing",
          event: "admin.force",
          isForced: true,
        },
      ]);
      expect(await prisma.auditLog.findMany({ where: { targetId: h.ticket.id } })).toMatchObject([
        { id: winner.auditId, stream: "ops", category: "system_ops", reasonText: FORCE_NOTE },
      ]);
      expect(
        await prisma.outboxEvent.findMany({ where: { aggregateId: h.ticket.id } }),
      ).toMatchObject([
        {
          id: winner.eventId,
          eventType: FORCE_EVENT,
          payload: { isForced: true, fromState: "closed", toState: "processing" },
        },
      ]);
      expect(
        await prisma.serviceTicketEntry.findMany({ where: { serviceTicketId: h.ticket.id } }),
      ).toMatchObject([{ kind: "system_event", tag: "status", body: FORCE_NOTE }]);
    }
  }, 60_000);
});
