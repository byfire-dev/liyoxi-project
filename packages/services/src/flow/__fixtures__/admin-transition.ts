import type { StaffRoleKey } from "@liyoxi/contract/authz";
import type { PrismaClient } from "@liyoxi/db";
import { z } from "zod";

import { createEvents } from "../../events/index.js";
import type { Events } from "../../events/index.js";
import { createIdentityContext, createTxRunner, uuidv7 } from "../../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  fixedWorkMinutes,
  sampleFlowRegistration,
  sampleStaffContext,
  snapshotTables,
} from "../../testing/index.js";
import { chainKey, machinePort, rowKey } from "../bindings.js";
import type { Effect, Guard, MachineBinding } from "../bindings.js";
import { createFlow } from "../runtime.js";
import type { AdminStaffReader, AdminTransitionInput } from "../transition.js";

export const FORCE_REF = "12:162";
export const FORCE_EVENT = "lyxtest.flow.forced";
export const FORCE_NOTE = "人工复核确认这张工单需要重新处理";
const FORCE_KEY = rowKey(FORCE_REF, "admin.force");
const TABLES = [
  "staff",
  "service_ticket",
  "service_ticket_entry",
  "status_transition",
  "audit_log",
  "outbox_event",
  "outbox_delivery",
  "timer",
  "point_ledger_entry",
] as const;

export interface ForceFixtureOptions {
  readonly omit?: "guard" | "effect" | "invariants" | "staffReader";
  readonly skipEntry?: boolean;
  readonly failAfterEffect?: boolean;
  readonly failAfterEvent?: boolean;
}

/** 私有叶：只在真实白名单链上测试内核；不装配工单业务，也不访问账本。 */
export function adminTransitionFixture(prisma: PrismaClient, options: ForceFixtureOptions = {}) {
  const clock = createClock();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const make = createFactories({ db: prisma, clock });
  const calls: string[] = [];
  const guard: Guard = async (handle, facts) => {
    calls.push("guard");
    const ticket = await handle.serviceTicket.findUnique({ where: { id: facts.subjectId } });
    return (
      ticket !== null &&
      ticket.status === "closed" &&
      ticket.closedAt !== null &&
      ticket.closeReason !== null &&
      ticket.ownerStaffId === facts.ctx.actor.id &&
      ticket.entityId === facts.entityId &&
      ticket.storeId === facts.storeId
    );
  };
  const effect: Effect = async (handle, facts) => {
    calls.push("effect");
    const ticket = await handle.serviceTicket.findUniqueOrThrow({ where: { id: facts.subjectId } });
    if (!options.skipEntry) {
      await handle.serviceTicketEntry.create({
        data: {
          id: uuidv7(),
          serviceTicketId: ticket.id,
          entityId: ticket.entityId,
          storeId: ticket.storeId,
          kind: "system_event",
          tag: "status",
          actorType: "staff",
          actorId: facts.ctx.actor.id,
          client: "admin",
          body: facts.note,
          isVisibleToMerchant: false,
          createdAt: facts.now,
        },
      });
    }
    if (options.failAfterEffect) throw new Error("fictional failure after real force effect");
  };
  const checkInvariants: NonNullable<MachineBinding["adminTransition"]>["checkInvariants"] = async (
    handle,
    facts,
  ) => {
    calls.push("invariants");
    const ticket = await handle.serviceTicket.findUniqueOrThrow({ where: { id: facts.subjectId } });
    const count = await handle.serviceTicketEntry.count({
      where: { serviceTicketId: ticket.id, tag: "status", body: facts.note },
    });
    return [
      ...(ticket.status !== "processing" ||
      ticket.closedAt !== null ||
      ticket.closeReason !== null ||
      ticket.closeNote !== null
        ? ["service_ticket.closed_fields"]
        : []),
      ...(count !== 1 ? ["service_ticket.status_entry"] : []),
    ];
  };
  const binding: MachineBinding = {
    companions: ["closed_at", "close_reason", "close_note"],
    ...(options.omit === "guard" ? {} : { guards: { [FORCE_KEY]: guard } }),
    ...(options.omit === "effect" ? {} : { effects: { [FORCE_KEY]: effect } }),
    ...(options.omit === "invariants" ? {} : { adminTransition: { checkInvariants } }),
  };
  const assembly = assembleForTest({
    entry: "api",
    withoutRealPorts: [machinePort],
    extra: [
      sampleFlowRegistration({
        bindings: { [chainKey("service_ticket", "status")]: binding },
        workMinutes: fixedWorkMinutes,
      }),
    ],
  });
  const events = createEvents({
    assembly,
    clock,
    tx,
    testEvents: [
      {
        name: FORCE_EVENT,
        aggregates: ["service_ticket"],
        schema: z.strictObject({
          v: z.literal(1),
          isForced: z.literal(true),
          fromState: z.string(),
          toState: z.string(),
          transition: z.literal("admin.force"),
        }),
      },
    ],
  });
  const eventWriter: Pick<Events, "emit"> = {
    async emit(handle, ctx, input) {
      calls.push("event");
      const result = await events.emit(handle, ctx, input);
      if (options.failAfterEvent) throw new Error("fictional failure after real force event");
      return result;
    },
  };
  const adminStaffReader: AdminStaffReader = async (handle, id) => {
    const row = await handle.staff.findUnique({
      where: { id },
      select: { id: true, status: true, staffRoleKey: true, staffGroupId: true, isLead: true },
    });
    return row === null ? null : { ...row, roleKey: row.staffRoleKey };
  };
  const flow = createFlow({
    assembly,
    clock,
    events: eventWriter,
    ...(options.omit === "staffReader" ? {} : { adminStaffReader }),
  });

  return {
    prisma,
    clock,
    tx,
    flow,
    make,
    calls,
    snapshot: () => snapshotTables(prisma, TABLES),
    async actor(role: StaffRoleKey = "super_admin") {
      const employee = await make.staff({ staffRoleKey: role });
      return {
        employee,
        ctx: createIdentityContext({
          actor: { type: "staff", id: employee.id, client: "admin" },
          requestId: "req-admin-transition-test",
        }),
        staff: await sampleStaffContext(prisma, employee.id, { stepUpAt: clock.now() }),
      };
    },
    async closedTicket(ownerStaffId: string) {
      const store = await make.store();
      return prisma.serviceTicket.create({
        data: {
          id: uuidv7(),
          ticketNo: `KF-TEST-${uuidv7()}`,
          entityId: store.entityId,
          storeId: store.id,
          source: "phone",
          registeredByStaffId: ownerStaffId,
          ownerStaffId,
          typeCode: "K01",
          priority: "mid",
          description: "人工纠偏内核测试工单",
          status: "closed",
          closeReason: "invalid",
          closeNote: "测试初始已关闭工单",
          closedAt: clock.now(),
          solutionDueAt: new Date(clock.now().getTime() + 86_400_000),
          slaSnapshot: { solution: {} },
          createdAt: clock.now(),
          updatedAt: clock.now(),
        },
      });
    },
  };
}

export function forceInput(ticket: {
  id: string;
  entityId: string;
  storeId: string;
}): AdminTransitionInput {
  return {
    machine: "service_ticket",
    stateField: "status",
    id: ticket.id,
    to: "processing",
    note: `  ${FORCE_NOTE}  `,
    entityId: ticket.entityId,
    storeId: ticket.storeId,
    set: { closed_at: null, close_reason: null, close_note: null },
    audit: {
      stream: "ops",
      category: "system_ops",
      action: "lyxtest.service_ticket.force",
      summary: "样例：人工纠偏重新处理客服工单",
      target: { type: "service_ticket", id: ticket.id },
      reason: { code: "manual_review", text: "此值必须被统一纠偏原因覆盖" },
    },
    // 不能借由调用方的载荷伪装成普通迁移。
    emit: { type: FORCE_EVENT, payload: { v: 1, isForced: false } },
  };
}
