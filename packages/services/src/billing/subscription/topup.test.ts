import { beforeEach, expect, it } from "vitest";
import { AppError, createIdentityContext } from "../../kernel/index.js";
import { createConfig } from "../../config/index.js";
import { createTenant } from "../../tenant/index.js";
import {
  assembleForTest,
  createPaymentHarness,
  useSeededDatabase,
  pendingPlanOrder,
  transferReceipt,
  applyReceipt,
  sampleStaffContext,
  snapshotTables,
} from "../../testing/index.js";
import type { PaymentHarness } from "../../testing/index.js";
import { prepareClosedBillingDays } from "../../testing/billing-daily.js";
import type { BillingOrder } from "@liyoxi/db";
import { createPointPacks } from "../catalog/point-packs.js";
import { billingInvariants } from "../invariants.js";
import { subscriptionInvariants } from "./invariants.js";
import { paymentInvariants } from "../payment/invariants.js";
const db = useSeededDatabase("services", { max: 1 });
beforeEach(() => db.reset(), 60000);
const tables = [
  "billing_order",
  "payment_txn",
  "point_lot",
  "ledger_operation",
  "point_ledger_entry",
  "billing_account",
  "status_transition",
  "outbox_event",
  "audit_log",
  "payment_exception",
];
async function topup(
  h: PaymentHarness,
  plan: BillingOrder,
  pack: { id: string; points: number; priceFen: number },
) {
  return h.make.billingOrder({
    entityId: plan.entityId,
    storeId: plan.storeId,
    type: "topup",
    status: "pending_payment",
    fulfillmentStatus: "none",
    fulfilledAt: null,
    channel: "bank_transfer",
    transferState: "awaiting_proof",
    bankAccountFinanceConfigRevisionId: plan.bankAccountFinanceConfigRevisionId,
    amountFen: pack.priceFen,
    contentSnapshot: {
      v: 1,
      kind: "topup",
      packId: pack.id,
      points: pack.points,
      payFen: pack.priceFen,
    },
  });
}
async function invariant(h: PaymentHarness, id: string) {
  await prepareClosedBillingDays(h, id);
  for (const rule of [...billingInvariants, ...subscriptionInvariants, ...paymentInvariants])
    expect(
      await h.tx.run((tx) => rule.run!(tx, { entityIds: [id] }, { now: h.clock.now() })),
      rule.code,
    ).toEqual([]);
}
it("真实成功收款经fulfill只购一次，改价下架不改旧快照且原套餐履约保持", async () => {
  const h = createPaymentHarness(await db.prisma());
  h.clock.set(new Date("2026-10-01T00:00:00.000Z"));
  const own = await h.make.merchant({ verified: true });
  const plan = await pendingPlanOrder(h, { entityId: own.entity.id });
  expect((await applyReceipt(h, await transferReceipt(h, plan))).result).toMatchObject({
    status: "applied",
    fulfillment: { status: "done", termId: expect.any(String) },
  });
  const pack = await h.prisma.pointPack.findFirstOrThrow({ orderBy: { position: "asc" } });
  const order = await topup(h, plan, pack);
  const assembly = assembleForTest({ entry: "api" }),
    staff = await h.make.staff({ staffRoleKey: "super_admin" });
  const service = createPointPacks({
    tx: h.tx,
    clock: h.clock,
    config: createConfig({ db: h.prisma, clock: h.clock, redis: null }),
    tenant: createTenant({ tx: h.tx, clock: h.clock, flow: h.paymentDeps.flow, assembly }),
  });
  const actor = {
    identity: createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
    staff: await sampleStaffContext(h.prisma, staff.id),
  };
  await service.update(actor, pack.id, {
    lockVersion: pack.lockVersion,
    priceFen: pack.priceFen + 17,
  });
  await service.delist(actor, pack.id);
  const receipt = await transferReceipt(h, order);
  const result = await applyReceipt(h, receipt);
  expect(result.result).toMatchObject({
    status: "applied",
    fulfillment: { status: "done", termId: null },
  });
  const lots = await h.prisma.pointLot.findMany({
    where: { sourceType: "purchase", sourceId: order.id },
  });
  expect(lots).toMatchObject([
    {
      kind: "addon",
      originalQty: pack.points,
      availableQty: pack.points,
      costBasisFen: pack.priceFen,
      expiresAt: null,
    },
  ]);
  expect(
    await h.prisma.ledgerOperation.count({
      where: {
        opKey: { in: [`purchase:billing_order:${order.id}`, `fulfill:billing_order:${order.id}`] },
      },
    }),
  ).toBe(2);
  expect(
    await h.prisma.outboxEvent.count({
      where: {
        eventType: "billing.points.purchased",
        payload: { path: ["billingOrderId"], equals: order.id },
      },
    }),
  ).toBe(1);
  expect(
    await h.prisma.outboxEvent.count({
      where: { eventType: "billing.order_fulfilled", aggregateId: order.id },
    }),
  ).toBe(1);
  const before = await snapshotTables(h.prisma, tables);
  expect((await applyReceipt(h, receipt)).replayed).toBe(true);
  const again = await h.tx.run((tx) =>
    h.fulfillment.fulfill(tx, {
      billingOrderId: order.id,
      ctx: createIdentityContext({ actor: { type: "system", job: "lyxtest.topup" } }),
    }),
  );
  expect(again.replayed).toBe(true);
  expect(again.result).toEqual(
    result.result.status === "applied" ? result.result.fulfillment : null,
  );
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  await invariant(h, own.entity.id);
});
it("加购流水故障整单回滚，重试一次入账；套餐到期停用与真实重新开通恢复余额", async () => {
  let failure = false;
  const h = createPaymentHarness(await db.prisma(), {
    onStep: (step) => {
      if (failure && step === "entry.insert") throw new AppError("ACCOUNT_BUSY");
    },
  });
  h.clock.set(new Date("2026-10-01T00:00:00.000Z"));
  const own = await h.make.merchant({ verified: true });
  const plan = await pendingPlanOrder(h, { entityId: own.entity.id });
  await applyReceipt(h, await transferReceipt(h, plan));
  const pack = await h.prisma.pointPack.findFirstOrThrow({ orderBy: { position: "asc" } });
  const order = await topup(h, plan, pack),
    receipt = await transferReceipt(h, order);
  const before = await snapshotTables(h.prisma, tables);
  failure = true;
  try {
    await expect(applyReceipt(h, receipt)).rejects.toMatchObject({ error: "ACCOUNT_BUSY" });
  } finally {
    failure = false;
  }
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  expect((await applyReceipt(h, receipt)).result).toMatchObject({
    status: "applied",
    fulfillment: { status: "done" },
  });
  const term = await h.prisma.subscriptionTerm.findUniqueOrThrow({
    where: { sourceBillingOrderId: plan.id },
  });
  h.clock.set(new Date(term.endsAt.getTime() + 1));
  await h.tx.run((tx) => h.ledger.advance(tx, own.entity.id));
  expect(
    await h.prisma.billingAccount.findUniqueOrThrow({ where: { entityId: own.entity.id } }),
  ).toMatchObject({ subStatus: "expired", addonAvailableQty: pack.points });
  const lotBefore = await h.prisma.pointLot.findFirstOrThrow({
    where: { sourceType: "purchase", sourceId: order.id },
  });
  const next = await pendingPlanOrder(h, { entityId: own.entity.id });
  await applyReceipt(h, await transferReceipt(h, next));
  expect(
    await h.prisma.billingAccount.findUniqueOrThrow({ where: { entityId: own.entity.id } }),
  ).toMatchObject({ subStatus: "active", addonAvailableQty: pack.points });
  expect(await h.prisma.pointLot.findUniqueOrThrow({ where: { id: lotBefore.id } })).toEqual(
    lotBefore,
  );
  expect(
    await h.prisma.ledgerOperation.count({
      where: { entityId: own.entity.id, opType: "addon_resume" },
    }),
  ).toBe(1);
  await invariant(h, own.entity.id);
});
