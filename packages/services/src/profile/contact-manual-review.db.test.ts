import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createIdempotencyContext, createIdentityContext, uuidv7 } from "../kernel/index.js";
import { assertCurrentSession } from "../identity/index.js";
import { blindIndex, encryptField } from "../security/index.js";
import { scopeOf } from "../authz/index.js";
import { runQualificationFieldChecks } from "../media/index.js";
import {
  assertSnapshotsEqual,
  assembleForTest,
  createNotifySessionFixture,
  notificationFixture,
  openSealed,
  sampleStaffContext,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";
import { complete, harness, submit } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { createProfile } from "./service.js";
import type { ProfileViewer } from "./context.js";

const db = useSeededDatabase("services", { max: 1 });
let h: Harness, notify: ReturnType<typeof notificationFixture>;
let phoneSequence = 1;
const phone = () => `1392150${String(phoneSequence++).padStart(4, "0")}`;
const tables = [
  "entity",
  "store",
  "store_profile",
  "qualification_submission",
  "qualification_doc",
  "approval_request",
  "status_transition",
  "outbox_event",
  "audit_log",
  "file_ref",
];
beforeAll(async () => {
  const prisma = await db.prisma();
  h = harness(prisma);
  notify = notificationFixture(prisma);
  notify.clock.set(h.clock.now());
  await prisma.smsTemplate.update({
    where: { templateKey: "verify_code" },
    data: {
      status: "active",
      signName: "虚构公司",
      providerTemplateId: "fictional-template",
      updatedAt: h.clock.now(),
    },
  });
}, 120000);
afterAll(async () => {
  await notify?.service.close();
});
function profile(failEvent = false) {
  return createProfile({
    tx: h.tx,
    clock: h.clock,
    assembly: assembleForTest({ entry: "api" }),
    tenant: h.tenant,
    approval: h.approval,
    media: h.media,
    keyring: () => TEST_KEYRING,
    wechat: h.fake.wechat,
    currentOpenid: async () => "test",
    events: {
      ...h.events,
      emit: async (tx, ctx, event) => {
        if (
          failEvent &&
          ["store.profile.changed", "store.qualification.approved"].includes(event.type)
        )
          throw new Error("manual rollback fixture");
        return h.events.emit(tx, ctx, event);
      },
    },
    contactSms: {
      available: notify.service.verificationAvailable,
      assertSession: (tx, principal, at) =>
        assertCurrentSession(tx, principal, at, "fictional-w217"),
      send: (phone, code, directKey) =>
        notify.service.sendDirect({
          purpose: "verify_code",
          templateKey: "verify_code",
          phone,
          params: { code },
          directKey,
        }),
    },
  });
}
async function owner() {
  const w = await h.owner(),
    session = await createNotifySessionFixture(h.prisma, h.clock, w.user.id);
  const viewer: ProfileViewer = {
    ...w.viewer,
    principal: {
      ...w.viewer.principal,
      sessionId: session.session.id,
      wechatIdentityId: session.identity.id,
    },
  };
  return { ...w, viewer, session: session.session };
}
async function reviewer(role: "super_admin" | "cs" = "super_admin") {
  const row = await h.make.staff({ staffRoleKey: role });
  return {
    staff: await sampleStaffContext(h.prisma, row.id),
    ctx: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
    row,
  };
}
async function pending(recognized = false) {
  const w = await owner(),
    ready = await complete(h, w.viewer);
  if (recognized) {
    const doc = await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: ready.docId } });
    const ocr = await h.prisma.ocrResult.create({
      data: {
        id: uuidv7(),
        entityId: w.entity.id,
        storeId: w.store.id,
        fileId: doc.fileId,
        docType: "business_license",
        provider: "tencent",
        status: "ok",
        fieldsEnc: encryptField(
          TEST_KEYRING,
          "ocr_result.fields_enc",
          openSealed("qualification_doc.submitted_fields_enc", doc.submittedFieldsEnc!),
        ),
        requestActorType: "merchant",
        requestActorId: w.user.id,
        requestClient: "weapp",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await h.prisma.qualificationDoc.update({
      where: { id: doc.id },
      data: { ocrResultId: ocr.id },
    });
  }
  await submit(h, w.viewer, ready.submissionId);
  return { ...w, ...ready };
}
function codeFor(number: string) {
  return (
    notify.providers.sms
      .callsOf("sendSubscribeFallback")
      .filter((c) => (c.input as { phone: string }).phone === number)
      .at(-1)!.input as { params: { code: string } }
  ).params.code;
}
const idem = (viewer: ProfileViewer, scope: string, input: unknown, key = uuidv7()) =>
  createIdempotencyContext({
    mode: "required",
    scope,
    key,
    actor: viewer.ctx.actor,
    request: { method: "POST", body: input },
  });

describe("W2-11联系人验证与人工资质复核", { timeout: 60000 }, () => {
  it("contact_phone真实发送哈希落库/同键一次/登录号跳过，失败补偿及模板停用诚实降级", async () => {
    const w = await owner(),
      p = profile(),
      number = phone(),
      key = uuidv7();
    const first = await p.createContactCode(w.viewer, number, {
      idem: idem(w.viewer, "m.storeProfile.contactSmsCode.create", { phone: number }, key),
    });
    const calls = notify.providers.sms.callsOf("sendSubscribeFallback").length;
    const row = await h.prisma.smsVerification.findFirstOrThrow({
      where: { merchantUserId: w.user.id },
    });
    expect(row).toMatchObject({ purpose: "contact_phone", usedAt: null, attempts: 0 });
    expect(Buffer.from(row.codeHash)).toEqual(
      createHash("sha256").update(codeFor(number)).digest(),
    );
    expect(
      await p.createContactCode(w.viewer, number, {
        idem: idem(w.viewer, "m.storeProfile.contactSmsCode.create", { phone: number }, key),
      }),
    ).toEqual(first);
    expect(notify.providers.sms.callsOf("sendSubscribeFallback")).toHaveLength(calls);
    const login = openSealed("merchant_user.phone_enc", w.user.phoneEnc!);
    expect(await p.createContactCode(w.viewer, login)).toEqual({
      isLoginPhone: true,
      expiresAt: null,
      resendAfterSec: null,
    });
    const failed = phone();
    notify.providers.sms.failNext("sendSubscribeFallback");
    await expect(p.createContactCode(w.viewer, failed)).rejects.toMatchObject({
      error: "SMS_UNAVAILABLE",
    });
    expect(await h.prisma.smsVerification.count({ where: { merchantUserId: w.user.id } })).toBe(1);
    expect(await h.prisma.smsVerification.findUniqueOrThrow({ where: { id: row.id } })).toEqual(
      row,
    );
    await h.prisma.smsTemplate.update({
      where: { templateKey: "verify_code" },
      data: { status: "disabled" },
    });
    await expect(p.createContactCode(w.viewer, phone())).rejects.toMatchObject({
      error: "SMS_UNAVAILABLE",
    });
    expect(
      await p.updateContact(w.viewer, {
        lockVersion: 0,
        name: "联系人",
        phoneSource: "input",
        phone: phone(),
      }),
    ).toMatchObject({
      phoneVerifyState: "unverified",
      isSmsVerifyAvailable: false,
      phoneVerifiedAt: null,
    });
    await h.prisma.smsTemplate.update({
      where: { templateKey: "verify_code" },
      data: { status: "active" },
    });
  });

  it("正确码仅主事务核销一次；错误独立计数满五次，phone_change/其他账号号码不能混用", async () => {
    const w = await owner(),
      p = profile(),
      number = phone();
    await p.createContactCode(w.viewer, number);
    const input = {
      lockVersion: 0,
      name: "真实验证联系人",
      phoneSource: "input" as const,
      phone: number,
      smsCode: codeFor(number),
    };
    const key = uuidv7();
    expect(
      await p.updateContact(w.viewer, input, {
        idem: idem(w.viewer, "m.storeProfile.contact.update", input, key),
      }),
    ).toMatchObject({
      phoneVerifyState: "sms_verified",
      phoneVerifiedAt: h.clock.now().toISOString(),
      isSmsVerifyAvailable: true,
    });
    const after = await snapshotTables(h.prisma, [...tables, "sms_verification"]);
    await p.updateContact(w.viewer, input, {
      idem: idem(w.viewer, "m.storeProfile.contact.update", input, key),
    });
    assertSnapshotsEqual(after, await snapshotTables(h.prisma, [...tables, "sms_verification"]));
    await expect(p.updateContact(w.viewer, { ...input, lockVersion: 1 })).rejects.toMatchObject({
      error: "SMS_CODE_INVALID",
    });
    const next = phone();
    await p.createContactCode(w.viewer, next);
    const wrong = codeFor(next) === "000000" ? "111111" : "000000";
    for (let n = 1; n <= 5; n++)
      await expect(
        p.updateContact(w.viewer, { ...input, lockVersion: 1, phone: next, smsCode: wrong }),
      ).rejects.toMatchObject({ error: "SMS_CODE_INVALID", details: { attemptsLeft: 5 - n } });
    await expect(
      p.updateContact(w.viewer, { ...input, lockVersion: 1, phone: next, smsCode: codeFor(next) }),
    ).rejects.toMatchObject({ error: "SMS_CODE_INVALID", details: { attemptsLeft: 0 } });
    const isolated = phone();
    await h.prisma.smsVerification.create({
      data: {
        id: uuidv7(),
        purpose: "phone_change",
        merchantUserId: w.user.id,
        phoneBidx: blindIndex(TEST_KEYRING, "phone", isolated),
        codeHash: createHash("sha256").update("123456").digest(),
        expiresAt: new Date(h.clock.now().getTime() + 300000),
        attempts: 0,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await expect(
      p.updateContact(w.viewer, { ...input, lockVersion: 1, phone: isolated, smsCode: "123456" }),
    ).rejects.toMatchObject({ error: "SMS_CODE_INVALID" });
    const other = await owner();
    await expect(p.updateContact(other.viewer, { ...input, phone: number })).rejects.toMatchObject({
      error: "SMS_CODE_INVALID",
    });
    const unverified = await owner(),
      ready = await complete(h, unverified.viewer);
    await h.prisma.smsTemplate.update({
      where: { templateKey: "verify_code" },
      data: { status: "disabled" },
    });
    await p.updateContact(unverified.viewer, {
      lockVersion: 4,
      name: "待验证联系人",
      phoneSource: "input",
      phone: phone(),
    });
    await h.prisma.smsTemplate.update({
      where: { templateKey: "verify_code" },
      data: { status: "active" },
    });
    await expect(
      p.submit(unverified.viewer, {
        qualificationSubmissionId: ready.submissionId,
        declarationConfirmed: true,
        declarationVersion: "1",
      }),
    ).rejects.toMatchObject({ error: "CONTACT_PHONE_UNVERIFIED" });
  });

  it("版本/文本/晚期失败不核销；过期会话与失效owner阻断发码，终局联系人仍能正常保存", async () => {
    const w = await owner(),
      p = profile(),
      number = phone();
    await p.createContactCode(w.viewer, number);
    const input = {
      lockVersion: 0,
      name: "安全联系人",
      phoneSource: "input" as const,
      phone: number,
      smsCode: codeFor(number),
    };
    const before = await snapshotTables(h.prisma, [...tables, "sms_verification"]);
    await expect(p.updateContact(w.viewer, { ...input, lockVersion: 999 })).rejects.toMatchObject({
      error: "VERSION_CONFLICT",
    });
    h.fake.wechat.failNext("checkText");
    await expect(p.updateContact(w.viewer, input)).rejects.toMatchObject({
      error: "PROVIDER_UNAVAILABLE",
    });
    await expect(profile(true).updateContact(w.viewer, input)).rejects.toThrow(
      "manual rollback fixture",
    );
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, [...tables, "sms_verification"]));
    await h.prisma.userSession.update({
      where: { id: w.session.id },
      data: { revokedAt: h.clock.now(), revokeReason: "logout" },
    });
    await expect(p.createContactCode(w.viewer, phone())).rejects.toMatchObject({
      error: "SESSION_INVALID",
    });
    const terminal = await pending(),
      r = await reviewer(),
      real = profile();
    const impact = await real.admin.rejectQuote(r.staff, terminal.submissionId);
    await real.admin.reject(r.ctx, r.staff, terminal.submissionId, {
      isFinal: true,
      reasonCodes: ["R01"],
      note: "不能补正",
      confirm: impact,
    });
    expect(
      await real.updateContact(terminal.viewer, {
        lockVersion: 4,
        name: "终局后联系人",
        phoneSource: "login",
      }),
    ).toMatchObject({ phoneVerifyState: "login" });
  });

  it("人工修正保submitted证据、未识别仅C11、双版本升一次且corrected批准采用修正值", async () => {
    const w = await pending(),
      r = await reviewer(),
      p = profile();
    const original = await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: w.docId } });
    const round = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: w.submissionId },
    });
    const histories = await h.prisma.statusTransition.count();
    const input = {
      lockVersion: round.lockVersion,
      fields: { name: "人工核实主体", principal: "李测试" },
      note: "按原图修正",
    };
    const key = uuidv7(),
      identity = { ...w.viewer, ctx: r.ctx };
    const first = await p.admin.reviewDocument(r.ctx, r.staff, w.docId, input, {
      idem: idem(identity, "admin.qualificationDoc.update", input, key),
    });
    expect(first).toMatchObject({
      lockVersion: round.lockVersion + 1,
      approval: { lockVersion: 1 },
      docs: [{ ocrStatus: "unavailable", fieldChecks: [{ code: "C11", result: "manual" }] }],
    });
    expect(await h.prisma.statusTransition.count()).toBe(histories);
    const corrected = await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: w.docId } });
    expect(corrected.submittedFieldsEnc).toBe(original.submittedFieldsEnc);
    expect(
      JSON.parse(openSealed("qualification_doc.reviewed_fields_enc", corrected.reviewedFieldsEnc!)),
    ).toMatchObject(input.fields);
    expect(
      await p.admin.reviewDocument(r.ctx, r.staff, w.docId, input, {
        idem: idem(identity, "admin.qualificationDoc.update", input, key),
      }),
    ).toEqual(first);
    await expect(
      p.admin.approve(r.ctx, r.staff, w.submissionId, {
        lockVersion: 0,
        confirm: { roundNo: 1 },
        mode: "normal",
      }),
    ).rejects.toMatchObject({ error: "VERSION_CONFLICT" });
    expect(
      await p.admin.approve(r.ctx, r.staff, w.submissionId, {
        lockVersion: 1,
        confirm: { roundNo: 1 },
        mode: "normal",
      }),
    ).toMatchObject({ approveMode: "corrected", entity: { name: "人工核实主体" } });
    const audits = await h.prisma.auditLog.findMany({
      where: { targetId: w.docId, action: "profile.document.correct" },
    });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain("李测试");
  });

  it("真实既存OCR比对失败拦normal，corrected清错或super_admin理由放行，事件审计幂等一次", async () => {
    const w = await pending(true),
      r = await reviewer(),
      cs = await reviewer("cs"),
      p = profile();
    const round = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: w.submissionId },
    });
    const fail = await p.admin.reviewDocument(r.ctx, r.staff, w.docId, {
      lockVersion: round.lockVersion,
      fields: { subjectType: "individual" },
    });
    expect(fail).toMatchObject({ canOverride: true, checkSummary: { fail: 1 } });
    await expect(
      p.admin.approve(r.ctx, r.staff, w.submissionId, {
        lockVersion: 1,
        confirm: { roundNo: 1 },
        mode: "normal",
      }),
    ).rejects.toMatchObject({
      error: "QUALIFICATION_CHECK_FAILED",
      details: { items: [{ qualificationDocId: w.docId, code: "C4" }] },
    });
    await expect(
      p.admin.approve(cs.ctx, cs.staff, w.submissionId, {
        lockVersion: 999,
        confirm: { roundNo: 1 },
        mode: "override",
        overrideReason: "人工逐项复核确认可以放行",
      }),
    ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    await expect(
      p.admin.approve(r.ctx, r.staff, w.submissionId, {
        lockVersion: 1,
        confirm: { roundNo: 1 },
        mode: "override",
      }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    const input = {
      lockVersion: 1,
      confirm: { roundNo: 1 },
      mode: "override" as const,
      overrideReason: "人工逐项复核确认可以放行",
    };
    const key = uuidv7(),
      identity = { ...w.viewer, ctx: r.ctx };
    const approved = await p.admin.approve(r.ctx, r.staff, w.submissionId, input, {
      idem: idem(identity, "admin.qualificationSubmission.approve", input, key),
    });
    expect(approved).toMatchObject({
      approveMode: "override",
      approval: { decisionNote: input.overrideReason },
    });
    expect(
      await p.admin.approve(r.ctx, r.staff, w.submissionId, input, {
        idem: idem(identity, "admin.qualificationSubmission.approve", input, key),
      }),
    ).toEqual(approved);
    expect(
      await h.prisma.auditLog.findFirstOrThrow({
        where: { targetId: round.approvalRequestId!, action: "approval.request.approve" },
      }),
    ).toMatchObject({ meta: { rule: "override" } });
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: w.store.id, eventType: "store.qualification.approved" },
      }),
    ).toBe(1);
  });

  it("修正scope/类型/版本及晚期决定回滚保历史；名称归一与北京到期边界精确，无OCR不伪检查", async () => {
    const w = await pending(true),
      r = await reviewer(),
      p = profile();
    const round = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: w.submissionId },
    });
    const before = await snapshotTables(h.prisma, tables);
    const own = {
      ...r.staff,
      scope: scopeOf({ id: r.row.id, isLead: false }, { dataScope: "own" }, [], new Set()),
    };
    await expect(
      p.admin.reviewDocument(r.ctx, own, w.docId, {
        lockVersion: round.lockVersion,
        fields: { name: "越权" },
      }),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    const invalidFields: readonly Record<string, string>[] = [
      { bogus: "值" },
      { uscc: "BAD" },
      { validTo: "2026-02-30" },
    ];
    for (const fields of invalidFields)
      await expect(
        p.admin.reviewDocument(r.ctx, r.staff, w.docId, { lockVersion: round.lockVersion, fields }),
      ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    await expect(
      profile(true).admin.approve(r.ctx, r.staff, w.submissionId, {
        lockVersion: 0,
        confirm: { roundNo: 1 },
        mode: "normal",
      }),
    ).rejects.toThrow("manual rollback fixture");
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    for (const key of ["name", "principal", "address"])
      await expect(
        p.admin.reviewDocument(r.ctx, r.staff, w.docId, {
          lockVersion: round.lockVersion,
          fields: { [key]: "" },
        }),
      ).rejects.toMatchObject({ error: "QUALIFICATION_DOCS_INCOMPLETE" });
    await h.prisma.staff.update({ where: { id: r.row.id }, data: { staffRoleKey: "cs" } });
    await expect(
      p.admin.approve(r.ctx, r.staff, w.submissionId, {
        lockVersion: 0,
        confirm: { roundNo: 1 },
        mode: "override",
        overrideReason: "旧权限不得用于本次批准操作",
      }),
    ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    await h.prisma.staff.update({ where: { id: r.row.id }, data: { staffRoleKey: "super_admin" } });
    await h.prisma.staffRole.update({
      where: { key: "super_admin" },
      data: { moduleLevels: { ...r.staff.moduleLevels, merchant: "n" } },
    });
    try {
      await expect(
        p.admin.reviewDocument(r.ctx, r.staff, w.docId, {
          lockVersion: round.lockVersion,
          fields: { name: "旧模块权限不得用于本次修正" },
        }),
      ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    } finally {
      await h.prisma.staffRole.update({
        where: { key: "super_admin" },
        data: { moduleLevels: { ...r.staff.moduleLevels } },
      });
    }
    const today = await p.admin.reviewDocument(r.ctx, r.staff, w.docId, {
      lockVersion: round.lockVersion,
      fields: { validTo: "2026-01-05" },
    });
    expect(today.checkSummary?.fail).toBe(0);
    const history = await snapshotTables(h.prisma, tables);
    h.clock.set(new Date("2026-01-05T16:00:00Z"));
    expect(await p.admin.qualification(r.staff, w.submissionId)).toMatchObject({
      canOverride: true,
      checkSummary: { fail: 1 },
    });
    assertSnapshotsEqual(history, await snapshotTables(h.prisma, tables));
    h.clock.set(new Date("2026-01-05T04:00:00Z"));
    const fields = {
      name: "测试(主体)",
      uscc: w.number,
      subjectType: "enterprise",
      validTo: "2026-01-05",
      address: "测试地址",
    };
    const input = {
      recognition: { status: "ok" as const, fields, warnings: [] },
      fields,
      docType: "business_license",
      now: new Date("2026-01-05T15:59:59Z"),
      usccValid: true,
      entityName: " 测试（主体） ",
      licenseName: null,
      claimedType: "enterprise",
    };
    expect(runQualificationFieldChecks(input)).toEqual(
      expect.arrayContaining([
        { code: "C1", field: "name", result: "pass" },
        { code: "C3", field: "validTo", result: "warn" },
      ]),
    );
    expect(
      runQualificationFieldChecks({ ...input, now: new Date("2026-01-05T16:00:00Z") }),
    ).toContainEqual({ code: "C3", field: "validTo", result: "fail" });
    expect(
      runQualificationFieldChecks({
        ...input,
        recognition: { status: "unavailable", fields: null, warnings: [] },
      }),
    ).toEqual([{ code: "C11", field: "ocr", result: "manual" }]);
  });
});
