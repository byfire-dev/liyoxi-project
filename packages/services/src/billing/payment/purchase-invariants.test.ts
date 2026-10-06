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
  it("I12 核对订单创建时已批准生效的最新银行版本，并保留历史正确版本", async () => {
    const { entity } = await h.make.merchant({ verified: true }),
      proposer = await h.make.staff(),
      reviewer = await h.make.staff(),
      now = h.clock.now(),
      createdAt = new Date(now.getTime() + 4 * 3_600_000);
    async function revision(configKey: "bank_account" | "purchase_policy", effectiveAt: Date) {
      const id = uuidv7(),
        decidedAt = new Date(
          effectiveAt.getTime() - (configKey === "bank_account" ? 86_400_000 : 0),
        );
      const approval = await h.prisma.approvalRequest.create({
        data: {
          id: uuidv7(),
          kind: "finance_config_change",
          category: "approval",
          subjectType: "finance_config_revision",
          subjectId: id,
          status: "approved",
          summarySnapshot: { title: "不变量测试配置" },
          submitActorType: "staff",
          submitActorId: proposer.id,
          submitClient: "admin",
          requesterStaffId: proposer.id,
          submittedAt: decidedAt,
          decidedAt,
          decidedByStaffId: reviewer.id,
          dedupeKey: `finance_config_change:${configKey}`,
          createdAt: decidedAt,
          updatedAt: decidedAt,
        },
      });
      return h.prisma.financeConfigRevision.create({
        data: {
          id,
          configKey,
          payload: {},
          changeNote: "不变量测试",
          ...(configKey === "bank_account"
            ? { accountNoEnc: "lyxtest.bank.enc", accountNoMask: "****1234" }
            : {}),
          approvalRequestId: approval.id,
          effectiveAt,
          createdAt: decidedAt,
        },
      });
    }
    const old = await revision("bank_account", new Date(now.getTime() + 2 * 3_600_000)),
      current = await revision("bank_account", new Date(now.getTime() + 3 * 3_600_000)),
      future = await revision("bank_account", new Date(createdAt.getTime() + 25 * 3_600_000)),
      policy = await revision("purchase_policy", now);
    const order = await h.make.billingOrder({
      entityId: entity.id,
      status: "pending_payment",
      channel: "bank_transfer",
      transferState: "awaiting_proof",
      bankAccountFinanceConfigRevisionId: current.id,
      createdAt,
    });
    expect(await run("payment.I12", entity.id)).toEqual([]);
    for (const invalid of [policy, future, old]) {
      await h.prisma.billingOrder.update({
        where: { id: order.id },
        data: { bankAccountFinanceConfigRevisionId: invalid.id },
      });
      expect(await run("payment.I12", entity.id)).toEqual([
        {
          subject: { type: "billing_order", id: order.id },
          entityId: entity.id,
          detail: { problem: "captured_bank_account_version" },
        },
      ]);
    }
    await h.prisma.billingOrder.update({
      where: { id: order.id },
      data: { bankAccountFinanceConfigRevisionId: current.id },
    });
    const approval = await h.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: current.approvalRequestId },
    });
    await h.prisma.approvalRequest.update({
      where: { id: approval.id },
      data: { decidedAt: new Date(createdAt.getTime() + 3_600_000) },
    });
    expect(await run("payment.I12", entity.id)).toMatchObject([
      {
        subject: { type: "billing_order", id: order.id },
        entityId: entity.id,
      },
    ]);
    await h.prisma.approvalRequest.update({
      where: { id: approval.id },
      data: { decidedAt: approval.decidedAt },
    });
    h.clock.set(new Date(future.effectiveAt!.getTime() + 1));
    try {
      expect(await run("payment.I12", entity.id)).toEqual([]);
    } finally {
      h.clock.set(now);
    }
  }, 60_000);
});
