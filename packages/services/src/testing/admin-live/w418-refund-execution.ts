import { planOrderContentSchema } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { createIdempotencyContext, createIdentityContext, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext } from "../../kernel/index.js";
import { placeholderPdf } from "../../media/index.js";
import { sampleStaffContext } from "../approval.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";
import type { AdminLiveFixtureContext } from "./context.js";

/** 一个新增实体：pending订单与资料走工厂，收款、申请和异人批准均走正式领域公口。 */
export async function prepareW418RefundExecution(
  { runtime, make }: AdminLiveFixtureContext,
  actors: { requesterStaffId: string; approverStaffId: string },
) {
  const { runId } = assertDeliveryLiveEnvironment(runtime.env);
  if (
    runtime.providers.storage.status !== "fake" ||
    actors.requesterStaffId === actors.approverStaffId
  )
    throw new Error("退款执行只接受本轮隔离环境与不同审批人");
  const now = runtime.clock.now();
  const facts = await runtime.tx.run(async (tx) => ({
    staff: await sampleStaffContext(tx, actors.requesterStaffId, { stepUpAt: now }),
    reviewer: await sampleStaffContext(tx, actors.approverStaffId, { stepUpAt: now }),
    plan: await tx.plan.findFirstOrThrow({ where: { isListed: true }, orderBy: { rank: "asc" } }),
    bank: await tx.financeConfigRevision.findFirstOrThrow({
      where: {
        configKey: "bank_account",
        effectiveAt: { lte: now },
        approvalRequest: { status: "approved" },
      },
      orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
    }),
    reason: await tx.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: "refund_reason", code: "RFEX418" } },
      create: {
        id: uuidv7(),
        dictTypeKey: "refund_reason",
        code: "RFEX418",
        name: "本轮线下退款核验",
        createdAt: now,
        updatedAt: now,
      },
      update: {},
    }),
  }));
  const ctx = createIdentityContext({
      actor: { type: "staff", id: actors.requesterStaffId, client: "admin" },
    }),
    reviewerCtx = createIdentityContext({
      actor: { type: "staff", id: actors.approverStaffId, client: "admin" },
    });
  const options = (identity: IdentityContext, scope: string, body: unknown) => ({
    idem: createIdempotencyContext({
      mode: "required",
      scope,
      actor: identity.actor,
      key: `rfex418:${uuidv7()}`,
      request: { method: "POST", body },
    }),
  });
  const own = await make.merchant({ verified: true }),
    entityName = `W418线下退款${runId.slice(0, 6)}主体`;
  await runtime.tx.run((tx) =>
    tx.entity.update({ where: { id: own.entity.id }, data: { name: entityName } }),
  );
  const merchant = {
      ctx: createIdentityContext({
        actor: { type: "merchant", id: own.user.id, role: "owner", client: "weapp" },
        entityId: own.entity.id,
        storeId: own.store.id,
      }),
      membership: {
        memberId: own.owner.id,
        entityId: own.entity.id,
        storeId: own.store.id,
        role: "owner" as const,
        storeMode: "active" as const,
      },
    },
    client = { platform: "devtools", appVersion: "1.0.0" };
  const quote = await runtime.billing.quotePlanPurchase(merchant, client, {
    planId: facts.plan.id,
    months: 1,
  });
  const order = await make.billingOrder({
    entityId: own.entity.id,
    storeId: own.store.id,
    status: "pending_payment",
    channel: "bank_transfer",
    transferState: "awaiting_proof",
    bankAccountFinanceConfigRevisionId: facts.bank.id,
    amountFen: quote.payFen,
    contentSnapshot: planOrderContentSchema.parse({
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
    }),
    fulfillmentStatus: "none",
    expiresAt: new Date(now.getTime() + 86400000),
  });
  const receipt = await make.fileObject({
    category: "pay_receipt",
    bucket: "secure",
    scopeType: "entity",
    entityId: own.entity.id,
    storeId: null,
    uploadActorType: "merchant",
    uploadActorId: own.user.id,
    uploadClient: "weapp",
    ext: "png",
    declaredMime: "image/png",
    mime: "image/png",
  });
  const submitted = await runtime.billing.submitProof(merchant, client, order.id, receipt.id);
  if (!submitted.latestTransferProof) throw new Error("本轮退款缺少实际付款凭证");
  const proof = await runtime.billing.getProof(
    facts.staff,
    submitted.latestTransferProof.transferProofId,
  );
  const confirm = {
    lockVersion: proof.lockVersion,
    bankSerialNo: `RFEX418${runId}`,
    confirm: { orderNo: order.orderNo, receivedAmountFen: quote.payFen },
    confirmChecks: ["bank_statement_checked"],
  };
  const paid = await runtime.billing.confirmProof(
    ctx,
    facts.staff,
    proof.transferProofId,
    confirm,
    options(ctx, "admin.transferProof.confirm", confirm),
  );
  if (paid.outcome !== "paid") throw new Error("本轮退款须真实收款后发起");
  const refundQuote = await runtime.billing.refunds.quote(facts.staff, order.id, "window");
  if (
    !refundQuote.supported ||
    !refundQuote.rules.some((rule) => rule.rule === "window" && rule.eligible)
  )
    throw new Error("本轮线下退款未满足实际规则");
  const create = {
    ruleCode: "window" as const,
    reasonCode: facts.reason.code,
    note: "仅本轮线下退款真实回读",
    confirm: { orderNo: order.orderNo, amountFen: refundQuote.refundableFen },
  };
  const refund = await runtime.billing.refunds.create(
    ctx,
    facts.staff,
    order.id,
    create,
    options(ctx, "admin.paymentOrder.refundRequest.create", create),
  );
  const approve = {
    lockVersion: refund.approval.lockVersion,
    confirm: { requestNo: refund.requestNo, amountFen: refund.amountFen },
    confirmChecks: ["rule_amount_checked"],
  };
  const approved = await runtime.billing.refunds.approve(
    reviewerCtx,
    facts.reviewer,
    refund.refundRequestId,
    approve,
    options(reviewerCtx, "admin.refundRequest.approve", approve),
  );
  if (
    approved.status !== "pending_execution" ||
    !approved.actions.includes("record-offline") ||
    approved.refundTxns.length !== 0 ||
    approved.entitlementRevokedAt !== null
  )
    throw new Error("本轮退款必须由实际异人批准且尚未执行");
  return {
    refundRequestId: approved.refundRequestId,
    requestNo: approved.requestNo,
    amountFen: approved.amountFen,
    entityId: own.entity.id,
    entityName,
    requesterStaffId: actors.requesterStaffId,
    approverStaffId: actors.approverStaffId,
    transferDate: calendarDate(now),
    bankSerialNo: `OFF418${runId.toUpperCase()}`,
    pdf: Buffer.from(placeholderPdf("W418-FICTIONAL-REFUND-RECEIPT")).toString("base64"),
  };
}
