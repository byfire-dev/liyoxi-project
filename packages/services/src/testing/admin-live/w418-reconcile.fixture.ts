import { planOrderContentSchema } from "@liyoxi/contract";
import { createIdentityContext } from "../../kernel/index.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";
import type { AdminLiveFixture } from "./context.js";

/** 只造独立pending候选，浏览器经正式create/resolve入账；不写资金或差异终态。 */
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
  const { runId } = assertDeliveryLiveEnvironment(runtime.env);
  if (runtime.providers.storage.status !== "fake") throw new Error("W418对账只接受隔离替身环境");
  const merchant = await make.merchant({ verified: true }),
    prefix = `W418对账${runId.slice(0, 6)}`,
    entityName = `${prefix}候选主体`;
  const setup = await runtime.tx.run(async (tx) => {
    await tx.entity.update({ where: { id: merchant.entity.id }, data: { name: entityName } });
    return {
      plan: await tx.plan.findFirstOrThrow({ where: { isListed: true }, orderBy: { rank: "asc" } }),
      bank: await tx.financeConfigRevision.findFirstOrThrow({
        where: {
          configKey: "bank_account",
          effectiveAt: { lte: runtime.clock.now() },
          approvalRequest: { status: "approved" },
        },
        orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
      }),
    };
  });
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
  const quote = await runtime.billing.quotePlanPurchase(
      actor,
      { platform: "devtools", appVersion: "1.0.0" },
      { planId: setup.plan.id, months: 1 },
    ),
    content = planOrderContentSchema.parse({
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
  const minute = Math.floor((runtime.clock.now().getTime() - 60_000) / 60_000) * 60_000;
  return {
    prefix,
    entityId: merchant.entity.id,
    entityName,
    paymentOrderId: order.id,
    orderNo: order.orderNo,
    amountFen: order.amountFen,
    receivedAt: new Date(minute).toISOString(),
    payerName: `${prefix}虚构付款人`,
    bankSerialNo: `RECON418${runId}`,
    note: "W418隔离收款关联验收",
  };
};
export default fixture;
