import { beforeAll, describe, expect, it } from "vitest";
import { QualificationDocRemoveResultSchema, QualificationViewOwnerSchema } from "@liyoxi/contract";
import { createIdentityContext } from "../kernel/index.js";
import { assembleForTest, TEST_KEYRING, useSeededDatabase } from "../testing/index.js";
import type { ProfileViewer } from "./context.js";
import { createProfile } from "./service.js";
import { complete, harness, ownedFile, submit } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";

const db = useSeededDatabase("services", { max: 1 });
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
const system = createIdentityContext({ actor: { type: "system", job: "lyxtest.draft_lifecycle" } });

async function newStore() {
  const user = await h.make.merchantUser();
  const entity = await h.make.entity({ createdByUserId: user.id, verificationStatus: "verified" });
  const store = await h.make.store({ entityId: entity.id });
  const member = await h.make.entityMember({
    entityId: entity.id,
    merchantUserId: user.id,
    role: "owner",
  });
  const viewer: ProfileViewer = {
    ctx: createIdentityContext({ actor: { type: "merchant", id: user.id, client: "weapp" } }),
    principal: {
      sessionId: user.id,
      merchantUserId: user.id,
      wechatIdentityId: user.id,
      consentStamp: "test",
    },
    membership: {
      memberId: member.id,
      entityId: entity.id,
      storeId: store.id,
      role: "owner",
      storeMode: "active",
    },
  };
  return { viewer, store, entity };
}
async function branch(viewer: ProfileViewer) {
  const file = await h.make.fileObject({
    category: "kyc_license",
    bucket: "secure",
    scopeType: "store",
    entityId: viewer.membership.entityId,
    storeId: viewer.membership.storeId,
    uploadActorType: "merchant",
    uploadActorId: viewer.principal.merchantUserId,
    uploadClient: "weapp",
  });
  return h.profile.createDocument(viewer, { docType: "branch_license", fileId: file.id });
}
async function approved() {
  const { viewer } = await h.owner();
  const ready = await complete(h, viewer);
  const extra = await branch(viewer);
  await h.profile.updateDocument(viewer, extra.doc.qualificationDocId, {
    lockVersion: extra.lockVersion,
    fields: {
      name: "测试分支机构",
      uscc: ready.number,
      principal: "张测试",
      principalRole: "branch_head",
      subjectType: "branch",
      validFrom: "2020-01-01",
      validTo: "long_term",
      address: "测试分支地址",
    },
  });
  await submit(h, viewer, ready.submissionId);
  await h.profile.approve(system, ready.submissionId, { lockVersion: 0, confirm: { roundNo: 1 } });
  return { viewer, ready, sourceId: extra.doc.qualificationDocId };
}
const ref = (id: string) =>
  h.prisma.fileRef.findFirstOrThrow({
    where: { refType: "qualification_doc", refId: id, role: "main" },
  });
async function state(viewer: ProfileViewer) {
  const { storeId } = viewer.membership;
  return {
    rounds: await h.prisma.qualificationSubmission.findMany({
      where: { storeId },
      orderBy: { id: "asc" },
    }),
    docs: await h.prisma.qualificationDoc.findMany({ where: { storeId }, orderBy: { id: "asc" } }),
    profile: await h.prisma.storeProfile.findUnique({ where: { storeId } }),
    refs: await h.prisma.fileRef.findMany({
      where: {
        refType: "qualification_doc",
        refId: {
          in: (
            await h.prisma.qualificationDoc.findMany({ where: { storeId }, select: { id: true } })
          ).map((d) => d.id),
        },
      },
      orderBy: { id: "asc" },
    }),
    audits: await h.prisma.auditLog.count({ where: { storeId } }),
    history: await h.prisma.statusTransition.count({ where: { subjectId: storeId } }),
    events: await h.prisma.outboxEvent.count({ where: { aggregateId: storeId } }),
  };
}

describe("W2-11 商家资质草稿生命周期关键数据库边界", { timeout: 60000 }, () => {
  it("change通过真实initial审批建立，带入生效门店证照；移除仅释放带入行而保留生效来源", async () => {
    const { viewer, sourceId, ready } = await approved();
    const source = await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: sourceId } });
    const sourceRef = await ref(sourceId);
    const draft = await h.profile.updateQualification(viewer, {
      lockVersion: null,
      claimedEntityType: "individual",
    });
    expect(draft.openRound).toMatchObject({
      kind: "change",
      claimedEntityType: null,
      docs: [{ origin: "carried", fileId: source.fileId }],
    });
    expect(draft.actions).toEqual(["discard"]);
    const carried = draft.openRound!.docs[0]!;
    const before = await state(viewer);
    const removed = QualificationDocRemoveResultSchema.parse(
      await h.profile.removeDocument(viewer, carried.qualificationDocId),
    );
    expect(removed).toMatchObject({
      qualificationDocId: carried.qualificationDocId,
      lockVersion: draft.openRound!.lockVersion + 1,
    });
    expect(await ref(carried.qualificationDocId)).toMatchObject({
      state: "released",
      keepUntil: new Date(h.clock.now().getTime() + 7 * 86400000),
    });
    expect(await ref(sourceId)).toEqual(sourceRef);
    expect(await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: sourceId } })).toEqual(
      source,
    );
    const after = await state(viewer);
    expect(after.profile?.effectiveQualificationSubmissionId).toBe(ready.submissionId);
    expect(after.history).toBe(before.history);
    expect(after.events).toBe(before.events);
    expect(after.audits).toBe(before.audits + 1);
    await expect(
      h.profile.removeDocument(viewer, carried.qualificationDocId),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  });

  it("discard change同时释放uploaded与carried引用，旧生效档案/证照与状态历史保持", async () => {
    const { viewer, sourceId } = await approved();
    const draft = await h.profile.updateQualification(viewer, { lockVersion: null });
    const license = await ownedFile(h, viewer, "kyc_license");
    const uploaded = await h.profile.createDocument(viewer, {
      docType: "business_license",
      fileId: license.id,
    });
    const before = await state(viewer);
    const view = QualificationViewOwnerSchema.parse(
      await h.profile.discardQualification(viewer, {
        qualificationSubmissionId: draft.openRound!.qualificationSubmissionId,
      }),
    );
    expect(view.openRound).toBeNull();
    expect(view.actions).toEqual([]);
    expect(view.effectiveDocs.map((d) => d.qualificationDocId)).toContain(sourceId);
    for (const id of [
      draft.openRound!.docs[0]!.qualificationDocId,
      uploaded.doc.qualificationDocId,
    ]) {
      expect(await ref(id)).toMatchObject({
        state: "released",
        keepUntil: new Date(h.clock.now().getTime() + 7 * 86400000),
      });
      expect(await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id } })).toMatchObject({
        removedAt: h.clock.now(),
        verdict: null,
        effectiveAt: null,
      });
    }
    expect(await ref(sourceId)).toMatchObject({ state: "live" });
    const after = await state(viewer);
    expect(after.profile?.effectiveQualificationSubmissionId).toBe(
      before.profile?.effectiveQualificationSubmissionId,
    );
    expect(after.profile?.lockVersion).toBe(before.profile?.lockVersion);
    expect(after.history).toBe(before.history);
    expect(after.events).toBe(before.events);
    expect(after.audits).toBe(before.audits + 1);
    expect(
      after.rounds.find((r) => r.id === draft.openRound!.qualificationSubmissionId),
    ).toMatchObject({
      outcome: "discarded",
      submittedAt: null,
      lockVersion: uploaded.lockVersion + 1,
    });
  });

  it("new_store公开草稿忽略主体类型、不接收营业执照；上传移除后可丢弃再建，旧id不误丢新草稿", async () => {
    const { viewer } = await newStore();
    const draft = await h.profile.updateQualification(viewer, {
      lockVersion: null,
      claimedEntityType: "enterprise",
    });
    expect(draft.openRound).toMatchObject({ kind: "new_store", claimedEntityType: null });
    const file = await ownedFile(h, viewer, "kyc_license");
    await expect(
      h.profile.createDocument(viewer, { fileId: file.id, docType: "business_license" }),
    ).rejects.toMatchObject({ error: "QUALIFICATION_DOC_NOT_ALLOWED" });
    const doc = await branch(viewer);
    await h.profile.removeDocument(viewer, doc.doc.qualificationDocId);
    await h.profile.discardQualification(viewer, {
      qualificationSubmissionId: draft.openRound!.qualificationSubmissionId,
    });
    const next = await h.profile.updateQualification(viewer, { lockVersion: null });
    expect(next.openRound!.qualificationSubmissionId).not.toBe(
      draft.openRound!.qualificationSubmissionId,
    );
    const before = await state(viewer);
    await expect(
      h.profile.discardQualification(viewer, {
        qualificationSubmissionId: draft.openRound!.qualificationSubmissionId,
      }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await expect(
      h.profile.updateQualification(viewer, { lockVersion: null }),
    ).rejects.toMatchObject({ error: "VERSION_CONFLICT" });
    expect(await state(viewer)).toEqual(before);
  });

  it("initial草稿不能丢弃；在审和已决定的真实证据不能移除，初次链守卫保留", async () => {
    const { viewer } = await h.owner();
    const ready = await complete(h, viewer);
    const initial = await state(viewer);
    await expect(
      h.profile.discardQualification(viewer, { qualificationSubmissionId: ready.submissionId }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(await state(viewer)).toEqual(initial);
    await submit(h, viewer, ready.submissionId);
    const pending = await state(viewer);
    await expect(h.profile.removeDocument(viewer, ready.docId)).rejects.toMatchObject({
      error: "QUALIFICATION_IN_REVIEW",
    });
    await expect(
      h.profile.discardQualification(viewer, { qualificationSubmissionId: ready.submissionId }),
    ).rejects.toMatchObject({ error: "QUALIFICATION_IN_REVIEW" });
    expect(await state(viewer)).toEqual(pending);
    await h.profile.approve(system, ready.submissionId, {
      lockVersion: 0,
      confirm: { roundNo: 1 },
    });
    const closed = await state(viewer);
    await expect(h.profile.removeDocument(viewer, ready.docId)).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    expect(await state(viewer)).toEqual(closed);
  });

  it("跨店/主体及过时成员、终局与未认证非首店失败零写", async () => {
    const a = await newStore(),
      b = await newStore();
    const draft = await h.profile.updateQualification(a.viewer, { lockVersion: null });
    const doc = await branch(a.viewer);
    const before = await state(a.viewer);
    await expect(
      h.profile.removeDocument(b.viewer, doc.doc.qualificationDocId),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    await expect(
      h.profile.discardQualification(b.viewer, {
        qualificationSubmissionId: draft.openRound!.qualificationSubmissionId,
      }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await h.prisma.entityMember.update({
      where: { id: a.viewer.membership.memberId },
      data: { role: "clerk" },
    });
    await expect(
      h.profile.removeDocument(a.viewer, doc.doc.qualificationDocId),
    ).rejects.toMatchObject({ error: "NOT_A_MEMBER" });
    expect(await state(a.viewer)).toEqual(before);
    await h.profile.updateQualification(b.viewer, { lockVersion: null });
    await h.prisma.storeProfile.update({
      where: { storeId: b.store.id },
      data: { finalRejectedAt: h.clock.now() },
    });
    await expect(h.profile.updateQualification(b.viewer, { lockVersion: 1 })).rejects.toMatchObject(
      { error: "QUALIFICATION_CLOSED" },
    );
    const initial = await h.owner();
    const sibling = await h.make.store({ entityId: initial.entity.id });
    await expect(
      h.profile.updateQualification(
        { ...initial.viewer, membership: { ...initial.viewer.membership, storeId: sibling.id } },
        { lockVersion: null },
      ),
    ).rejects.toMatchObject({ error: "ENTITY_NOT_VERIFIED" });
  });

  it("真实release后注入失败，remove/discard的行、引用、缓存与审计整事务回滚；缺引用明确失败", async () => {
    const { viewer } = await newStore();
    const doc = await branch(viewer);
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
        signRead: h.media.signRead,
        release: async (tx, input) => {
          await h.media.release(tx, input);
          throw new Error("release rollback fixture");
        },
      },
    });
    const before = await state(viewer);
    await expect(profile.removeDocument(viewer, doc.doc.qualificationDocId)).rejects.toThrow(
      "release rollback fixture",
    );
    expect(await state(viewer)).toEqual(before);
    await expect(
      profile.discardQualification(viewer, {
        qualificationSubmissionId: doc.qualificationSubmissionId,
      }),
    ).rejects.toThrow("release rollback fixture");
    expect(await state(viewer)).toEqual(before);
    await h.prisma.fileRef.delete({ where: { id: (await ref(doc.doc.qualificationDocId)).id } });
    const missing = await state(viewer);
    await expect(
      h.profile.removeDocument(viewer, doc.doc.qualificationDocId),
    ).rejects.toMatchObject({ error: "FILE_NOT_AVAILABLE" });
    expect(await state(viewer)).toEqual(missing);
  });
});
