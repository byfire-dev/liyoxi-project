import { beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { complete, harness, submit } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
describe("资质提交十项校验", { timeout: 60000 }, () => {
  it.each([
    [1, "brand_name"],
    [2, "door_photos"],
    [3, "selling_points"],
    [4, "contact"],
  ] as const)("第 %s 步缺 %s：错误定位并可补齐提交", async (step, item) => {
    const { viewer } = await h.owner(),
      ready = await complete(h, viewer);
    const id = viewer.membership.storeId;
    if (step === 1)
      await h.prisma.storeProfile.update({ where: { storeId: id }, data: { brandName: null } });
    if (step === 2)
      await h.prisma.storeProfileMedia.updateMany({
        where: { storeId: id, mediaGroup: "door" },
        data: { removedAt: h.clock.now() },
      });
    if (step === 3)
      await h.prisma.storeProfile.update({
        where: { storeId: id },
        data: { sellingPointCodes: [] },
      });
    if (step === 4)
      await h.prisma.storeProfile.update({ where: { storeId: id }, data: { contactName: null } });
    await expect(submit(h, viewer, ready.submissionId)).rejects.toMatchObject({
      error: "STORE_PROFILE_INCOMPLETE",
      details: { missing: expect.arrayContaining([{ step, item, permitType: null }]) },
    });
    if (step === 1)
      await h.prisma.storeProfile.update({
        where: { storeId: id },
        data: { brandName: "补齐品牌" },
      });
    if (step === 2)
      await h.prisma.storeProfileMedia.updateMany({
        where: { storeId: id, mediaGroup: "door" },
        data: { removedAt: null },
      });
    if (step === 3)
      await h.prisma.storeProfile.update({
        where: { storeId: id },
        data: { sellingPointCodes: ["SP99"] },
      });
    if (step === 4)
      await h.prisma.storeProfile.update({
        where: { storeId: id },
        data: { contactName: "补齐联系人" },
      });
    const result = await submit(h, viewer, ready.submissionId);
    expect(result.openRound!.phase).toBe("in_review");
    expect(
      await h.prisma.statusTransition.count({
        where: {
          subjectId: {
            in: [viewer.membership.entityId, id, result.openRound!.qualificationSubmissionId],
          },
        },
      }),
    ).toBe(2);
  });
  it("正确认证草稿提交，摘要无号码，审批及租户三链同事务", async () => {
    const { viewer } = await h.owner(),
      ready = await complete(h, viewer);
    const q = await submit(h, viewer, ready.submissionId);
    const round = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: ready.submissionId },
    });
    const approval = await h.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: round.approvalRequestId! },
    });
    expect(approval.status).toBe("pending");
    expect(approval.roundNo).toBe(1);
    expect(approval.dueAt).toBeNull();
    expect(JSON.stringify(approval.summarySnapshot)).not.toContain(ready.number);
    expect(q.openRound!.phase).toBe("in_review");
    expect(round.checkSummary).toMatchObject({ fail: 0, warn: 0, manual: 1 });
    expect(
      await h.prisma.outboxEvent.count({
        where: {
          eventType: "store.qualification.submitted",
          aggregateId: viewer.membership.storeId,
        },
      }),
    ).toBe(1);
    expect(await h.prisma.statusTransition.count({ where: { subjectId: approval.id } })).toBe(1);
  });
  it("草稿取消确认后，本次提交的合法确认即可进入在审并写本次时间", async () => {
    const { viewer } = await h.owner(),
      ready = await complete(h, viewer);
    const round = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: ready.submissionId },
    });
    const draft = await h.profile.updateQualification(viewer, {
      lockVersion: round.lockVersion,
      declarationConfirmed: false,
    });
    expect(draft.openRound!.declarationConfirmedAt).toBeNull();
    expect((await h.profile.get(viewer)).completeness.steps[3]!.missing).toEqual([
      { item: "declaration", permitType: null },
    ]);
    h.clock.advance(60_000);
    await submit(h, viewer, ready.submissionId);
    const submitted = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: ready.submissionId },
    });
    expect(submitted.declarationConfirmedAt).toEqual(h.clock.now());
    expect(submitted.declarationVersion).toBe("1");
    expect(submitted.submittedAt).toEqual(h.clock.now());
    expect(
      await h.prisma.storeProfile.findUniqueOrThrow({
        where: { storeId: viewer.membership.storeId },
      }),
    ).toMatchObject({ completenessPct: 100, requiredFilled: 15, requiredTotal: 15 });
  });
  it.each([
    [false, "1"],
    [true, "old"],
  ] as const)(
    "草稿取消确认，本次 %s/%s 拒绝且不提交",
    async (declarationConfirmed, declarationVersion) => {
      const { viewer } = await h.owner(),
        ready = await complete(h, viewer);
      const round = await h.prisma.qualificationSubmission.findUniqueOrThrow({
        where: { id: ready.submissionId },
      });
      await h.profile.updateQualification(viewer, {
        lockVersion: round.lockVersion,
        declarationConfirmed: false,
      });
      await expect(
        h.profile.submit(viewer, {
          qualificationSubmissionId: ready.submissionId,
          declarationConfirmed,
          declarationVersion,
        }),
      ).rejects.toMatchObject({ error: "DECLARATION_REQUIRED" });
      expect(
        await h.prisma.qualificationSubmission.findUniqueOrThrow({
          where: { id: ready.submissionId },
        }),
      ).toMatchObject({
        submittedAt: null,
        declarationConfirmedAt: null,
        declarationVersion: null,
      });
    },
  );
  it("当前行业关闭、证照未手填、声明版本、已认证重复代码依次拒绝且仍草稿", async () => {
    const { viewer } = await h.owner(),
      ready = await complete(h, viewer);
    await h.prisma.dictItem.update({
      where: { dictTypeKey_code: { dictTypeKey: "industry", code: "C901" } },
      data: { ext: { open: false, special: false, requiredCerts: [] } },
    });
    await expect(submit(h, viewer, ready.submissionId)).rejects.toMatchObject({
      error: "INDUSTRY_NOT_OPEN",
    });
    await h.prisma.dictItem.update({
      where: { dictTypeKey_code: { dictTypeKey: "industry", code: "C901" } },
      data: { ext: { open: true, special: false, requiredCerts: [] } },
    });
    const doc = await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: ready.docId } });
    await h.prisma.qualificationDoc.update({
      where: { id: ready.docId },
      data: { submittedFieldsEnc: null },
    });
    await expect(submit(h, viewer, ready.submissionId)).rejects.toMatchObject({
      error: "QUALIFICATION_DOCS_INCOMPLETE",
    });
    await h.prisma.qualificationDoc.update({
      where: { id: ready.docId },
      data: { submittedFieldsEnc: doc.submittedFieldsEnc },
    });
    await expect(
      h.profile.submit(viewer, {
        qualificationSubmissionId: ready.submissionId,
        declarationConfirmed: true,
        declarationVersion: "old",
      }),
    ).rejects.toMatchObject({ error: "DECLARATION_REQUIRED" });
    await h.make.entity({ verificationStatus: "verified", uscc: ready.number });
    await expect(submit(h, viewer, ready.submissionId)).rejects.toMatchObject({
      error: "USCC_TAKEN",
    });
    expect(
      (
        await h.prisma.qualificationSubmission.findUniqueOrThrow({
          where: { id: ready.submissionId },
        })
      ).submittedAt,
    ).toBeNull();
  });
});
it("历史已选字典停用仍展示名称并保留，但新选同码拒绝", { timeout: 60000 }, async () => {
  const { viewer } = await h.owner(),
    ready = await complete(h, viewer);
  await h.prisma.dictItem.update({
    where: { dictTypeKey_code: { dictTypeKey: "industry", code: "C901" } },
    data: { isEnabled: false },
  });
  try {
    expect((await h.profile.basic(viewer)).category).toEqual({
      code: "C901",
      name: "测试开放品类",
    });
    await submit(h, viewer, ready.submissionId);
    const second = await h.owner();
    await expect(
      h.profile.updateBasic(second.viewer, {
        draft: true,
        lockVersion: 0,
        industryCode: "C900",
        categoryCode: "C901",
      }),
    ).rejects.toMatchObject({
      error: "DICT_ITEM_DISABLED",
      details: { dictTypeKey: "industry", code: "C901" },
    });
  } finally {
    await h.prisma.dictItem.update({
      where: { dictTypeKey_code: { dictTypeKey: "industry", code: "C901" } },
      data: { isEnabled: true },
    });
  }
});
