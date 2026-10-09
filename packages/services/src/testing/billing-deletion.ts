// W2-10 关闭阻断出口的私有DB夹具：只证明真实表计数，不模拟退款/发票执行器已交付。
import type { Clock, Tx } from "../kernel/index.js";
import { uuidv7 } from "../kernel/index.js";
import { createFactories } from "./data/factories/index.js";
import { testSealer } from "./data/seal.js";

export async function seedBillingDeletionFacts(
  tx: Tx,
  clock: Clock,
  merchant: { entityId: string; userId: string },
) {
  const make = createFactories({ db: tx, clock });
  const now = clock.now();
  const { entityId, userId } = merchant;
  for (const [i, status] of ["active", "scheduled", "ended", "refunded", "cancelled"].entries()) {
    const year = 2020 + i;
    await make.subscriptionTerm({
      entityId,
      termNo: i + 1,
      status,
      startDate: new Date(`${year}-01-01T00:00:00Z`),
      endDate: new Date(`${year}-01-31T00:00:00Z`),
      startsAt: new Date(`${year}-01-01T00:00:00+08:00`),
      endsAt: new Date(`${year}-02-01T00:00:00+08:00`),
    });
  }
  await make.billingOrder({ entityId, status: "pending_payment", hasOpenException: true });
  await make.billingOrder({ entityId, status: "paid", hasOpenException: true });
  await make.billingOrder({ entityId, status: "cancelled", hasOpenException: true });
  await make.billingOrder({ entityId, status: "cancelled" });
  await make.billingOrder({ entityId, status: "refunded" });
  const requester = await make.staff();
  // 对公待确认需要真实配置外键；只补本测试库的缺失前置，不声称走过财务审批。
  let finance = await tx.financeConfigRevision.findFirst({
    where: { configKey: "bank_account", effectiveAt: { lte: now } },
    orderBy: { effectiveAt: "desc" },
  });
  if (!finance) {
    const financeId = uuidv7();
    const reviewer = await make.staff();
    const approval = await tx.approvalRequest.create({
      data: {
        id: uuidv7(),
        kind: "finance_config_change",
        category: "approval",
        subjectType: "finance_config_revision",
        subjectId: financeId,
        status: "approved",
        summarySnapshot: { title: "关闭阻断测试收款配置" },
        submitActorType: "staff",
        submitActorId: requester.id,
        submitClient: "admin",
        requesterStaffId: requester.id,
        submittedAt: now,
        decidedAt: now,
        decidedByStaffId: reviewer.id,
        dedupeKey: `finance_config_change:${financeId}`,
        createdAt: now,
        updatedAt: now,
      },
    });
    finance = await tx.financeConfigRevision.create({
      data: {
        id: financeId,
        configKey: "bank_account",
        payload: {},
        accountNoEnc: testSealer.text("finance_config_revision.account_no_enc", "123456789012"),
        accountNoMask: "********9012",
        changeNote: "测试收款配置",
        approvalRequestId: approval.id,
        effectiveAt: now,
        createdAt: now,
      },
    });
  }
  await make.billingOrder({
    entityId,
    type: "topup",
    status: "pending_confirmation",
    channel: "bank_transfer",
    transferState: "proof_submitted",
    bankAccountFinanceConfigRevisionId: finance.id,
  });
  for (const closed of [false, true]) {
    const order = await make.billingOrder({ entityId });
    const approvalId = uuidv7();
    await tx.approvalRequest.create({
      data: {
        id: approvalId,
        requestNo: `TK${approvalId.replaceAll("-", "")}`,
        kind: "plan_refund",
        category: "approval",
        subjectType: "billing_order",
        subjectId: order.id,
        entityId,
        status: closed ? "rejected" : "pending",
        summarySnapshot: { title: "关闭阻断测试退款" },
        requesterStaffId: requester.id,
        submitActorType: "system",
        submittedAt: now,
        ...(closed ? { decidedAt: now, isDecidedBySystem: true, decisionNote: "测试驳回" } : {}),
        createdAt: now,
        updatedAt: now,
      },
    });
    await tx.refundRequest.create({
      data: {
        id: uuidv7(),
        approvalRequestId: approvalId,
        source: "customer_service",
        entityId,
        billingOrderId: order.id,
        paymentTxnId: order.paidPaymentTxnId!,
        baseAmountFen: order.amountFen,
        amountFen: order.amountFen,
        breakdownSnapshot: {},
        ruleCode: "window",
        ruleText: "测试退款规则",
        reasonCode: "other",
        status: closed ? "not_executed" : "pending_approval",
        ...(closed ? { closedAt: now, closeReason: "rejected" } : {}),
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  for (const status of ["pending", "red_pending", "issued", "red_issued", "rejected"]) {
    const order = await make.billingOrder({ entityId });
    const id = uuidv7();
    await tx.invoiceRequest.create({
      data: {
        id,
        requestNo: `FP${id.replaceAll("-", "")}`,
        billingOrderId: order.id,
        entityId,
        amountFen: order.amountFen,
        invoiceType: "normal",
        medium: "electronic",
        title: "计数测试门店",
        taxNoEnc: testSealer.text("invoice_request.tax_no_enc", "913300001234567890"),
        taxNoMask: "9133**********7890",
        recvEmailEnc: testSealer.text("invoice_request.recv_email_enc", "test@example.invalid"),
        recvEmailMask: "te**@example.invalid",
        itemName: "测试服务",
        status,
        ...(status === "rejected" ? { rejectedAt: now, rejectKind: "order_refunded" } : {}),
        appliedByUserId: userId,
        appliedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
}
