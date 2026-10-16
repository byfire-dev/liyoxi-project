import { expect, it } from "vitest";
import { createLedgerHarness, useSeededDatabase } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { findI1Violations } from "./invariants.js";

const db = useSeededDatabase("services", { max: 1 });
const kinds = new Map([
  [
    "transfer_confirm",
    {
      domain: { table: "transfer_proof", column: "review_approval_request_id" },
      hasExecution: false,
    },
  ],
]);

it("回单历史拒绝轮保留真实归属；旧在审/通过、错主体、指针退回与孤儿仍报错", async () => {
  const prisma = await db.prisma();
  const h = createLedgerHarness(prisma);
  const who = await h.make.merchant();
  const staff = await h.make.staff();
  const order = await h.make.billingOrder({ entityId: who.entity.id, status: "pending_payment" });
  const file = await h.make.fileObject();
  const proofId = uuidv7();
  const now = h.clock.now();
  // 巡检专用真实库夹具；故意破坏归属的反例不冒充正式审批业务验收。
  const approval = async (roundNo: number, status: "rejected" | "pending", subjectId = proofId) =>
    prisma.approvalRequest.create({
      data: {
        id: uuidv7(),
        kind: "transfer_confirm",
        category: "approval",
        subjectType: "transfer_proof",
        subjectId,
        entityId: who.entity.id,
        roundNo,
        status,
        summarySnapshot: { title: "回单复核测试" },
        submitActorType: "staff",
        submitActorId: staff.id,
        submitClient: "admin",
        requesterStaffId: staff.id,
        submittedAt: now,
        dedupeKey: `transfer_confirm:${subjectId}`,
        ...(status === "rejected"
          ? { isDecidedBySystem: true, decidedAt: now, decisionNote: "测试退回" }
          : {}),
        createdAt: now,
        updatedAt: now,
      },
    });
  const previous = await approval(1, "rejected");
  const current = await approval(2, "pending");
  await prisma.transferProof.create({
    data: {
      id: proofId,
      entityId: who.entity.id,
      billingOrderId: order.id,
      uploadNo: 1,
      fileId: file.id,
      uploadedByStaffId: staff.id,
      uploadedAt: now,
      reviewStatus: "pending",
      reviewApprovalRequestId: current.id,
      createdAt: now,
      updatedAt: now,
    },
  });
  const ids = async () =>
    (await findI1Violations(prisma, kinds))
      .map((v) => {
        expect(v.detail.problem).toBe("domain_row_count");
        return v.subject && "id" in v.subject ? v.subject.id : null;
      })
      .sort();
  expect(await ids()).toEqual([]);
  await prisma.approvalRequest.update({ where: { id: previous.id }, data: { status: "approved" } });
  expect(await ids()).toEqual([previous.id]);
  await prisma.approvalRequest.update({
    where: { id: current.id },
    data: { status: "rejected", decidedAt: now, isDecidedBySystem: true, decisionNote: "测试退回" },
  });
  await prisma.approvalRequest.update({
    where: { id: previous.id },
    data: { status: "pending", decidedAt: null, isDecidedBySystem: false },
  });
  expect(await ids()).toEqual([previous.id]);
  await prisma.approvalRequest.update({
    where: { id: previous.id },
    data: { status: "rejected", decidedAt: now, isDecidedBySystem: true },
  });
  await prisma.approvalRequest.update({
    where: { id: current.id },
    data: { status: "pending", decidedAt: null, isDecidedBySystem: false },
  });
  await prisma.transferProof.update({
    where: { id: proofId },
    data: { reviewApprovalRequestId: previous.id },
  });
  expect(await ids()).toEqual([previous.id, current.id].sort());
  await prisma.transferProof.update({
    where: { id: proofId },
    data: { reviewApprovalRequestId: current.id },
  });
  expect(await ids()).toEqual([]);
  const orphan = await approval(1, "rejected", uuidv7());
  expect(await ids()).toEqual([orphan.id]);
  const other = await h.make.entity();
  const otherOrder = await h.make.billingOrder({ entityId: other.id, status: "pending_payment" });
  const wrongProofId = uuidv7();
  const wrongScope = await approval(1, "pending", wrongProofId);
  // 归属是不可变列，另造错归属关系；不删原凭证、不关闭触发器或修改不可变字段。
  await prisma.transferProof.create({
    data: {
      id: wrongProofId,
      entityId: other.id,
      billingOrderId: otherOrder.id,
      uploadNo: 1,
      fileId: file.id,
      uploadedByStaffId: staff.id,
      uploadedAt: now,
      reviewStatus: "pending",
      reviewApprovalRequestId: wrongScope.id,
      createdAt: now,
      updatedAt: now,
    },
  });
  expect(await ids()).toEqual([orphan.id, wrongScope.id].sort());
}, 30_000);
