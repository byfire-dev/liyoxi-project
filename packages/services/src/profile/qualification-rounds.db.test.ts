import { beforeAll, describe, expect, it } from "vitest";
import { PendingChangeSchema, QualificationViewOwnerSchema } from "@liyoxi/contract";
import {
  assembleForTest,
  TEST_KEYRING,
  useSeededDatabase,
  createRecordingPorts,
} from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { harness, submit } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import {
  qualified,
  newStoreReady,
  branchReady,
  changeName,
  replacementLicense,
  reviewer,
} from "./__fixtures__/rounds.js";
import { findViolations } from "./invariants.js";
import { createProfile } from "./service.js";
const db = useSeededDatabase("services", { max: 1 });
const ports = createRecordingPorts();
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma(), [ports.registration]);
}, 120000);
const getRound = (id: string) =>
  h.prisma.qualificationSubmission.findUniqueOrThrow({ where: { id } });
const getStore = (id: string) => h.prisma.store.findUniqueOrThrow({ where: { id } });
const refs = (id: string) =>
  h.prisma.fileRef.findMany({ where: { refType: "qualification_doc", refId: id } });

describe("W2-11 多轮资质完整业务链", { timeout: 60000 }, () => {
  it("change名称/地址/行业先pending，提交摘要用待审值；批准才写回且不覆盖免审选点", async () => {
    const w = await qualified(h),
      before = await h.profile.basic(w.viewer);
    await h.prisma.dictItem.create({
      data: {
        id: uuidv7(),
        dictTypeKey: "industry",
        code: "C902",
        name: "第二测试品类",
        parentCode: "C900",
        ext: { open: true, special: false, requiredCerts: [] },
        isEnabled: true,
        position: 1000,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const body = {
      draft: true,
      lockVersion: before.lockVersion,
      storeName: "审批后门店",
      industryCode: "C900",
      categoryCode: "C902",
      address: {
        provinceCode: "110000",
        cityCode: "110100",
        districtCode: "110101",
        zoneCode: null,
        detail: "审批后地址",
        poiName: "本次选点",
        latitude: 39.1,
        longitude: 116.1,
      },
    };
    await expect(h.profile.updateBasic(w.viewer, body)).rejects.toMatchObject({
      error: "REVIEW_REQUIRED",
    });
    expect((await h.profile.qualification(w.viewer)).openRound).toBeNull();
    const saved = await h.profile.updateBasic(w.viewer, { ...body, confirmReview: true });
    const pending = PendingChangeSchema.parse(saved.pendingChange);
    expect(saved).toMatchObject({
      storeName: before.storeName,
      category: before.category,
      address: { detail: before.address.detail, poiName: "本次选点" },
    });
    expect(pending).toMatchObject({
      storeName: "审批后门店",
      category: { code: "C902" },
      address: { detail: "审批后地址" },
      phase: "draft",
    });
    const q = await submit(h, w.viewer, pending.qualificationSubmissionId);
    expect(q).toMatchObject({
      isChangeInReview: true,
      storeQualificationStatus: "verified",
      actions: [],
    });
    expect(q.openRound!.changedFields).toEqual(["store_name", "industry", "address"]);
    const round = await getRound(pending.qualificationSubmissionId);
    expect(
      await h.prisma.approvalRequest.findUniqueOrThrow({ where: { id: round.approvalRequestId! } }),
    ).toMatchObject({ summarySnapshot: { title: "审批后门店" } });
    await expect(changeName(h, w.viewer, "在审再改名")).rejects.toMatchObject({
      error: "QUALIFICATION_IN_REVIEW",
    });
    await h.profile.updateBasic(w.viewer, {
      draft: true,
      lockVersion: saved.lockVersion,
      brandIntro: "审核期间免审简介",
    });
    await h.profile.approve(reviewer, round.id, { lockVersion: 0, confirm: { roundNo: 2 } });
    expect(await h.profile.basic(w.viewer)).toMatchObject({
      storeName: "审批后门店",
      category: { code: "C902" },
      address: { detail: "审批后地址", poiName: "本次选点" },
      brandIntro: "审核期间免审简介",
      pendingChange: null,
    });
    expect(await h.prisma.statusTransition.count({ where: { subjectId: w.entity.id } })).toBe(2);
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: w.store.id, event: { startsWith: "qualification.change_" } },
      }),
    ).toBe(2);
    expect(
      await h.prisma.outboxEvent.findMany({
        where: { aggregateId: w.store.id, eventType: "store.profile.changed" },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            source: "review_writeback",
            fields: ["store_name", "industry", "address"],
          }),
        }),
      ]),
    );
  });

  it("change驳回保留旧合法值和全部提交证据；新一轮可重新提审并保持真实历史", async () => {
    const w = await qualified(h),
      before = await getStore(w.store.id);
    const first = await changeName(h, w.viewer);
    const id = first.pendingChange!.qualificationSubmissionId;
    await submit(h, w.viewer, id);
    await expect(
      h.profile.reject(reviewer, id, {
        confirm: { roundNo: 2 },
        reasonCodes: ["R01"],
        note: "不能终局",
        isFinal: true,
      }),
    ).rejects.toMatchObject({ error: "QUALIFICATION_FINAL_NOT_ALLOWED" });
    await h.profile.reject(reviewer, id, {
      confirm: { roundNo: 2 },
      reasonCodes: ["R01"],
      note: "名称需补正",
    });
    expect((await getStore(w.store.id)).name).toBe(before.name);
    expect(await getRound(id)).toMatchObject({
      outcome: "rejected",
      changedFields: ["store_name"],
      proposedStoreName: "变更后测试门店",
    });
    expect((await h.profile.qualification(w.viewer)).lastClosedRound).toMatchObject({
      kind: "change",
      outcome: "rejected",
      proposed: { phase: "closed" },
    });
    const next = await changeName(h, w.viewer, "补正后的新名称");
    await submit(h, w.viewer, next.pendingChange!.qualificationSubmissionId);
    await h.profile.approve(reviewer, next.pendingChange!.qualificationSubmissionId, {
      lockVersion: 0,
      confirm: { roundNo: 3 },
    });
    expect(
      (await h.profile.qualificationHistory(w.viewer, {})).items.map((r) => r.roundNo),
    ).toEqual([3, 2, 1]);
    expect(await refs(w.ready.docId)).toMatchObject([{ state: "live" }]);
    expect((await getStore(w.store.id)).name).toBe("补正后的新名称");
  });

  it("new_store本店证照驳回后须真实补传再提交，批准不覆盖主体执照并只直记首次提交", async () => {
    const w = await qualified(h),
      entityBefore = await h.prisma.entity.findUniqueOrThrow({ where: { id: w.entity.id } });
    const next = await newStoreReady(h, w.viewer),
      branch = await branchReady(h, next.viewer);
    await submit(h, next.viewer, next.roundId);
    expect(await getRound(next.roundId)).toMatchObject({
      kind: "new_store",
      roundNo: 1,
      claimedEntityType: null,
    });
    await h.profile.reject(reviewer, next.roundId, {
      confirm: { roundNo: 1 },
      reasonCodes: ["R01"],
      note: "分支执照模糊",
      rejectedDocIds: [branch.doc.qualificationDocId],
    });
    const again = await h.profile.updateQualification(next.viewer, { lockVersion: null });
    expect(again.openRound).toMatchObject({ kind: "new_store", isResubmit: true, docs: [] });
    await expect(
      submit(h, next.viewer, again.openRound!.qualificationSubmissionId),
    ).rejects.toMatchObject({ error: "QUALIFICATION_DOCS_INCOMPLETE" });
    await branchReady(h, next.viewer);
    await submit(h, next.viewer, again.openRound!.qualificationSubmissionId);
    await h.profile.approve(reviewer, again.openRound!.qualificationSubmissionId, {
      lockVersion: 0,
      confirm: { roundNo: 2 },
    });
    expect((await getStore(next.store.id)).qualificationStatus).toBe("verified");
    expect(await h.prisma.entity.findUniqueOrThrow({ where: { id: w.entity.id } })).toEqual(
      entityBefore,
    );
    expect(
      await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: w.ready.docId } }),
    ).toMatchObject({ supersededAt: null });
    expect(await refs(w.ready.docId)).toMatchObject([{ state: "live" }]);
    expect(await refs(branch.doc.qualificationDocId)).toMatchObject([{ state: "live" }]);
    expect(
      ports.tracked.filter(
        (e) => e.name === "store_add_submit" && e.subject?.storeId === next.store.id,
      ),
    ).toHaveLength(1);
  });

  it("无变化change拒绝且没有空审批；缺本次声明同样零提交", async () => {
    const w = await qualified(h);
    const q = await h.profile.updateQualification(w.viewer, { lockVersion: null });
    expect(QualificationViewOwnerSchema.parse(q).actions).toEqual(["submit", "discard"]);
    await expect(submit(h, w.viewer, q.openRound!.qualificationSubmissionId)).rejects.toMatchObject(
      { error: "QUALIFICATION_NO_CHANGE" },
    );
    const saved = await changeName(h, w.viewer);
    await expect(
      h.profile.submit(w.viewer, {
        qualificationSubmissionId: saved.pendingChange!.qualificationSubmissionId,
        declarationConfirmed: false,
        declarationVersion: "1",
      }),
    ).rejects.toMatchObject({ error: "DECLARATION_REQUIRED" });
    expect(await getRound(q.openRound!.qualificationSubmissionId)).toMatchObject({
      submittedAt: null,
      approvalRequestId: null,
    });
    expect(await h.prisma.approvalRequest.count({ where: { storeId: w.store.id } })).toBe(1);
  });

  it("更换主体执照须主体类型；通过仅更新认证字段，旧执照被取代但引用/首次认证时间保留", async () => {
    const w = await qualified(h),
      entityBefore = await h.prisma.entity.findUniqueOrThrow({ where: { id: w.entity.id } });
    const license = await replacementLicense(h, w.viewer);
    const current = (await h.profile.qualification(w.viewer)).openRound!;
    await h.profile.updateQualification(w.viewer, {
      lockVersion: current.lockVersion,
      claimedEntityType: null,
    });
    await expect(submit(h, w.viewer, current.qualificationSubmissionId)).rejects.toMatchObject({
      error: "STORE_PROFILE_INCOMPLETE",
      details: {
        missing: expect.arrayContaining([{ step: 4, item: "entity_type", permitType: null }]),
      },
    });
    await h.profile.updateQualification(w.viewer, {
      lockVersion: current.lockVersion + 1,
      claimedEntityType: "enterprise",
    });
    await submit(h, w.viewer, current.qualificationSubmissionId);
    await h.profile.approve(reviewer, current.qualificationSubmissionId, {
      lockVersion: 0,
      confirm: { roundNo: 2 },
    });
    const after = await h.prisma.entity.findUniqueOrThrow({ where: { id: w.entity.id } });
    expect(after).toMatchObject({
      verificationStatus: "verified",
      name: "变更后的测试主体",
      verifiedAt: entityBefore.verifiedAt,
    });
    expect(after.usccBidx).not.toEqual(entityBefore.usccBidx);
    expect(
      await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: w.ready.docId } }),
    ).toMatchObject({ supersededAt: h.clock.now() });
    expect(
      await h.prisma.qualificationDoc.findUniqueOrThrow({
        where: { id: license.doc.qualificationDocId },
      }),
    ).toMatchObject({ effectiveAt: h.clock.now(), verdict: "accepted" });
    expect(await refs(w.ready.docId)).toMatchObject([{ state: "live" }]);
    expect(await h.tx.run((tx) => findViolations(tx, "I4", { entityIds: [w.entity.id] }))).toEqual(
      [],
    );
  });

  it("主体执照在审互斥M108：另一店草稿不能同时提交/再次挂执照；被拒轮次保持完整", async () => {
    const w = await qualified(h),
      next = await newStoreReady(h, w.viewer);
    await submit(h, next.viewer, next.roundId);
    await h.profile.approve(reviewer, next.roundId, { lockVersion: 0, confirm: { roundNo: 1 } });
    const a = await replacementLicense(h, w.viewer),
      b = await replacementLicense(h, next.viewer);
    await submit(h, w.viewer, a.qualificationSubmissionId);
    await expect(submit(h, next.viewer, b.qualificationSubmissionId)).rejects.toMatchObject({
      error: "ENTITY_LICENSE_CHANGE_PENDING",
    });
    await expect(replacementLicense(h, next.viewer)).rejects.toMatchObject({
      error: "ENTITY_LICENSE_CHANGE_PENDING",
    });
    expect(await getRound(b.qualificationSubmissionId)).toMatchObject({
      submittedAt: null,
      approvalRequestId: null,
    });
    await h.profile.reject(reviewer, a.qualificationSubmissionId, {
      confirm: { roundNo: 2 },
      reasonCodes: ["R01"],
      note: "请补正执照",
    });
    await submit(h, next.viewer, b.qualificationSubmissionId);
    expect(await getRound(b.qualificationSubmissionId)).toMatchObject({
      roundNo: 2,
      closedAt: null,
    });
  });

  it("历史批准轮次不能重写名称；缺少真实轮次的tenant多轮出口不可用", async () => {
    const w = await qualified(h),
      saved = await changeName(h, w.viewer);
    const id = saved.pendingChange!.qualificationSubmissionId;
    await submit(h, w.viewer, id);
    await h.profile.approve(reviewer, id, { lockVersion: 0, confirm: { roundNo: 2 } });
    await expect(
      h.tx.run((tx) =>
        h.tenant.renameStore(tx, reviewer, {
          storeId: w.store.id,
          name: "变更后测试门店",
          submissionId: id,
        }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await expect(
      h.tx.run((tx) =>
        h.tenant.setStoreQualification(tx, reviewer, {
          storeId: w.store.id,
          round: "change",
          action: "approve",
        }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  });

  it("新行业要求的证照按pending品类校验；批准后事件注入失败，审批/名称/档案/证照整笔回滚", async () => {
    const w = await qualified(h),
      basic = await h.profile.basic(w.viewer);
    const permit = await h.prisma.dictItem.findFirstOrThrow({
      where: { dictTypeKey: "permit_type" },
    });
    await h.prisma.dictItem.create({
      data: {
        id: uuidv7(),
        dictTypeKey: "industry",
        code: "C903",
        name: "需证照测试品类",
        parentCode: "C900",
        ext: { open: true, special: false, requiredCerts: [permit.code] },
        isEnabled: true,
        position: 1001,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const category = await h.profile.updateBasic(w.viewer, {
      draft: true,
      lockVersion: basic.lockVersion,
      confirmReview: true,
      industryCode: "C900",
      categoryCode: "C903",
    });
    await expect(
      submit(h, w.viewer, category.pendingChange!.qualificationSubmissionId),
    ).rejects.toMatchObject({ error: "QUALIFICATION_DOCS_INCOMPLETE" });
    const saved = await h.profile.updateBasic(w.viewer, {
      draft: true,
      lockVersion: category.lockVersion,
      confirmReview: true,
      storeName: "将回滚名称",
      industryCode: "C900",
      categoryCode: "C901",
    });
    const id = saved.pendingChange!.qualificationSubmissionId;
    await submit(h, w.viewer, id);
    const before = {
      round: await getRound(id),
      store: await getStore(w.store.id),
      profile: await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: w.store.id } }),
      audits: await h.prisma.auditLog.count({ where: { storeId: w.store.id } }),
    };
    const profile = createProfile({
      tx: h.tx,
      clock: h.clock,
      assembly: assembleForTest({ entry: "api" }),
      tenant: h.tenant,
      approval: h.approval,
      events: {
        ...h.events,
        emit: async (tx, ctx, input) => {
          if (input.type === "store.qualification_change.approved")
            throw new Error("round rollback fixture");
          return h.events.emit(tx, ctx, input);
        },
      },
      media: h.media,
      keyring: () => TEST_KEYRING,
      wechat: h.fake.wechat,
      currentOpenid: async () => "test",
    });
    await expect(
      profile.approve(reviewer, id, { lockVersion: 0, confirm: { roundNo: 2 } }),
    ).rejects.toThrow("round rollback fixture");
    expect(await getRound(id)).toEqual(before.round);
    expect(await getStore(w.store.id)).toEqual(before.store);
    expect(
      await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: w.store.id } }),
    ).toEqual(before.profile);
    expect(await h.prisma.auditLog.count({ where: { storeId: w.store.id } })).toBe(before.audits);
    expect(
      await h.prisma.approvalRequest.findUniqueOrThrow({
        where: { id: before.round.approvalRequestId! },
      }),
    ).toMatchObject({ status: "pending" });
  });
});
