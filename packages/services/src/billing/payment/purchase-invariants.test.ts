import { beforeAll, describe, expect, it } from "vitest";
import { createPaymentHarness, pendingPlanOrder, useSeededDatabase } from "../../testing/index.js";
import { uuidv7 } from "../../kernel/index.js";
import { purchaseInvariants } from "./purchase-registration.js";
const db = useSeededDatabase("services");
let h: ReturnType<typeof createPaymentHarness>;
beforeAll(async () => {
  h = createPaymentHarness(await db.prisma());
}, 180_000);
const run = (code: string, entityId: string) =>
  h.tx.run((tx) =>
    purchaseInvariants.find((c) => c.code === code)!.run!(
      tx,
      { entityIds: [entityId] },
      { now: h.clock.now() },
    ),
  );
async function setup(status: "pending" | "accepted" = "pending") {
  const { entity, user } = await h.make.merchant({ verified: true }),
    order = await pendingPlanOrder(h, { entityId: entity.id, status: "pending_confirmation" }),
    file = await h.make.fileObject({
      category: "pay_receipt",
      bucket: "secure",
      scopeType: "entity",
      entityId: entity.id,
    }),
    staff = await h.make.staff({ staffRoleKey: "finance" }),
    now = h.clock.now();
  const proof = await h.prisma.transferProof.create({
    data: {
      id: uuidv7(),
      entityId: entity.id,
      billingOrderId: order.id,
      uploadNo: 1,
      fileId: file.id,
      uploadedByUserId: user.id,
      uploadedAt: now,
      reviewStatus: status,
      ...(status === "accepted" ? { reviewedByStaffId: staff.id, reviewedAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    },
  });
  return { entity, order, proof, staff };
}
describe("对公凭证每日财务不变量", () => {
  it("三项为每日 full/P1、不自愈；I14 双向核验恰一张 pending", async () => {
    expect(purchaseInvariants.map((c) => [c.code, c.severity, c.modes, c.heal])).toEqual([
      ["payment.I12", "P1", ["full"], "none"],
      ["payment.I14", "P1", ["full"], "none"],
      ["payment.I15", "P1", ["full"], "none"],
    ]);
    const a = await setup();
    expect(await run("payment.I14", a.entity.id)).toEqual([]);
    await h.prisma.transferProof.update({
      where: { id: a.proof.id },
      data: { reviewStatus: "superseded" },
    });
    expect(await run("payment.I14", a.entity.id)).toHaveLength(1);
    await h.prisma.billingOrder.update({
      where: { id: a.order.id },
      data: { status: "pending_payment", transferState: "awaiting_proof" },
    });
    await h.prisma.transferProof.update({
      where: { id: a.proof.id },
      data: { reviewStatus: "pending" },
    });
    expect(await run("payment.I14", a.entity.id)).toHaveLength(1);
  }, 60_000);
  it("I15 已采纳与恰一笔成功收款互为充分必要条件", async () => {
    const a = await setup("accepted");
    expect(await run("payment.I15", a.entity.id)).toHaveLength(1);
    await h.make.paymentTxn({
      channel: "bank_transfer",
      entityId: a.entity.id,
      billingOrderId: a.order.id,
      transferProofId: a.proof.id,
      confirmedByStaffId: a.staff.id,
      bankSerialRaw: "TEST-RECEIPT",
    });
    expect(await run("payment.I15", a.entity.id)).toEqual([]);
    await h.prisma.transferProof.update({
      where: { id: a.proof.id },
      data: { reviewStatus: "superseded" },
    });
    expect(await run("payment.I15", a.entity.id)).toHaveLength(1);
  }, 60_000);
});
