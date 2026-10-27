import { FinanceConfigCreateBodySchema, planOrderContentSchema } from "@liyoxi/contract";
import { createFulfillment } from "../../billing/index.js";
import { createIdentityContext } from "../../kernel/index.js";
import { pdf } from "../document-fixtures.js";
import { sampleStaffContext } from "../approval.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";
import type { AdminLiveFixture } from "./context.js";
/** 本轮隔离前置：复用两名财务真实审批开单开关；余额经真实fulfill生成，不预填缓存或待收款。 */
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
  const { runId } = assertDeliveryLiveEnvironment(runtime.env);
  if (runtime.providers.storage.status !== "fake") throw new Error("W417只接受本轮替身资料");
  const prefix = `W417演练${runId.slice(0, 6)}`;
  const rows = await runtime.tx.run(async (tx) => ({
    proposer: await tx.staff.findFirstOrThrow({
      where: { name: "演练财务配置提议", staffRoleKey: "finance", status: "active" },
    }),
    approver: await tx.staff.findFirstOrThrow({
      where: { name: "演练财务配置审批", staffRoleKey: "finance", status: "active" },
    }),
    admin: await tx.staff.findFirstOrThrow({
      where: { staffRoleKey: "super_admin", status: "active" },
    }),
    current: await tx.financeConfigRevision.findFirstOrThrow({
      where: {
        configKey: "controls",
        effectiveAt: { lte: runtime.clock.now() },
        approvalRequest: { status: "approved" },
      },
      orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
    }),
  }));
  const staff = async (id: string) =>
    runtime.tx.run((tx) => sampleStaffContext(tx, id, { stepUpAt: runtime.clock.now() }));
  const identity = (id: string) =>
    createIdentityContext({ actor: { type: "staff", id, client: "admin" } });
  const payload = rows.current.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new Error("缺少本轮真实财务controls");
  if (!("adminCreateOrder" in payload) || payload.adminCreateOrder !== true) {
    const proposed = await runtime.billing.financeConfig.create(
      identity(rows.proposer.id),
      await staff(rows.proposer.id),
      FinanceConfigCreateBodySchema.parse({
        configKey: "controls",
        payload: { ...payload, adminCreateOrder: true },
        changeNote: "本轮W417虚构线下开单页面验收",
        confirm: { configKey: "controls", baseRevisionId: rows.current.id },
      }),
    );
    await runtime.billing.financeConfig.approve(
      identity(rows.approver.id),
      await staff(rows.approver.id),
      proposed.financeConfigRevisionId,
      {
        lockVersion: proposed.approval.lockVersion,
        confirmChecks: ["change_reviewed"],
        confirm: {
          configKey: "controls",
          financeConfigRevisionId: proposed.financeConfigRevisionId,
        },
      },
    );
  }
  const merchant = await make.merchant({ verified: true });
  await runtime.tx.run(async (tx) => {
    await tx.entity.update({ where: { id: merchant.entity.id }, data: { name: `${prefix}主体` } });
    await tx.store.update({ where: { id: merchant.store.id }, data: { name: `${prefix}门店` } });
  });
  const plan = await runtime.tx.run((tx) =>
    tx.plan.findFirstOrThrow({ where: { isListed: true }, orderBy: { rank: "asc" } }),
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
  const quote = await runtime.billing.quotePlanPurchase(
    actor,
    { platform: "devtools", appVersion: "1.0.0" },
    { planId: plan.id, months: 1 },
  );
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
    amountFen: quote.payFen,
    contentSnapshot: content,
    status: "paid",
  });
  const fulfillment = createFulfillment({ clock: runtime.clock, events: runtime.events });
  await runtime.tx.run(async (tx) => {
    const outcome = await fulfillment.fulfill(tx, {
      billingOrderId: order.id,
      ctx: createIdentityContext({ actor: { type: "system", job: "lyxtest.w417" } }),
    });
    if (outcome.result.status !== "done") throw new Error("本轮W417账户前置履约未完成");
    await tx.billingOrder.update({
      where: { id: order.id },
      data: {
        fulfillmentResult: outcome.result,
        fulfillmentStatus: "done",
        fulfilledAt: new Date(outcome.result.effectiveAt),
      },
    });
  });
  const admin = await staff(rows.admin.id),
    account = await runtime.billing.accounts.get(admin, merchant.entity.id);
  const pack = await runtime.tx.run((tx) =>
    tx.pointPack.findFirstOrThrow({ where: { isListed: true }, orderBy: { priceFen: "asc" } }),
  );
  const maxRank = await runtime.tx.run((tx) =>
    tx.plan.findFirstOrThrow({ orderBy: { rank: "desc" } }),
  );
  const draft = await runtime.billingPlansAdmin.create(
    { identity: identity(rows.admin.id), staff: admin },
    { code: `live_${runId.slice(0, 12)}`, name: `${prefix}套餐`, rank: maxRank.rank + 1 },
  );
  return {
    prefix,
    entityId: merchant.entity.id,
    entityName: `${prefix}主体`,
    storeId: merchant.store.id,
    spendablePoints: account.spendablePoints,
    planId: draft.planId,
    planName: draft.name,
    planCode: draft.code,
    pack: { id: pack.id, points: pack.points, priceFen: pack.priceFen },
    initialPaymentOrderId: order.id,
    receipt: {
      name: "w417-fictional-receipt.pdf",
      mime: "application/pdf",
      base64: Buffer.from(pdf("W417 synthetic transfer receipt")).toString("base64"),
    },
  };
};
export default fixture;
