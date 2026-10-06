import { planOrderContentSchema } from "@liyoxi/contract";
import { seedPlaceholderFinanceConfig } from "../../billing/demo-seed.js";
import { createIdentityContext } from "../../kernel/index.js";
import { loadKeyring } from "../../security/index.js";
import type { AdminLiveFixture } from "./context.js";
/** 本页真实API前置：正常双人财务审批配置，工厂只准备未付款单及已入库回单。 */
const fixture: AdminLiveFixture = async ({ make, runtime }) => {
  const group = await runtime.tx.run((tx) =>
    tx.staffGroup.findFirstOrThrow({ where: { staffRoleKey: "finance", isDefault: true } }),
  );
  const proposer = await make.staff({
    name: "演练财务配置提议",
    staffRoleKey: "finance",
    status: "active",
    staffGroupId: group.id,
  });
  const approver = await make.staff({
    name: "演练财务配置审批",
    staffRoleKey: "finance",
    status: "active",
    staffGroupId: group.id,
    isLead: true,
  });
  await seedPlaceholderFinanceConfig(
    {
      tx: runtime.tx,
      clock: runtime.clock,
      assembly: runtime.assembly,
      bizNo: runtime.bizNo,
      keyring: loadKeyring(runtime.env),
    },
    { proposerId: proposer.id, approverId: approver.id },
  );
  const finance = await runtime.tx.run((tx) =>
    tx.financeConfigRevision.findFirstOrThrow({
      where: { configKey: "bank_account", effectiveAt: { lte: runtime.clock.now() } },
      orderBy: { effectiveAt: "desc" },
    }),
  );
  const plan = await runtime.tx.run((tx) =>
    tx.plan.findFirstOrThrow({ where: { isListed: true }, orderBy: { rank: "asc" } }),
  );
  const items = [];
  for (let index = 0; index < 3; index++) {
    const merchant = await make.merchant({ verified: true });
    await runtime.tx.run((tx) =>
      tx.entity.update({
        where: { id: merchant.entity.id },
        data: { name: `到账演练主体${index + 1}` },
      }),
    );
    const actor = {
      ctx: createIdentityContext({
        actor: { type: "merchant", id: merchant.user.id, client: "weapp" },
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
    const quote = await runtime.billing.quotePlanPurchase(actor, client, {
      planId: plan.id,
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
      bankAccountFinanceConfigRevisionId: finance.id,
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
    const submitted = await runtime.billing.submitProof(actor, client, order.id, file.id);
    if (!submitted.latestTransferProof) throw new Error("到账演练凭证未生成");
    items.push({
      proofId: submitted.latestTransferProof.transferProofId,
      paymentOrderId: order.id,
      orderNo: order.orderNo,
      entityId: merchant.entity.id,
      entityName: `到账演练主体${index + 1}`,
      amountFen: quote.payFen,
      fileId: file.id,
    });
  }
  return { items, addedStaffCount: 2 };
};
export default fixture;
