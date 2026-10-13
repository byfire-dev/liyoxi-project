import { createSessionMutexConnectionFactory } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as audit from "../audit/index.js";
import {
  AppError,
  createIdempotencyContext,
  createIdentityContext,
  createSessionMutex,
  uuidv7,
} from "../kernel/index.js";
import { createMedia } from "../media/index.js";
import type { OcrProvider } from "../providers/types.js";
import { decryptField } from "../security/index.js";
import {
  assembleForTest,
  assertSnapshotsEqual,
  sampleStaffContext,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";
import { complete, harness, ownedFile, uscc } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import type { ProfileViewer } from "./context.js";
import { createProfile } from "./service.js";
import { onFileModerated } from "./file-moderated.js";
import { registration } from "./register.js";

const db = useSeededDatabase("services", { label: "kycprofile", max: 1 });
let h: Harness, mutex: ReturnType<typeof createSessionMutex>;
beforeAll(async () => {
  h = harness(await db.prisma());
  mutex = createSessionMutex({
    connect: createSessionMutexConnectionFactory({ connectionString: await db.url() }),
    maxConcurrent: 2,
    probeMs: 50,
  });
}, 120000);
afterAll(async () => mutex?.close());
function profile(
  provider: OcrProvider = h.fake.ocr,
  afterOcr?: (id: string | null) => Promise<void>,
) {
  const assembly = assembleForTest({ entry: "api" });
  const media = createMedia({
    tx: h.tx,
    clock: h.clock,
    assembly,
    events: h.events,
    storage: h.fake.storage,
    ocr: { provider, sessionMutex: mutex, keyring: () => TEST_KEYRING },
  });
  return createProfile({
    tx: h.tx,
    clock: h.clock,
    assembly,
    tenant: h.tenant,
    approval: h.approval,
    events: h.events,
    media: {
      ...media,
      ocr: {
        recognize: async (input) => {
          const id = await media.ocr.recognize(input);
          await afterOcr?.(id);
          return id;
        },
      },
    },
    keyring: () => TEST_KEYRING,
    wechat: h.fake.wechat,
    currentOpenid: async () => "test-ocr-openid",
  });
}
async function file(viewer: ProfileViewer) {
  const row = await ownedFile(h, viewer, "kyc_license");
  h.fake.storage.put({ bucket: "secure", key: row.objectKey }, new Uint8Array(1024), "image/jpeg");
  return row;
}
const idem = (viewer: ProfileViewer, body: unknown, key: string) => ({
  idem: createIdempotencyContext({
    mode: "required",
    scope: "m.qualificationDoc.create",
    actor: viewer.ctx.actor,
    key,
    request: { method: "POST", body, storeId: viewer.membership.storeId },
    redact: ["recognized", "submitted"],
  }),
});
const original = (enc: string) =>
  JSON.parse(decryptField(TEST_KEYRING, "ocr_result.fields_enc", enc));

describe("W316资质识别实际轮次与留证", { timeout: 60000 }, () => {
  it("真实识别预填与类型阻断/unknown手填，商家和审核更正保原证据；GET零写且既有唯一图片订阅按当前事实重算", async () => {
    const owner = await h.owner(),
      ready = await complete(h, owner.viewer),
      p = profile();
    h.fake.ocr.defaultLicense = {
      name: "原识别个体",
      uscc: ready.number,
      principal: "原识别负责人",
      subjectType: "individual",
      principalRole: "operator",
      address: "原识别营业地址",
      validFrom: "2020-01-01",
      validTo: "long_term",
      warnings: ["WARN_RESHOOT_CARD"],
      raw: '{"Type":"个体工商户"}',
    };
    const first = await p.createDocument(owner.viewer, {
      fileId: (await file(owner.viewer)).id,
      docType: "business_license",
    });
    expect(first).toMatchObject({
      doc: { ocrStatus: "ok", hasSubmittedFields: true, principalRole: "operator" },
      entityTypeCheck: {
        recognizedSubjectType: "individual",
        claimedEntityType: "enterprise",
        isMismatch: true,
      },
      recognized: { name: "原识别个体" },
    });
    await expect(
      p.submit(owner.viewer, {
        qualificationSubmissionId: ready.submissionId,
        declarationConfirmed: true,
        declarationVersion: "1",
      }),
    ).rejects.toMatchObject({
      error: "ENTITY_TYPE_MISMATCH",
      details: { claimedEntityType: "enterprise", recognizedSubjectType: "individual" },
    });
    expect(
      (
        await h.prisma.qualificationSubmission.findUniqueOrThrow({
          where: { id: ready.submissionId },
        })
      ).submittedAt,
    ).toBeNull();
    h.fake.ocr.defaultLicense = {
      ...h.fake.ocr.defaultLicense,
      name: "原识别未知主体",
      subjectType: "unknown",
      principalRole: undefined,
      raw: '{"Type":"未知新型主体"}',
    };
    const second = await p.createDocument(owner.viewer, {
      fileId: (await file(owner.viewer)).id,
      docType: "business_license",
    });
    expect(second.entityTypeCheck).toMatchObject({
      recognizedSubjectType: "unknown",
      isMismatch: false,
    });
    const source = await h.prisma.qualificationDoc.findUniqueOrThrow({
      where: { id: second.doc.qualificationDocId },
    });
    const recognition = await h.prisma.ocrResult.findUniqueOrThrow({
      where: { id: source.ocrResultId! },
    });
    expect(original(recognition.fieldsEnc!)).toMatchObject({
      name: "原识别未知主体",
      principal: "原识别负责人",
      subjectType: "unknown",
    });
    await p.updateDocument(owner.viewer, source.id, {
      lockVersion: second.lockVersion,
      fields: { name: "老板核对主体", principalRole: "legal_rep" },
    });
    const edited = await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: source.id } });
    const merchantFields = edited.submittedFieldsEnc;
    expect(merchantFields).not.toBe(source.submittedFieldsEnc);
    expect(
      (await h.prisma.ocrResult.findUniqueOrThrow({ where: { id: recognition.id } })).fieldsEnc,
    ).toBe(recognition.fieldsEnc);
    await p.submit(owner.viewer, {
      qualificationSubmissionId: ready.submissionId,
      declarationConfirmed: true,
      declarationVersion: "1",
    });
    const reviewer = await h.make.staff({ staffRoleKey: "super_admin" });
    const staff = await sampleStaffContext(h.prisma, reviewer.id, { stepUpAt: h.clock.now() });
    const ctx = createIdentityContext({
      actor: { type: "staff", id: reviewer.id, client: "admin" },
    });
    const pending = await p.admin.qualification(staff, ready.submissionId);
    expect(pending.docs.find((d) => d.qualificationDocId === source.id)?.fieldChecks).toEqual(
      expect.arrayContaining([
        { code: "C4", field: "subjectType", result: "manual" },
        { code: "C7", field: "ocr", result: "warn" },
      ]),
    );
    const round = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: ready.submissionId },
    });
    await p.admin.reviewDocument(ctx, staff, source.id, {
      lockVersion: round.lockVersion,
      fields: { principal: "审核修正人", subjectType: "enterprise" },
      note: "已核对原图并更正主体及负责人",
    });
    const corrected = await h.prisma.qualificationDoc.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(corrected.submittedFieldsEnc).toBe(merchantFields);
    expect(
      JSON.parse(
        decryptField(
          TEST_KEYRING,
          "qualification_doc.reviewed_fields_enc",
          corrected.reviewedFieldsEnc!,
        ),
      ),
    ).toMatchObject({ principal: "审核修正人", subjectType: "enterprise" });
    expect(
      (await h.prisma.ocrResult.findUniqueOrThrow({ where: { id: recognition.id } })).rawEnc,
    ).toBe(recognition.rawEnc);
    const tables = [
      "qualification_doc",
      "qualification_submission",
      "store_profile",
      "ocr_result",
      "audit_log",
      "outbox_event",
    ];
    const before = await snapshotTables(h.prisma, tables);
    const view = await p.admin.qualification(staff, ready.submissionId);
    expect(view.checkSummary).toMatchObject({ fail: 0 });
    expect(view.docs.find((d) => d.qualificationDocId === source.id)?.isCorrected).toBe(true);
    expect(JSON.stringify(view)).not.toContain(ready.number);
    expect(JSON.stringify(view)).not.toContain("审核修正人");
    await p.qualification(owner.viewer);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    expect(
      registration.subscribers?.filter((s) => s.name === "profile.onFileModerated"),
    ).toHaveLength(1);
    const door = await h.prisma.storeProfileMedia.findFirstOrThrow({
      where: { storeId: owner.store.id, mediaGroup: "door", removedAt: null },
    });
    const was = await h.prisma.storeProfile.findUniqueOrThrow({
      where: { storeId: owner.store.id },
    });
    await h.prisma.fileObject.update({
      where: { id: door.fileId },
      data: { moderationState: "block", updatedAt: h.clock.now() },
    });
    const event = {
      payload: {
        v: 1,
        fileId: door.fileId,
        category: "profile_image",
        moderationState: "pass",
        storeId: owner.store.id,
      },
    };
    await h.tx.run((tx) => onFileModerated(tx, event));
    const blocked = await h.prisma.storeProfile.findUniqueOrThrow({
      where: { storeId: owner.store.id },
    });
    expect(blocked.requiredFilled).toBeLessThan(was.requiredFilled);
    await h.tx.run((tx) => onFileModerated(tx, event));
    expect(
      (await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: owner.store.id } }))
        .requiredFilled,
    ).toBe(blocked.requiredFilled);
  });

  it("挂草稿晚失败保独立结果，同键重试复用且幂等存储无明文；迟到草稿/拦截文件拒写并可安全续做", async () => {
    const owner = await h.owner(),
      p = profile();
    h.fake.ocr.defaultLicense = {
      name: "不进入幂等库的原识别名称",
      uscc: uscc(),
      principal: "原识别隐私负责人",
      subjectType: "enterprise",
      principalRole: "legal_rep",
      validFrom: "2020-01-01",
      validTo: "long_term",
      address: "虚构地址",
      warnings: [],
    };
    const f = await file(owner.viewer),
      body = { fileId: f.id, docType: "business_license" as const },
      key = uuidv7();
    const calls = h.fake.ocr.callsOf("recognizeBusinessLicense").length;
    const spy = vi.spyOn(audit, "record").mockRejectedValueOnce(new AppError("STATE_NOT_ALLOWED"));
    try {
      await expect(
        p.createDocument(owner.viewer, body, idem(owner.viewer, body, key)),
      ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    } finally {
      spy.mockRestore();
    }
    expect(await h.prisma.qualificationDoc.count({ where: { storeId: owner.store.id } })).toBe(0);
    expect(await h.prisma.ocrResult.count({ where: { storeId: owner.store.id } })).toBe(1);
    expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
    const saved = await p.createDocument(owner.viewer, body, idem(owner.viewer, body, key));
    expect(h.fake.ocr.callsOf("recognizeBusinessLicense")).toHaveLength(calls + 1);
    const stored = await h.prisma.idempotencyRecord.findFirstOrThrow({ where: { key } });
    expect(stored.result).toMatchObject({ recognized: null, submitted: null });
    expect(stored.result).toMatchObject({ doc: { holderName: h.fake.ocr.defaultLicense.name } });
    for (const marker of [h.fake.ocr.defaultLicense.uscc, h.fake.ocr.defaultLicense.principal])
      expect(JSON.stringify(stored.result)).not.toContain(marker);
    const replay = await p.createDocument(owner.viewer, body, idem(owner.viewer, body, key));
    expect(replay).toMatchObject({
      replayed: true,
      recognized: null,
      submitted: null,
      doc: { qualificationDocId: saved.doc.qualificationDocId },
    });
    expect(await h.prisma.qualificationDoc.count({ where: { storeId: owner.store.id } })).toBe(1);

    const late = await file(owner.viewer),
      lateBody = { fileId: late.id, docType: "business_license" as const },
      lateKey = uuidv7();
    let changed = false;
    const mutate: OcrProvider = {
      ...h.fake.ocr,
      recognizeBusinessLicense: async (input) => {
        if (!changed) {
          changed = true;
          await h.profile.updateQualification(owner.viewer, {
            lockVersion: saved.lockVersion,
            claimedEntityType: "enterprise",
          });
        }
        return h.fake.ocr.recognizeBusinessLicense(input);
      },
    };
    const lateProfile = profile(mutate);
    await expect(
      lateProfile.createDocument(owner.viewer, lateBody, idem(owner.viewer, lateBody, lateKey)),
    ).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
    const fact = await h.prisma.ocrResult.findFirstOrThrow({ where: { fileId: late.id } });
    expect(await h.prisma.qualificationDoc.count({ where: { fileId: late.id } })).toBe(0);
    const lateCalls = h.fake.ocr.callsOf("recognizeBusinessLicense").length;
    const resumed = await lateProfile.createDocument(
      owner.viewer,
      lateBody,
      idem(owner.viewer, lateBody, lateKey),
    );
    expect(
      (
        await h.prisma.qualificationDoc.findUniqueOrThrow({
          where: { id: resumed.doc.qualificationDocId },
        })
      ).ocrResultId,
    ).toBe(fact.id);
    expect(h.fake.ocr.callsOf("recognizeBusinessLicense")).toHaveLength(lateCalls);

    const blocked = await file(owner.viewer),
      blockedBody = { fileId: blocked.id, docType: "business_license" as const },
      blockedKey = uuidv7();
    let intercept = true;
    const blockedProfile = profile(h.fake.ocr, async () => {
      if (intercept) {
        intercept = false;
        await h.prisma.fileObject.update({
          where: { id: blocked.id },
          data: { moderationState: "block" },
        });
      }
    });
    await expect(
      blockedProfile.createDocument(
        owner.viewer,
        blockedBody,
        idem(owner.viewer, blockedBody, blockedKey),
      ),
    ).rejects.toMatchObject({ error: "FILE_NOT_USABLE", details: { reason: "blocked" } });
    expect(await h.prisma.ocrResult.count({ where: { fileId: blocked.id } })).toBe(1);
    expect(await h.prisma.qualificationDoc.count({ where: { fileId: blocked.id } })).toBe(0);
    const blockedCalls = h.fake.ocr.callsOf("recognizeBusinessLicense").length;
    await h.prisma.fileObject.update({
      where: { id: blocked.id },
      data: { moderationState: "none" },
    });
    expect(
      (
        await blockedProfile.createDocument(
          owner.viewer,
          blockedBody,
          idem(owner.viewer, blockedBody, blockedKey),
        )
      ).doc.ocrStatus,
    ).toBe("ok");
    expect(h.fake.ocr.callsOf("recognizeBusinessLicense")).toHaveLength(blockedCalls);
  });
});
