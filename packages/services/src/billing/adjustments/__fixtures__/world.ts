// W4-08本域私有支架：真实付款、审批装配与账本，只有初始身份/字典是测试输入。
import type { PrismaClient } from "@liyoxi/db";
import type {
  StaffRoleKey,
  PointAdjustmentRequestCreateBody,
  TermExtensionRequestCreateBody,
} from "@liyoxi/contract";
import { createApproval } from "../../../approval/index.js";
import { createFlow } from "../../../flow/index.js";
import { createBizNoIssuer, uuidv7 } from "../../../kernel/index.js";
import {
  applyReceipt,
  assembleForTest,
  createLedgerHarness,
  pendingPlanOrder,
  transferReceipt,
  createPaymentHarness,
  billingAdjustmentPortsForTest,
  sampleStaffContext,
  sampleStaffIdentity,
} from "../../../testing/index.js";
import type { LedgerHarnessOptions } from "../../../testing/index.js";
import { createBillingAccounts } from "../../read/account-ledger.js";
import { createAdjustmentAssembly, createBillingAdjustments } from "../index.js";
import type { AdjustmentActor } from "../index.js";

export const tables = [
  "approval_request",
  "point_adjustment_request",
  "term_extension_request",
  "subscription_term",
  "subscription_event",
  "grant_schedule",
  "billing_account",
  "point_lot",
  "ledger_operation",
  "point_ledger_entry",
  "point_hold",
  "point_hold_alloc",
  "status_transition",
  "audit_log",
  "outbox_event",
  "service_ticket_ref",
];
export const ledgerTables = [
  "subscription_term",
  "subscription_event",
  "grant_schedule",
  "billing_account",
  "point_lot",
  "ledger_operation",
  "point_ledger_entry",
];
export async function world(prisma: PrismaClient) {
  const h = createPaymentHarness(prisma),
    scope = createAdjustmentAssembly(assembleForTest({ entry: "api" }));
  const flow = createFlow({ assembly: scope.assembly, clock: h.clock, events: h.events });
  const approval = createApproval({
    assembly: scope.assembly,
    clock: h.clock,
    flow,
    events: h.events,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
  });
  const deps = {
    tx: h.tx,
    clock: h.clock,
    events: h.events,
    ledger: h.ledger,
    approval,
    ...billingAdjustmentPortsForTest(h.clock),
  };
  scope.attach(deps);
  const svc = createBillingAdjustments(deps),
    accounts = createBillingAccounts(deps);
  await prisma.dictItem.create({
    data: {
      id: uuidv7(),
      dictTypeKey: "extend_reason",
      code: "EX001",
      name: "制作延期补偿",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  async function actor(
    roleKey: StaffRoleKey = "super_admin",
    groupId: string | null = null,
    isLead = false,
  ): Promise<AdjustmentActor> {
    const staff = await h.make.staff({ staffRoleKey: roleKey, staffGroupId: groupId, isLead });
    return reload(staff.id);
  }
  async function reload(id: string, fresh = true): Promise<AdjustmentActor> {
    return {
      identity: sampleStaffIdentity(id),
      staff: await sampleStaffContext(prisma, id, { stepUpAt: fresh ? h.clock.now() : null }),
    };
  }
  async function subscribed(months = 1) {
    const who = await h.make.merchant({ verified: true });
    const order = await pendingPlanOrder(h, { entityId: who.entity.id, months });
    const receipt = await transferReceipt(h, order);
    await applyReceipt(h, receipt);
    const term = await prisma.subscriptionTerm.findUniqueOrThrow({
      where: { sourceBillingOrderId: order.id },
    });
    return { ...who, entityId: who.entity.id, storeId: who.store.id, term, order, receipt };
  }
  async function adjustmentInput(
    entityId: string,
    input: Partial<Omit<PointAdjustmentRequestCreateBody, "pointAccountId" | "confirm">> = {},
  ): Promise<PointAdjustmentRequestCreateBody> {
    const body = {
      direction: "increase" as const,
      lotKind: "plan" as const,
      adjustPoints: 100,
      reasonCode: "compensation" as const,
      note: "制作延期真实补偿",
      ...input,
    };
    const quote = await svc.adjustmentQuote(await actor(), entityId, body);
    return {
      ...body,
      pointAccountId: entityId,
      confirm: { spendableBeforePoints: quote.spendableBeforePoints },
    };
  }
  const extensionInput = (
    term: Awaited<ReturnType<typeof subscribed>>["term"],
    days = 7,
  ): TermExtensionRequestCreateBody => ({
    subscriptionTermId: term.id,
    days,
    reasonCode: "EX001",
    note: "制作问题延长有效期",
    confirm: { subscriptionTermId: term.id, endDate: term.endDate.toISOString().slice(0, 10) },
  });
  async function group() {
    return (
      await prisma.staffGroup.create({
        data: {
          id: uuidv7(),
          name: `W408-${uuidv7()}`,
          staffRoleKey: "delivery_manager",
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      })
    ).id;
  }
  function faulty(onStep: NonNullable<LedgerHarnessOptions["onStep"]>) {
    const ledger = createLedgerHarness(prisma, { clock: h.clock, onStep }).ledger;
    const ownScope = createAdjustmentAssembly(assembleForTest({ entry: "api" }));
    const ownApproval = createApproval({
      assembly: ownScope.assembly,
      clock: h.clock,
      flow: createFlow({ assembly: ownScope.assembly, clock: h.clock, events: h.events }),
      events: h.events,
      bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
    });
    const ownDeps = { ...deps, ledger, approval: ownApproval };
    ownScope.attach(ownDeps);
    return { svc: createBillingAdjustments(ownDeps), close: ownScope.close };
  }
  return {
    ...h,
    svc,
    accounts,
    actor,
    reload,
    subscribed,
    adjustmentInput,
    extensionInput,
    group,
    faulty,
    close: scope.close,
  };
}
export type World = Awaited<ReturnType<typeof world>>;
export type PointDetail = Awaited<ReturnType<World["svc"]["points"]["create"]>>;
export type ExtensionDetail = Awaited<ReturnType<World["svc"]["extensions"]["create"]>>;
export const pointConfirm = (r: PointDetail) => ({
  lockVersion: r.approval.lockVersion,
  confirm: { requestNo: r.requestNo!, direction: r.direction, adjustPoints: r.adjustPoints },
  confirmChecks: ["basis_checked" as const],
});
export const extensionConfirm = (r: ExtensionDetail) => ({
  lockVersion: r.approval.lockVersion,
  confirm: { requestNo: r.requestNo!, days: r.days },
  confirmChecks: ["effect_preview_checked" as const],
});
