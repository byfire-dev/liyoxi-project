import { beforeAll, describe, expect, it } from "vitest";
import { QualificationRecordSchema } from "@liyoxi/contract";
import { assertNotInTransaction, uuidv7 } from "../kernel/index.js";
import { assembleForTest, TEST_KEYRING, useSeededDatabase } from "../testing/index.js";
import { harness, ownedFile, complete, submit } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import type { ProfileViewer } from "./context.js";
import { createProfile } from "./service.js";
const db = useSeededDatabase("services", { max: 1 });
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);

// 仅造符合正式约束的已提交/草稿事实，不代替W2-11后续多轮写生命周期。
async function round(
  viewer: ProfileViewer,
  number: number | null,
  outcome: "approved" | "rejected" | "withdrawn" | "discarded" | null = null,
) {
  const now = h.clock.now(),
    submitted = number !== null;
  const approval = submitted
    ? await h.prisma.approvalRequest.create({
        data: {
          id: uuidv7(),
          kind: "qualification",
          category: "review",
          subjectType: "store",
          subjectId: viewer.membership.storeId,
          entityId: viewer.membership.entityId,
          storeId: viewer.membership.storeId,
          roundNo: number,
          status: outcome ?? "pending",
          summarySnapshot: { title: "资质历史读取夹具" },
          submitActorType: "merchant",
          submitActorId: viewer.principal.merchantUserId,
          submitClient: "weapp",
          submittedAt: now,
          decidedAt: outcome ? now : null,
          decidedByStaffId: outcome === "approved" ? (await h.make.staff()).id : null,
          isDecidedBySystem: outcome === "rejected",
          decisionNote: outcome === "rejected" ? "请重新上传许可证" : null,
          reasonCodes: outcome === "rejected" ? ["fixture_reason"] : [],
          dedupeKey: `qualification:${viewer.membership.storeId}`,
          createdAt: now,
          updatedAt: now,
        },
      })
    : null;
  return h.prisma.qualificationSubmission.create({
    data: {
      id: uuidv7(),
      entityId: viewer.membership.entityId,
      storeId: viewer.membership.storeId,
      kind: "initial",
      roundNo: number,
      claimedEntityType: submitted ? "enterprise" : null,
      proposedStoreName: submitted ? "测试门店" : null,
      proposedIndustryCode: submitted ? "C900" : null,
      proposedCategoryCode: submitted ? "C901" : null,
      ...(submitted ? { proposedAddressSnapshot: { detail: "测试路一号" } } : {}),
      declarationConfirmedAt: submitted ? now : null,
      declarationVersion: submitted ? "1" : null,
      approvalRequestId: approval?.id ?? null,
      submittedAt: submitted ? now : null,
      submittedByUserId: submitted ? viewer.principal.merchantUserId : null,
      closedAt: outcome ? now : null,
      outcome,
      approveMode: outcome === "approved" ? "normal" : null,
      createdByUserId: viewer.principal.merchantUserId,
      createdAt: now,
      updatedAt: now,
    },
  });
}
async function rawDoc(
  viewer: ProfileViewer,
  roundId: string,
  effective = false,
  fileOwner = viewer,
) {
  const file = await ownedFile(h, fileOwner, "kyc_license");
  h.fake.storage.put(
    { bucket: "secure", key: file.objectKey },
    new Uint8Array([255, 216, 255]),
    "image/jpeg",
  );
  const doc = await h.prisma.qualificationDoc.create({
    data: {
      id: uuidv7(),
      entityId: viewer.membership.entityId,
      storeId: viewer.membership.storeId,
      qualificationSubmissionId: roundId,
      docType: "business_license",
      scope: "entity",
      fileId: file.id,
      origin: "uploaded",
      uploadedByUserId: viewer.principal.merchantUserId,
      verdict: effective ? "accepted" : null,
      effectiveAt: effective ? h.clock.now() : null,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  await h.prisma.fileRef.create({
    data: {
      id: uuidv7(),
      fileId: file.id,
      refType: "qualification_doc",
      refId: doc.id,
      role: "main",
      state: "live",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  return { doc, file };
}
const accesses = (id: string) =>
  h.prisma.auditLog.count({ where: { targetId: id, action: "profile.document.url.sign" } });

describe("资质两个读取口的关键数据库边界", () => {
  it("历史只含已提交非discarded，按时间和ID稳定翻页、隔离店与主体且GET零写", async () => {
    const { viewer } = await h.owner();
    const first = await round(viewer, 1, "approved"),
      second = await round(viewer, 2, "rejected");
    await round(viewer, null, "discarded");
    await round(viewer, null);
    const other = await h.owner();
    await round(other.viewer, 1, "approved");
    const before = await h.prisma.qualificationSubmission.findMany({
      where: { storeId: viewer.membership.storeId },
    });
    const auditCount = await h.prisma.auditLog.count(),
      providerCalls = h.fake.storage.calls.length;
    const page1 = await h.profile.qualificationHistory(viewer, { limit: 1 });
    const page2 = await h.profile.qualificationHistory(viewer, {
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect([
      page1.items[0]!.qualificationSubmissionId,
      page2.items[0]!.qualificationSubmissionId,
    ]).toEqual([first.id, second.id].sort().reverse());
    expect(page1.hasMore).toBe(true);
    expect(page2).toMatchObject({ hasMore: false, nextCursor: null });
    expect(
      page2.items
        .concat(page1.items)
        .every((item) => QualificationRecordSchema.safeParse(item).success),
    ).toBe(true);
    expect(
      await h.prisma.qualificationSubmission.findMany({
        where: { storeId: viewer.membership.storeId },
      }),
    ).toEqual(before);
    expect(await h.prisma.auditLog.count()).toBe(auditCount);
    expect(h.fake.storage.calls).toHaveLength(providerCalls);
    await expect(
      h.profile.qualificationHistory(other.viewer, { cursor: page1.nextCursor! }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    await expect(
      h.profile.qualificationHistory(viewer, { cursor: "bad-json" }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  });
  it("历史从真实审批与证照投影驳回记录，不输出文件ID、联系人或加密原值", async () => {
    const { viewer } = await h.owner(),
      rejected = await round(viewer, 1, "rejected");
    const { doc } = await rawDoc(viewer, rejected.id);
    await h.prisma.qualificationDoc.update({
      where: { id: doc.id },
      data: { verdict: "rejected" },
    });
    const data = await h.profile.qualificationHistory(viewer, {}),
      item = data.items[0]!;
    expect(item).toMatchObject({
      outcome: "rejected",
      isDecidedBySystem: true,
      decisionNote: "请重新上传许可证",
      rejectReasons: [{ code: "fixture_reason", name: "fixture_reason" }],
      rejectedDocs: [{ qualificationDocId: doc.id, docType: "business_license", permitType: null }],
      uploadedDocs: [{ docType: "business_license", permitType: null }],
    });
    expect(item).not.toHaveProperty("fileId");
    expect(item).not.toHaveProperty("contactSnapshot");
    expect(item).not.toHaveProperty("submittedFieldsEnc");
  });
  it("真实草稿与在审证照每次现签5分钟并逐次访问留痕；签名在事务外", async () => {
    const { viewer } = await h.owner(),
      ready = await complete(h, viewer);
    const first = await h.profile.documentUrl(viewer, ready.docId);
    expect(new Date(first.expiresAt).getTime() - h.clock.now().getTime()).toBe(300_000);
    await submit(h, viewer, ready.submissionId);
    const second = await h.profile.documentUrl(viewer, ready.docId);
    expect(second.url).not.toBe(first.url);
    expect(await accesses(ready.docId)).toBe(2);
    expect(
      h.fake.storage
        .callsOf("presignGet")
        .slice(-2)
        .map((call) => call.input),
    ).toEqual([
      expect.objectContaining({ bucket: "secure", expiresSec: 300 }),
      expect.objectContaining({ bucket: "secure", expiresSec: 300 }),
    ]);
  }, 60000);
  it("仅本主体生效营业执照可跨店，未生效/外主体/闭合拒绝/移除/取代均不可枚举", async () => {
    const { viewer } = await h.owner(),
      approved = await round(viewer, 1, "approved");
    const { doc } = await rawDoc(viewer, approved.id, true);
    const sibling = await h.make.store({ entityId: viewer.membership.entityId });
    const siblingViewer = { ...viewer, membership: { ...viewer.membership, storeId: sibling.id } };
    expect((await h.profile.documentUrl(siblingViewer, doc.id)).url).toContain("fake-storage");
    const foreign = await h.owner();
    await expect(h.profile.documentUrl(foreign.viewer, doc.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    await h.prisma.qualificationDoc.update({
      where: { id: doc.id },
      data: { supersededAt: h.clock.now() },
    });
    await expect(h.profile.documentUrl(viewer, doc.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    const draft = await round(viewer, null),
      pending = await rawDoc(viewer, draft.id);
    await expect(h.profile.documentUrl(siblingViewer, pending.doc.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    await h.prisma.qualificationDoc.update({
      where: { id: pending.doc.id },
      data: { removedAt: h.clock.now() },
    });
    await expect(h.profile.documentUrl(viewer, pending.doc.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    const closed = await round(foreign.viewer, 1, "rejected"),
      old = await rawDoc(foreign.viewer, closed.id);
    await expect(h.profile.documentUrl(foreign.viewer, old.doc.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
  });
  it("真实文件主体污染、缺失live引用与店员均不签发也不写访问审计", async () => {
    const { viewer } = await h.owner(),
      foreign = await h.owner(),
      draft = await round(viewer, null);
    const polluted = await rawDoc(viewer, draft.id, false, foreign.viewer);
    const count = h.fake.storage.callsOf("presignGet").length;
    await expect(h.profile.documentUrl(viewer, polluted.doc.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    const validRound = await round(foreign.viewer, null);
    const valid = await rawDoc(foreign.viewer, validRound.id);
    await h.prisma.fileRef.deleteMany({ where: { refId: valid.doc.id } });
    await expect(h.profile.documentUrl(foreign.viewer, valid.doc.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    const clerk = {
      ...foreign.viewer,
      membership: { ...foreign.viewer.membership, role: "clerk" as const },
    };
    await expect(h.profile.documentUrl(clerk, valid.doc.id)).rejects.toMatchObject({
      error: "ROLE_FORBIDDEN",
    });
    await expect(h.profile.qualificationHistory(clerk, {})).rejects.toMatchObject({
      error: "ROLE_FORBIDDEN",
    });
    expect(h.fake.storage.callsOf("presignGet")).toHaveLength(count);
    expect(await accesses(valid.doc.id)).toBe(0);
  });
  it("签名失败零访问写；签名后引用或成员失效再次复核，丢弃地址而不审计成功", async () => {
    const { viewer } = await h.owner(),
      draft = await round(viewer, null),
      { doc } = await rawDoc(viewer, draft.id);
    h.fake.storage.failNext("presignGet");
    await expect(h.profile.documentUrl(viewer, doc.id)).rejects.toMatchObject({
      error: "PROVIDER_UNAVAILABLE",
    });
    expect(await accesses(doc.id)).toBe(0);
    let afterSign: () => Promise<unknown> = () =>
      h.prisma.qualificationDoc.update({
        where: { id: doc.id },
        data: { removedAt: h.clock.now() },
      });
    const profile = createProfile({
      tx: h.tx,
      clock: h.clock,
      assembly: assembleForTest({ entry: "api" }),
      tenant: h.tenant,
      approval: h.approval,
      events: h.events,
      keyring: () => TEST_KEYRING,
      wechat: h.fake.wechat,
      currentOpenid: async () => "test",
      media: {
        link: h.media.link,
        release: h.media.release,
        signRead: async (input) => {
          assertNotInTransaction("qualification download signer");
          const signed = await h.media.signRead(input);
          await afterSign();
          return signed;
        },
      },
    });
    await expect(profile.documentUrl(viewer, doc.id)).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(await accesses(doc.id)).toBe(0);
    const next = await h.owner(),
      nextRound = await round(next.viewer, null),
      nextDoc = await rawDoc(next.viewer, nextRound.id);
    afterSign = () =>
      h.prisma.entityMember.update({
        where: { id: next.viewer.membership.memberId },
        data: { role: "clerk" },
      });
    await expect(profile.documentUrl(next.viewer, nextDoc.doc.id)).rejects.toMatchObject({
      error: "NOT_A_MEMBER",
    });
    expect(await accesses(nextDoc.doc.id)).toBe(0);
    await expect(profile.qualificationHistory(next.viewer, {})).rejects.toMatchObject({
      error: "NOT_A_MEMBER",
    });
  });
});
