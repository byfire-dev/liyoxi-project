import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createIdempotencyContext, createIdentityContext, uuidv7 } from "../kernel/index.js";
import {
  fullStaffWorld,
  sampleStaffContext,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import type { FullStaffWorld } from "../testing/index.js";

const db = useSeededDatabase("services", { label: "managerxfer", max: 3 });
let w: FullStaffWorld;
beforeAll(async () => {
  w = await fullStaffWorld(await db.prisma());
}, 120_000);
afterEach(() => vi.restoreAllMocks());
afterAll(() => w?.scope.close());
const tables = [
  "store",
  "drama_order",
  "delivery_ticket",
  "assignment_history",
  "timer",
  "audit_log",
  "outbox_event",
  "idempotency_record",
  "status_transition",
];
const snapshot = () => snapshotTables(w.prisma, tables);
const body = (fromStaffId: string, toStaffId: string) => ({
  toStaffId,
  reasonCode: "workload",
  note: "虚构门店经理交接",
  confirm: { fromStaffId },
});
function move(storeId: string, input: ReturnType<typeof body>, key = uuidv7(), ctx = w.ctx) {
  const actor = createIdentityContext({
    actor: { type: "staff", id: ctx.staff.id, client: "admin" },
  });
  return w.service.reassignStoreDeliveryManager(ctx, actor, storeId, input, {
    idem: createIdempotencyContext({
      mode: "required",
      scope: "admin.store.reassignDeliveryManager",
      key,
      actor: actor.actor,
      request: { method: "POST", pathParams: { storeId }, body: input, storeId: null },
    }),
  });
}
async function fixture(full = false) {
  const own = await w.make.merchant(),
    from = await w.person("delivery_manager", false),
    to = await w.person("delivery_manager", false),
    other = await w.person("delivery_manager", false);
  await w.prisma.store.update({
    where: { id: own.store.id },
    data: { deliveryManagerId: from.id },
  });
  const order = (managerId: string | null, status = "producing", storeId = own.store.id) =>
    w.make.dramaOrder({ entityId: own.entity.id, storeId, status, deliveryManagerId: managerId });
  async function ticket(managerId: string | null, step = "plan_confirm", storeId = own.store.id) {
    const row = await order(
      managerId,
      step === "archived" ? "ended" : step === "in_service" ? "live" : "producing",
      storeId,
    );
    const item = await w.make.orderItem({
      dramaOrderId: row.id,
      phase: step === "archived" ? "ended" : step === "in_service" ? "live" : "producing",
    });
    const delivery = await w.make.deliveryTicket({
      orderItemId: item.id,
      deliveryManagerId: managerId,
      step,
    });
    return { order: row, delivery };
  }
  const moving = [await ticket(from.id)],
    empty = await order(null, "pending_start");
  const stableOrders: string[] = [],
    stableTickets: string[] = [];
  if (full) {
    moving.push(await ticket(from.id, "in_service"));
    const sibling = await w.make.store({ entityId: own.entity.id, deliveryManagerId: from.id });
    for (const row of [
      await ticket(other.id),
      await ticket(to.id),
      await ticket(from.id, "archived"),
      await ticket(from.id, "plan_confirm", sibling.id),
      await ticket(null, "assigning"),
    ]) {
      stableTickets.push(row.delivery.id);
      // assigning工单仍不分配；其null订单另由拥有者补齐，因此不列为完全不动的订单。
      if (row.order.deliveryManagerId !== null) stableOrders.push(row.order.id);
    }
    stableOrders.push((await order(null, "cancelled")).id);
  }
  const now = w.clock.now(),
    due = new Date(now.getTime() + 3_600_000);
  const prior = await w.prisma.assignmentHistory.create({
    data: {
      id: uuidv7(),
      batchId: uuidv7(),
      source: "store_manager",
      subjectType: "store",
      subjectId: own.store.id,
      fromStaffId: other.id,
      toStaffId: from.id,
      reasonCode: "reassigned",
      actorType: "system",
      contactDueAt: due,
      slaSnapshot: {
        policy: "manager.first_contact",
        amount: 1,
        unit: "natural_hours",
        calendarVersion: 0,
        computedAt: now.toISOString(),
      },
      createdAt: now,
      updatedAt: now,
    },
  });
  await w.tx.run((tx) =>
    w.timers.arm(tx, {
      kind: "sla.breach",
      subject: { type: "assignment_history", id: prior.id },
      key: `sla.breach:assignment_history:${prior.id}`,
      fireAt: due,
      payload: { dueAt: due.toISOString() },
      entityId: own.entity.id,
      storeId: own.store.id,
    }),
  );
  return { ...own, from, to, other, moving, empty, stableOrders, stableTickets, prior };
}
async function stable(ids: { stableOrders: string[]; stableTickets: string[] }) {
  return {
    orders: await w.prisma.dramaOrder.findMany({
      where: { id: { in: ids.stableOrders } },
      orderBy: { id: "asc" },
    }),
    tickets: await w.prisma.deliveryTicket.findMany({
      where: { id: { in: ids.stableTickets } },
      orderBy: { id: "asc" },
    }),
  };
}
function gate() {
  let open!: () => void;
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { ready, open };
}

describe("W2-11单店经理转移三组真实DB风险", { timeout: 60_000 }, () => {
  it("仅本店旧经理未结事项非零移交；null订单补齐但不计数，旧联系作废、新SLA与同键回执各一次", async () => {
    const f = await fixture(true),
      input = body(f.from.id, f.to.id),
      key = uuidv7(),
      before = await stable(f);
    const result = await move(f.store.id, input, key);
    expect(result).toMatchObject({
      storeId: f.store.id,
      deliveryManager: { staffId: f.to.id },
      moved: { dramaOrderCount: 2, deliveryTicketCount: 2, serviceTicketCount: 0 },
      contact: {
        storeId: f.store.id,
        toStaff: { staffId: f.to.id },
        contactedAt: null,
        contactedBy: null,
      },
    });
    expect(new Date(result.contact.contactDueAt).getTime()).toBeGreaterThan(
      w.clock.now().getTime(),
    );
    expect(
      (await w.prisma.store.findUniqueOrThrow({ where: { id: f.store.id } })).deliveryManagerId,
    ).toBe(f.to.id);
    expect(
      (await w.prisma.dramaOrder.findUniqueOrThrow({ where: { id: f.empty.id } }))
        .deliveryManagerId,
    ).toBe(f.to.id);
    for (const item of f.moving) {
      expect(
        (await w.prisma.dramaOrder.findUniqueOrThrow({ where: { id: item.order.id } }))
          .deliveryManagerId,
      ).toBe(f.to.id);
      expect(
        (await w.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: item.delivery.id } }))
          .deliveryManagerId,
      ).toBe(f.to.id);
    }
    expect(await stable(f)).toEqual(before);
    const histories = await w.prisma.assignmentHistory.findMany({
      where: { batchId: result.batchId },
    });
    expect(histories).toHaveLength(5);
    expect(
      histories.every(
        (r) =>
          r.source === "store_manager" && r.fromStaffId === f.from.id && r.toStaffId === f.to.id,
      ),
    ).toBe(true);
    expect(histories.some((r) => r.subjectId === f.empty.id)).toBe(false);
    expect(
      await w.prisma.assignmentHistory.findUniqueOrThrow({ where: { id: f.prior.id } }),
    ).toMatchObject({ contactVoidedAt: w.clock.now() });
    expect(
      await w.prisma.timer.findFirstOrThrow({ where: { subjectId: f.prior.id } }),
    ).toMatchObject({ status: "cancelled" });
    expect(
      await w.prisma.timer.findFirstOrThrow({
        where: { subjectId: result.contact.assignmentHistoryId },
      }),
    ).toMatchObject({ status: "scheduled", fireAt: new Date(result.contact.contactDueAt) });
    expect(
      await w.prisma.outboxEvent.count({
        where: {
          eventType: "assignment.transferred",
          payload: { path: ["batchId"], equals: result.batchId },
        },
      }),
    ).toBe(1);
    expect(
      await w.prisma.auditLog.findFirstOrThrow({
        where: { targetId: f.store.id, action: "tenant.store.assign_manager" },
      }),
    ).toMatchObject({
      stream: "ops",
      category: "manager_assign",
      meta: { batchId: result.batchId, impact: result.moved },
    });
    const after = await snapshot();
    expect(await move(f.store.id, input, key)).toEqual(result);
    expect(await snapshot()).toEqual(after);
    await expect(move(f.store.id, input)).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    expect(await snapshot()).toEqual(after);
  });

  it("fresh主管/组/权限与目标状态准确；scope404、过期confirm和原同键在撤权后都零业务写拒绝", async () => {
    const own = await w.make.merchant(),
      from = await w.person("delivery_manager", false),
      to = await w.person("delivery_manager", false),
      lead = await w.person("delivery_manager", true),
      plain = await sampleStaffContext(w.prisma, from.id),
      leadCtx = await sampleStaffContext(w.prisma, lead.id);
    await w.prisma.store.update({
      where: { id: own.store.id },
      data: { deliveryManagerId: from.id },
    });
    const group = await w.prisma.staffGroup.create({
      data: {
        id: uuidv7(),
        staffRoleKey: "delivery_manager",
        name: "虚构独立交付组",
        isDefault: false,
        createdAt: w.clock.now(),
        updatedAt: w.clock.now(),
      },
    });
    const outsider = await w.make.staff({
        staffRoleKey: "delivery_manager",
        staffGroupId: group.id,
      }),
      inactive = await w.make.staff({
        staffRoleKey: "delivery_manager",
        status: "pending",
        staffGroupId: from.staffGroupId,
      }),
      wrongRole = await w.person("editor", false),
      foreign = await w.make.store({ entityId: own.entity.id, deliveryManagerId: outsider.id }),
      unassigned = await w.make.store({ entityId: own.entity.id });
    const before = await snapshot();
    await expect(move(own.store.id, body(from.id, to.id), uuidv7(), plain)).rejects.toMatchObject({
      error: "PERMISSION_DENIED",
    });
    await expect(
      move(foreign.id, body(outsider.id, to.id), uuidv7(), leadCtx),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    await expect(
      move(unassigned.id, body(from.id, to.id), uuidv7(), leadCtx),
    ).rejects.toMatchObject({ error: "STORE_MANAGER_UNASSIGNED" });
    const invalidTargets: readonly (readonly [string, string])[] = [
      [inactive.id, "not_active"],
      [wrongRole.id, "role_mismatch"],
      [from.id, "same_as_current"],
      [outsider.id, "out_of_scope"],
    ];
    for (const [staffId, reason] of invalidTargets)
      await expect(
        move(own.store.id, body(from.id, staffId), uuidv7(), leadCtx),
      ).rejects.toMatchObject({ error: "ASSIGNEE_INVALID", details: { staffId, reason } });
    await expect(
      move(own.store.id, body(outsider.id, to.id), uuidv7(), leadCtx),
    ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    expect(await snapshot()).toEqual(before);
    const input = body(from.id, to.id),
      key = uuidv7();
    await move(own.store.id, input, key, leadCtx);
    await w.prisma.staff.update({ where: { id: lead.id }, data: { isLead: false } });
    const settled = await snapshot();
    await expect(move(own.store.id, input, key, leadCtx)).rejects.toMatchObject({
      error: "PERMISSION_DENIED",
    });
    expect(await snapshot()).toEqual(settled);
  });

  it("真实事件失败使null补齐/旧联系/SLA/历史全部回滚；两连接同旧confirm只一个成功", async () => {
    const f = await fixture(),
      input = body(f.from.id, f.to.id),
      before = await snapshot(),
      boom = new Error("lyxtest manager transfer rollback");
    const emit = w.events.emit.bind(w.events);
    vi.spyOn(w.events, "emit").mockImplementation(async (...args) => {
      const result = await emit(...args);
      if (args[2].type === "assignment.transferred") throw boom;
      return result;
    });
    await expect(move(f.store.id, input)).rejects.toBe(boom);
    expect(await snapshot()).toEqual(before);
    vi.restoreAllMocks();
    const entered = gate(),
      release = gate(),
      source = w.deps.workSources;
    if (!source) throw new Error("真实在办来源未装配");
    const read = source.read.bind(source);
    let firstRead = true;
    vi.spyOn(source, "read").mockImplementation(async (...args) => {
      const items = await read(...args);
      if (firstRead) {
        firstRead = false;
        entered.open();
        await release.ready;
      }
      return items;
    });
    const first = move(f.store.id, input),
      firstDone = first.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    void first.catch(() => entered.open());
    await entered.ready;
    const second = move(f.store.id, body(f.from.id, f.other.id)),
      secondDone = second.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    let probeFailure: unknown;
    try {
      await vi.waitFor(
        async () => {
          const [row] = await w.prisma.$queryRaw<
            { n: number }[]
          >`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND a.datname=current_database()`;
          expect(row?.n).toBeGreaterThan(0);
        },
        { timeout: 2000, interval: 10 },
      );
    } catch (error) {
      probeFailure = error;
    } finally {
      release.open();
    }
    const [winner, loser] = await Promise.all([firstDone, secondDone]);
    if (probeFailure) throw probeFailure;
    expect(winner).toHaveProperty("value");
    expect(loser).toMatchObject({ error: { error: "CONFIRM_MISMATCH" } });
    expect(
      (await w.prisma.store.findUniqueOrThrow({ where: { id: f.store.id } })).deliveryManagerId,
    ).toBe(f.to.id);
    expect(
      await w.prisma.assignmentHistory.count({
        where: { subjectType: "store", subjectId: f.store.id },
      }),
    ).toBe(2);
    expect(
      await w.prisma.auditLog.count({
        where: { targetId: f.store.id, action: "tenant.store.assign_manager" },
      }),
    ).toBe(1);
  });
});
