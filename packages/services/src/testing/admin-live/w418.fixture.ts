import { planOrderContentSchema } from "@liyoxi/contract";
import {
  createIdempotencyContext,
  createIdentityContext,
  isAppError,
  uuidv7,
} from "../../kernel/index.js";
import { sampleStaffContext } from "../approval.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";
import { prepareW418Approvals } from "./w418-approval.js";
import { prepareW418RefundExecution } from "./w418-refund-execution.js";
import { prepareW418Invoices } from "./w418-invoices.js";
import type { AdminLiveFixture, AdminLiveFixtureContext } from "./context.js";

/** 工厂只造pending单/资料，入账、申请及自审拒绝均走实际领域公口。 */
async function prepare({ runtime, make }: AdminLiveFixtureContext, mark: (phase: string) => void) {
  const { runId } = assertDeliveryLiveEnvironment(runtime.env);
  if (runtime.providers.storage.status !== "fake") throw new Error("W418只接受隔离替身环境");
  const prefix = `W418演练${runId.slice(0, 6)}`;
  const setup = await runtime.tx.run(async (tx) => ({
    admin: await tx.staff.findFirstOrThrow({
      where: { staffRoleKey: "super_admin", status: "active" },
    }),
    plan: await tx.plan.findFirstOrThrow({ where: { isListed: true }, orderBy: { rank: "asc" } }),
    bank: await tx.financeConfigRevision.findFirstOrThrow({
      where: {
        configKey: "bank_account",
        effectiveAt: { lte: runtime.clock.now() },
        approvalRequest: { status: "approved" },
      },
      orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
    }),
    reason: await tx.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: "refund_reason", code: "RF418" } },
      create: {
        id: uuidv7(),
        dictTypeKey: "refund_reason",
        code: "RF418",
        name: "只读页隔离退款",
        createdAt: runtime.clock.now(),
        updatedAt: runtime.clock.now(),
      },
      update: {},
    }),
  }));
  const staff = await runtime.tx.run((tx) =>
    sampleStaffContext(tx, setup.admin.id, { stepUpAt: runtime.clock.now() }),
  );
  const ctx = createIdentityContext({
    actor: { type: "staff", id: setup.admin.id, client: "admin" },
  });
  const options = (scope: string, body: unknown, identity = ctx) => ({
    idem: createIdempotencyContext({
      mode: "required",
      scope,
      actor: identity.actor,
      key: `w418:${runId}:${uuidv7()}`,
      request: { method: "POST", body },
    }),
  });
  const items = [];
  for (let index = 0; index < 2; index++) {
    mark("merchant");
    const merchant = await make.merchant({ verified: true });
    const entityName = `${prefix}主体${index + 1}`;
    await runtime.tx.run((tx) =>
      tx.entity.update({ where: { id: merchant.entity.id }, data: { name: entityName } }),
    );
    const actor = {
      ctx: createIdentityContext({
        actor: { type: "merchant", id: merchant.user.id, client: "weapp", role: "owner" },
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
      }),
      membership: {
        memberId: merchant.owner.id,
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
        role: "owner" as const,
        storeMode: "active" as const,
      },
    };
    const client = { platform: "devtools", appVersion: "1.0.0" };
    mark("quote-plan");
    const quote = await runtime.billing.quotePlanPurchase(actor, client, {
      planId: setup.plan.id,
      months: 1,
    });
    const content = planOrderContentSchema.parse({
      v: 1,
      kind: "plan",
      planId: quote.planId,
      planName: quote.planName,
      planRevisionId: quote.planRevisionId,
      months: quote.months,
      cyclePriceFen: quote.payFen,
      payFen: quote.payFen,
      monthlyPoints: quote.benefits.monthlyPoints,
      discountBp: quote.benefits.discountBp,
      promo: null,
      quotedAt: quote.quotedAt,
    });
    const order = await make.billingOrder({
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      status: "pending_payment",
      channel: "bank_transfer",
      transferState: "awaiting_proof",
      bankAccountFinanceConfigRevisionId: setup.bank.id,
      amountFen: quote.payFen,
      contentSnapshot: content,
      fulfillmentStatus: "none",
      expiresAt: new Date(runtime.clock.now().getTime() + 24 * 3600_000),
    });
    const file = await make.fileObject({
      category: "pay_receipt",
      bucket: "secure",
      scopeType: "entity",
      entityId: merchant.entity.id,
      storeId: null,
      uploadActorType: "merchant",
      uploadActorId: merchant.user.id,
      uploadClient: "weapp",
      ext: "png",
      declaredMime: "image/png",
      mime: "image/png",
    });
    mark("submit-proof");
    const submitted = await runtime.billing.submitProof(actor, client, order.id, file.id);
    if (!submitted.latestTransferProof) throw new Error("W418实际凭证未生成");
    const proof = await runtime.billing.getProof(
      staff,
      submitted.latestTransferProof.transferProofId,
    );
    const confirm = {
      lockVersion: proof.lockVersion,
      bankSerialNo: `W418-${runId}-${index + 1}`,
      confirm: { orderNo: order.orderNo, receivedAmountFen: quote.payFen },
      confirmChecks: ["bank_statement_checked"],
    };
    mark("confirm-proof");
    const confirmed = await runtime.billing.confirmProof(
      ctx,
      staff,
      proof.transferProofId,
      confirm,
      options("admin.transferProof.confirm", confirm),
    );
    if (confirmed.outcome !== "paid") throw new Error("W418真实确认未完成，不伪造收款事实");
    const transaction = await runtime.tx.run((tx) =>
      tx.paymentTxn.findFirstOrThrow({
        where: { billingOrderId: order.id, status: "succeeded", appliedAt: { not: null } },
      }),
    );
    if (!transaction.channelSuccessAt || transaction.channelAmountFen === null)
      throw new Error("W418真实收款缺少成功事实");
    items.push({
      paymentOrderId: order.id,
      orderNo: order.orderNo,
      entityId: merchant.entity.id,
      entityName,
      paymentTransactionId: transaction.id,
      amountFen: transaction.channelAmountFen,
      channelTxnNo: transaction.channelTxnNo,
      channelSuccessAt: transaction.channelSuccessAt.toISOString(),
      feeFen: transaction.feeFen,
    });
  }
  const first = items[0]!;
  const approvals = await prepareW418Approvals({ runtime, make }, items[1]!, mark);
  const refundStaff = await runtime.tx.run((tx) =>
    sampleStaffContext(tx, approvals.requesterStaffId, { stepUpAt: runtime.clock.now() }),
  );
  const refundActor = createIdentityContext({
    actor: { type: "staff", id: approvals.requesterStaffId, client: "admin" },
  });
  mark("refund-quote");
  const quote = await runtime.billing.refunds.quote(refundStaff, first.paymentOrderId, "window");
  if (!quote.supported || !quote.rules.some((rule) => rule.rule === "window" && rule.eligible))
    throw new Error("W418实际退款规则不满足");
  const input = {
    ruleCode: "window" as const,
    reasonCode: setup.reason.code,
    note: "仅供本轮后台退款审批验收",
    confirm: { orderNo: first.orderNo, amountFen: quote.refundableFen },
  };
  mark("refund-create");
  const refund = await runtime.billing.refunds.create(
    refundActor,
    refundStaff,
    first.paymentOrderId,
    input,
    options("admin.paymentOrder.refundRequest.create", input, refundActor),
  );
  if (refund.status !== "pending_approval") throw new Error("W418退款申请未进入真实待批");
  const approve = {
    lockVersion: refund.approval.lockVersion,
    confirm: { requestNo: refund.requestNo, amountFen: refund.amountFen },
    confirmChecks: ["rule_amount_checked"],
  };
  const before = await runtime.tx.run((tx) =>
    tx.ledgerOperation.count({ where: { entityId: first.entityId } }),
  );
  mark("refund-self-forbidden");
  let selfDenied = false;
  try {
    await runtime.billing.refunds.approve(
      refundActor,
      refundStaff,
      refund.refundRequestId,
      approve,
      options("admin.refundRequest.approve", approve, refundActor),
    );
  } catch (error) {
    if (isAppError(error) && error.error === "APPROVAL_SELF_FORBIDDEN") selfDenied = true;
    else throw error;
  }
  const current = await runtime.billing.refunds.get(refundStaff, refund.refundRequestId),
    after = await runtime.tx.run((tx) =>
      tx.ledgerOperation.count({ where: { entityId: first.entityId } }),
    );
  if (
    !selfDenied ||
    before !== after ||
    current.status !== "pending_approval" ||
    current.approval.status !== "pending" ||
    current.approval.lockVersion !== refund.approval.lockVersion ||
    current.entitlementRevokedAt !== null ||
    current.refundTxns.length !== 0
  )
    throw new Error("W418退款自审未拒绝或拒绝后财务事实变化");
  return {
    execution: await prepareW418RefundExecution(
      { runtime, make },
      {
        requesterStaffId: setup.admin.id,
        approverStaffId: approvals.requesterStaffId,
      },
    ),
    invoices: await prepareW418Invoices({ runtime, make }),
    prefix,
    items,
    approvals,
    refund: {
      requesterStaffId: approvals.requesterStaffId,
      approvalId: refund.approval.approvalId,
      selfApprovalRejectedWithoutLedgerWrites: true,
      refundRequestId: refund.refundRequestId,
      requestNo: refund.requestNo,
      amountFen: refund.amountFen,
      entityId: first.entityId,
      entityName: first.entityName,
    },
  };
}
const fixture: AdminLiveFixture = async (context) => {
  let phase = "setup";
  try {
    return await prepare(context, (next) => {
      phase = next;
    });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ evt: "w418.fixture.failed", phase, name: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,50}$/.test(error.name) ? error.name : "Error", symbol: isAppError(error) ? error.error : null })}\n`,
    );
    throw error;
  }
};
export default fixture;
