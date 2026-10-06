// W1-11a b：真实履约、状态链与事件之上的付款夹具；银行信息均是现造的假值。
import { createPrismaClient } from "@liyoxi/db";
import type { BillingOrder, PaymentTxn, PrismaClient } from "@liyoxi/db";
import { createPayment } from "../billing/index.js";
import type { Payment, PaymentDeps } from "../billing/index.js";
import { createFlow } from "../flow/index.js";
import { createBizNoIssuer, uuidv7 } from "../kernel/index.js";
import { createTimers } from "../timers/index.js";
import { assembleForTest } from "./assembly.js";
import { createFulfillHarness } from "./billing-fulfill.js";
import type { FulfillHarness, FulfillHarnessOptions } from "./billing-fulfill.js";

export interface PaymentHarness extends FulfillHarness {
  readonly payment: Payment;
  readonly paymentDeps: PaymentDeps;
}
export interface PaymentHarnessOptions extends FulfillHarnessOptions {
  readonly onApplyStep?: PaymentDeps["onStep"];
}
export function createPaymentHarness(
  prisma: PrismaClient,
  options: PaymentHarnessOptions = {},
): PaymentHarness {
  const h = createFulfillHarness(prisma, options);
  const assembly = assembleForTest({ entry: "worker" });
  const paymentDeps: PaymentDeps = {
    clock: h.clock,
    events: h.events,
    fulfillment: h.fulfillment,
    flow: createFlow({ assembly, clock: h.clock, events: h.events }),
    timers: createTimers({ assembly }),
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
    ...(options.onApplyStep ? { onStep: options.onApplyStep } : {}),
  };
  return { ...h, paymentDeps, payment: createPayment(paymentDeps) };
}
export async function joinPayment(
  h: PaymentHarness,
  url: string,
  options: Omit<PaymentHarnessOptions, "clock"> = {},
) {
  const prisma = createPrismaClient({ connectionString: url, max: 1 });
  return {
    ...createPaymentHarness(prisma, { ...options, clock: h.clock }),
    close: () => prisma.$disconnect(),
  };
}
async function bankRevision(h: PaymentHarness): Promise<string> {
  const prior = await h.prisma.financeConfigRevision.findFirst({
    where: { configKey: "bank_account" },
  });
  if (prior !== null) return prior.id;
  const id = uuidv7();
  const [staff, reviewer] = await Promise.all([h.make.staff(), h.make.staff()]);
  const now = h.clock.now();
  const approval = await h.prisma.approvalRequest.create({
    data: {
      id: uuidv7(),
      kind: "finance_config_change",
      category: "approval",
      subjectType: "finance_config_revision",
      subjectId: id,
      status: "approved",
      summarySnapshot: { title: "测试收款账户" },
      submitActorType: "staff",
      submitActorId: staff.id,
      submitClient: "admin",
      requesterStaffId: staff.id,
      submittedAt: now,
      decidedAt: now,
      decidedByStaffId: reviewer.id,
      dedupeKey: "finance_config_change:bank_account",
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.prisma.financeConfigRevision.create({
    data: {
      id,
      configKey: "bank_account",
      payload: {},
      accountNoEnc: "lyxtest.bank.enc",
      accountNoMask: "****1234",
      changeNote: "测试收款账户",
      approvalRequestId: approval.id,
      effectiveAt: now,
      createdAt: now,
    },
  });
  return id;
}
export async function pendingPlanOrder(
  h: PaymentHarness,
  input: {
    entityId: string;
    amountFen?: number;
    months?: number;
    status?: "pending_payment" | "pending_confirmation";
  },
): Promise<BillingOrder> {
  const plan = await h.prisma.plan.findUniqueOrThrow({ where: { code: "pro" } });
  const revision = await h.prisma.planRevision.findFirstOrThrow({
    where: { planId: plan.id, cancelledAt: null },
    orderBy: { revisionNo: "desc" },
  });
  const months = input.months ?? 1;
  const amountFen = input.amountFen ?? revision.monthlyFeeFen * months;
  const status = input.status ?? "pending_confirmation";
  return h.make.billingOrder({
    entityId: input.entityId,
    status,
    channel: "bank_transfer",
    transferState: status === "pending_payment" ? "awaiting_proof" : "proof_submitted",
    bankAccountFinanceConfigRevisionId: await bankRevision(h),
    amountFen,
    contentSnapshot: {
      v: 1,
      kind: "plan",
      planId: plan.id,
      planRevisionId: revision.id,
      months,
      cyclePriceFen: revision.monthlyFeeFen * months,
      payFen: amountFen,
      monthlyPoints: revision.monthlyPoints,
      discountBp: revision.discountBp,
      promo: null,
      quotedAt: h.clock.now().toISOString(),
    },
  });
}
export async function transferReceipt(
  h: PaymentHarness,
  order: BillingOrder,
  amountFen = order.amountFen,
): Promise<PaymentTxn> {
  const staff = await h.make.staff();
  const serial = uuidv7().replaceAll("-", "").toUpperCase();
  return h.make.paymentTxn({
    entityId: order.entityId,
    billingOrderId: order.id,
    channel: "bank_transfer",
    amountFen: order.amountFen,
    channelAmountFen: amountFen,
    channelTxnNo: serial,
    bankSerialRaw: serial,
    confirmedByStaffId: staff.id,
    reconState: "matched",
    channelSuccessAt: h.clock.now(),
  });
}
export const applyReceipt = (h: PaymentHarness, receipt: Pick<PaymentTxn, "id">) =>
  h.tx.run((tx) => h.payment.applyPayment(tx, { paymentTxnId: receipt.id }));
