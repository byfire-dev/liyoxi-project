import { beforeAll, describe, expect, it } from "vitest";
import { createIdentityContext } from "../kernel/index.js";
import { openSealed, useSeededDatabase } from "../testing/index.js";
import { complete, harness, submit } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
const ctx = createIdentityContext({ actor: { type: "system", job: "lyxtest.profile_decision" } });
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
describe("资质审核领域回调", { timeout: 60000 }, () => {
  it("通过写齐认证字段、三链历史和双方事件", async () => {
    const { viewer } = await h.owner(),
      ready = await complete(h, viewer);
    await submit(h, viewer, ready.submissionId);
    await h.profile.approve(ctx, ready.submissionId, { lockVersion: 0, confirm: { roundNo: 1 } });
    const store = await h.prisma.store.findUniqueOrThrow({
      where: { id: viewer.membership.storeId },
    });
    const entity = await h.prisma.entity.findUniqueOrThrow({
      where: { id: viewer.membership.entityId },
    });
    const round = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: ready.submissionId },
    });
    expect(store.qualificationStatus).toBe("verified");
    expect(entity.verificationStatus).toBe("verified");
    expect(entity.name).toBe("测试认证主体");
    expect(openSealed("entity.uscc_enc", entity.usccEnc!)).toBe(ready.number);
    expect(openSealed("entity.legal_rep_name_enc", entity.legalRepNameEnc!)).toBe("张测试");
    expect(round.outcome).toBe("approved");
    expect(round.approveMode).toBe("normal");
    for (const id of [store.id, entity.id, round.approvalRequestId!])
      expect(await h.prisma.statusTransition.count({ where: { subjectId: id } })).toBe(2);
    expect(
      await h.prisma.outboxEvent.count({
        where: { eventType: "store.qualification.approved", aggregateId: store.id },
      }),
    ).toBe(1);
    expect(
      await h.prisma.outboxEvent.count({
        where: { eventType: "approval.approved", aggregateId: round.approvalRequestId! },
      }),
    ).toBe(1);
    const audit = await h.prisma.auditLog.findMany({
      where: { storeId: store.id, category: "review" },
    });
    expect(audit).toHaveLength(3); // 提交的门店迁移与审批各一行；决定联动仅审批的一行。
  });
  it("非终局驳回点名证照，补传后轮次加一；不可绕过被驳回证照替换", async () => {
    const { viewer } = await h.owner(),
      ready = await complete(h, viewer);
    await submit(h, viewer, ready.submissionId);
    await h.profile.reject(ctx, ready.submissionId, {
      confirm: { roundNo: 1 },
      reasonCodes: ["R01"],
      note: "证照模糊请补传",
      rejectedDocIds: [ready.docId],
    });
    expect(
      (await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: ready.docId } })).verdict,
    ).toBe("rejected");
    expect(
      (await h.prisma.store.findUniqueOrThrow({ where: { id: viewer.membership.storeId } }))
        .qualificationStatus,
    ).toBe("rejected");
    const draft = await h.profile.updateQualification(viewer, {
      lockVersion: null,
      declarationConfirmed: true,
      declarationVersion: "1",
    });
    expect(draft.openRound!.isResubmit).toBe(true);
    expect(draft.openRound!.claimedEntityType).toBe("enterprise");
    expect(draft.openRound!.docs).toHaveLength(0);
    const file = await h.make.fileObject({
      category: "kyc_license",
      bucket: "secure",
      scopeType: "entity",
      entityId: viewer.membership.entityId,
      uploadActorType: "merchant",
      uploadActorId: viewer.principal.merchantUserId,
      uploadClient: "weapp",
    });
    const doc = await h.profile.createDocument(viewer, {
      docType: "business_license",
      fileId: file.id,
    });
    await h.profile.updateDocument(viewer, doc.doc.qualificationDocId, {
      lockVersion: doc.lockVersion,
      fields: {
        name: "补传主体",
        uscc: ready.number,
        principal: "张测试",
        principalRole: "legal_rep",
        subjectType: "enterprise",
        validFrom: "2020-01-01",
        validTo: "long_term",
        address: "测试地址",
      },
    });
    await submit(h, viewer, draft.openRound!.qualificationSubmissionId);
    expect(
      (
        await h.prisma.qualificationSubmission.findUniqueOrThrow({
          where: { id: draft.openRound!.qualificationSubmissionId },
        })
      ).roundNo,
    ).toBe(2);
    expect(
      await h.prisma.outboxEvent.count({
        where: {
          eventType: "store.qualification.rejected",
          aggregateId: viewer.membership.storeId,
        },
      }),
    ).toBe(1);
  });
  it("轮次回显不一致及终局留桩均回滚审批决定", async () => {
    const { viewer } = await h.owner(),
      ready = await complete(h, viewer);
    await submit(h, viewer, ready.submissionId);
    await expect(
      h.profile.approve(ctx, ready.submissionId, { lockVersion: 0, confirm: { roundNo: 2 } }),
    ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    await expect(
      h.profile.reject(ctx, ready.submissionId, {
        confirm: { roundNo: 1 },
        reasonCodes: ["R01"],
        note: "不能补正",
        isFinal: true,
      }),
    ).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
      details: { reason: "final_reject_not_open" },
    });
    const round = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: ready.submissionId },
    });
    expect(round.closedAt).toBeNull();
    expect(
      (
        await h.prisma.approvalRequest.findUniqueOrThrow({
          where: { id: round.approvalRequestId! },
        })
      ).status,
    ).toBe("pending");
  });
});
