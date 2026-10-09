import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDocumentConverter, createIdentityContext, uuidv7 } from "../kernel/index.js";
import type { DocumentConverter } from "../kernel/index.js";
import { createDocsAdminFixture, fictionalDocumentPdf, sampleStaffContext, useSeededDatabase } from "../testing/index.js";
import { sweepAgreementVersions } from "./index.js";

const db = useSeededDatabase("services");
const api = fileURLToPath(new URL("../../../../apps/api/", import.meta.url));
const out = `dist/test-doc-business-${process.pid}-${Date.now().toString(36)}`;
let converter: DocumentConverter;
let h: ReturnType<typeof createDocsAdminFixture>;
const sum = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ["scripts/build.mjs", "--outdir", out], {cwd: api});
  converter = createDocumentConverter({workerUrl: pathToFileURL(`${api}${out}/document-converter.js`)});
  h = createDocsAdminFixture(await db.prisma(), converter);
}, 60_000);
afterAll(async () => {await h?.close(); await converter?.close(); rmSync(`${api}${out}`, {recursive: true, force: true});});

describe("协议版本真实事务生命周期", () => {
  it("真实Word/PDF转换、完整字节hash与引用；法务默认false且同协议只有一个草稿", async () => {
    const actor = await h.actor();
    const source = await h.file(actor, "docx"), pdf = await h.file(actor, "pdf");
    const created = await h.admin.createVersion(actor, "user", {bumpMajor: false, sourceFileId: source.id, pdfFileId: pdf.id});
    expect(created).toMatchObject({conversion: {state: "converted", warnings: []}, version: {isLegalApproved: false, contentSha256: sum(fictionalDocumentPdf())}});
    expect(created.contentHtml).toBe("<p><strong>狸有戏虚构协议 测试门店 123</strong></p>");
    expect((await h.prisma.agreementVersion.findUniqueOrThrow({where: {id: created.version.agreementVersionId}})).htmlSha256).toBe(sum(created.contentHtml!));
    expect(await h.prisma.fileRef.count({where: {refType: "agreement_version", refId: created.version.agreementVersionId, releasedAt: null}})).toBe(2);
    await expect(h.admin.createVersion(actor, "user", {bumpMajor: false})).rejects.toMatchObject({error: "AGREEMENT_DRAFT_EXISTS"});
    await expect(h.docs.getAgreementVersion(created.version.agreementVersionId)).rejects.toMatchObject({error: "NOT_FOUND"});
  });
  it("PDF-only真实hash且不伪造HTML；旧文件替换释放7天，乐观锁失败无引用写入", async () => {
    const actor = await h.actor(), pdf = await h.file(actor, "pdf");
    const created = await h.admin.createVersion(actor, "ad_service", {bumpMajor: false, pdfFileId: pdf.id});
    expect(created).toMatchObject({contentHtml: null, conversion: {state: "pdf_only", warnings: []}, version: {contentSha256: pdf.sha256}});
    const next = await h.file(actor, "pdf", fictionalDocumentPdf("真实不同的虚构协议 456"));
    const updated = await h.admin.updateVersion(actor, created.version.agreementVersionId, {lockVersion: 0, pdfFileId: next.id});
    expect(updated.version.lockVersion).toBe(1);
    const old = await h.prisma.fileRef.findFirstOrThrow({where: {fileId: pdf.id, refId: created.version.agreementVersionId}});
    expect(old.releasedAt).toEqual(h.clock.now());
    expect(old.keepUntil).toEqual(new Date(h.clock.now().getTime() + 7 * 86400000));
    await expect(h.admin.updateVersion(actor, created.version.agreementVersionId, {lockVersion: 0, pdfFileId: pdf.id})).rejects.toMatchObject({error: "VERSION_CONFLICT"});
    expect(await h.prisma.fileRef.count({where: {refId: created.version.agreementVersionId, releasedAt: null}})).toBe(1);
  });
  it("prepare后ETag变化整笔回滚，且不可枚举别人的文件与非法分类", async () => {
    const actor = await h.actor(), foreign = await h.actor(), source = await h.file(actor, "docx"), pdf = await h.file(actor, "pdf");
    const real = converter.convert.bind(converter);
    converter.convert = async request => {
      const result = await real(request);
      await h.prisma.fileObject.update({where: {id: pdf.id}, data: {etag: '"changed-after-prepare"'}});
      return result;
    };
    try { await expect(h.admin.createVersion(actor, "custom_license", {bumpMajor: false, sourceFileId: source.id, pdfFileId: pdf.id})).rejects.toMatchObject({error: "FILE_NOT_AVAILABLE"}); }
    finally {converter.convert = real;}
    expect(await h.prisma.agreementVersion.count({where: {agreementKey: "custom_license", status: "draft"}})).toBe(0);
    expect(await h.prisma.fileRef.count({where: {fileId: {in: [source.id, pdf.id]}}})).toBe(0);
    await expect(h.admin.createVersion(foreign, "custom_license", {bumpMajor: false, pdfFileId: pdf.id})).rejects.toMatchObject({error: "NOT_FOUND"});
    await h.prisma.fileObject.update({where: {id: pdf.id}, data: {category: "poster"}});
    await expect(h.admin.createVersion(actor, "custom_license", {bumpMajor: false, pdfFileId: pdf.id})).rejects.toMatchObject({error: "FILE_NOT_USABLE", details: {reason: "category_mismatch"}});
  });
  it("安排生效十分钟相等拒绝；缺双文件/法务不允许发布", async () => {
    const actor = await h.actor(), d = await h.draft(actor, "privacy", new Date(h.clock.now().getTime() + 600000));
    await expect(h.admin.scheduleVersion(actor, d.version.id, {lockVersion: 0})).rejects.toMatchObject({error: "AGREEMENT_EFFECTIVE_TOO_SOON"});
    expect((await h.prisma.agreementVersion.findUniqueOrThrow({where: {id: d.version.id}})).status).toBe("draft");
    await h.prisma.agreementVersion.update({where: {id: d.version.id}, data: {effectiveAt: new Date(h.clock.now().getTime() + 600001), isLegalApproved: false}});
    await expect(h.admin.scheduleVersion(actor, d.version.id, {lockVersion: 0})).rejects.toMatchObject({error: "AGREEMENT_DRAFT_INCOMPLETE", details: {missing: ["legal_approved"]}});
    await h.prisma.agreementVersion.update({where: {id: d.version.id}, data: {isLegalApproved: true, sourceFileId: null}});
    await expect(h.admin.scheduleVersion(actor, d.version.id, {lockVersion: 0})).rejects.toMatchObject({error: "AGREEMENT_DRAFT_INCOMPLETE", details: {missing: ["source"]}});
  });
  it("公告、版本及出站事件同TX；撤回保留旧引用并克隆另id草稿", async () => {
    const actor = await h.actor(), d = await h.draft(actor, "member");
    const scheduled = await h.admin.scheduleVersion(actor, d.version.id, {lockVersion: 0});
    expect(scheduled.siteNotice).toMatchObject({status: "announced", refId: d.version.id, link: {route: "agreement.view", params: {key: "member"}}});
    expect(h.cacheBumps).toContain("agreement");
    const withdrawn = await h.admin.withdrawVersion(actor, d.version.id, {reason: "虚构撤回测试"});
    expect(withdrawn.withdrawn.status).toBe("withdrawn");
    expect(withdrawn.newDraft?.agreementVersionId).not.toBe(d.version.id);
    expect(withdrawn.newDraft).toMatchObject({major: d.version.major, minor: d.version.minor, siteNoticeId: null, isLegalApproved: true});
    expect(withdrawn.siteNotice).toMatchObject({siteNoticeId: scheduled.siteNotice!.siteNoticeId, status: "withdrawn"});
    expect(await h.prisma.fileRef.count({where: {refId: d.version.id, releasedAt: null}})).toBe(2);
    expect(await h.prisma.fileRef.count({where: {refId: withdrawn.newDraft!.agreementVersionId, releasedAt: null}})).toBe(2);
    const events = await h.prisma.outboxEvent.findMany({where: {eventType: {in: ["site_notice.announced", "site_notice.withdrawn"]}}});
    expect(events.filter(e => JSON.stringify(e.payload).includes(d.version.id))).toHaveLength(2);
    await expect(h.admin.withdrawVersion(actor, d.version.id, {reason: "重复撤回测试"})).rejects.toMatchObject({error: "STATE_NOT_ALLOWED"});
  });
  it("公告期不足需真实权限、stepup与理由；成功后不能编辑非草稿", async () => {
    const actor = await h.actor("super_admin", null), d = await h.draft(actor, "points", new Date(h.clock.now().getTime() + 86400000));
    await expect(h.admin.scheduleVersion(actor, d.version.id, {lockVersion: 0})).rejects.toMatchObject({error: "AGREEMENT_SHORT_NOTICE"});
    await expect(h.admin.scheduleVersion(actor, d.version.id, {lockVersion: 0, shortNoticeReason: "虚构紧急修订"})).rejects.toMatchObject({error: "STEP_UP_REQUIRED"});
    const approved = {...actor, staff: {...actor.staff, stepUpAt: h.clock.now()}};
    const result = await h.admin.scheduleVersion(approved, d.version.id, {lockVersion: 0, shortNoticeReason: "虚构紧急修订"});
    expect(result.siteNotice?.shortNoticeReason).toBe("虚构紧急修订");
    await expect(h.admin.updateVersion(approved, d.version.id, {lockVersion: 1, summary: "不应修改"})).rejects.toMatchObject({error: "STATE_NOT_ALLOWED"});
  });
  it("到点实时读取不写簿记；sweep只记录真实active人数并重复幂等", async () => {
    const actor = await h.actor(), d = await h.draft(actor, "custom_license", new Date(h.clock.now().getTime() + 600001));
    await h.admin.scheduleVersion(actor, d.version.id, {lockVersion: 0});
    await h.make.merchantUser({status: "active"});
    await h.make.merchantUser({status: "disabled"});
    h.clock.advance(600001);
    expect((await h.docs.getAgreementVersion(d.version.id)).phase).toBe("current");
    expect((await h.prisma.agreementVersion.findUniqueOrThrow({where: {id: d.version.id}})).status).toBe("pending");
    const expected = await h.prisma.merchantUser.count({where: {status: "active"}});
    expect(await h.tx.run(t => sweepAgreementVersions(t, h.jobs))).toMatchObject({activated: 1});
    expect((await h.prisma.agreementVersion.findUniqueOrThrow({where: {id: d.version.id}})).expectedConsents).toBe(expected);
    expect(await h.tx.run(t => sweepAgreementVersions(t, h.jobs))).toMatchObject({activated: 0, superseded: 0});
    expect(await h.prisma.auditLog.count({where: {targetType: "agreement_version", targetId: d.version.id, action: "docs.agreement_version.activate"}})).toBe(1);
  });
  it("同协议两连接竞争安排只有一次成功；已有新草稿时撤回不再复制", async () => {
    const actor = await h.actor(), d = await h.draft(actor, "custom_license");
    const outcomes = await Promise.allSettled([
      h.admin.scheduleVersion(actor, d.version.id, {lockVersion: 0}),
      h.admin.scheduleVersion(actor, d.version.id, {lockVersion: 0}),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({error: "STATE_NOT_ALLOWED"});
    expect(await h.prisma.auditLog.count({where: {targetId: d.version.id, action: "docs.agreement_version.schedule"}})).toBe(1);
    const draft = await h.admin.createVersion(actor, "custom_license", {bumpMajor: false});
    const withdrawn = await h.admin.withdrawVersion(actor, d.version.id, {reason: "竞争安排后的虚构撤回"});
    expect(withdrawn.newDraft).toBeNull();
    expect((await h.prisma.agreementVersion.findUniqueOrThrow({where: {id: draft.version.agreementVersionId}})).status).toBe("draft");
    expect(await h.prisma.agreementVersion.count({where: {agreementKey: "custom_license", status: "draft"}})).toBe(1);
  });
  it("撤回恰好十分钟边界拒绝并返回真实effectiveAt，保留原pending和引用", async () => {
    const d = await h.prisma.agreementVersion.findFirstOrThrow({where: {agreementKey: "privacy", status: "draft"}});
    const staff = await sampleStaffContext(h.prisma, d.createdByStaffId, {stepUpAt: h.clock.now()});
    const requestId = uuidv7();
    const actor = {staff, identity: createIdentityContext({actor: {type: "staff" as const, id: staff.staff.id, client: "admin"}, requestId}), meta: {requestId, ip: null, userAgent: null, sessionId: null, authMethod: "password+totp"}};
    const source = await h.file(actor, "docx");
    const effectiveAt = new Date(h.clock.now().getTime() + 600001);
    // Complete only this existing draft fixture; the public schedule/withdraw guards are real.
    await h.prisma.agreementVersion.update({where: {id: d.id}, data: {sourceFileId: source.id, effectiveAt, isLegalApproved: true}});
    await h.admin.scheduleVersion(actor, d.id, {lockVersion: d.lockVersion});
    h.clock.advance(1);
    const before = await h.prisma.fileRef.findMany({where: {refId: d.id}, orderBy: {id: "asc"}});
    await expect(h.admin.withdrawVersion(actor, d.id, {reason: "不应跨过十分钟边界"})).rejects.toMatchObject({error: "AGREEMENT_WITHDRAW_TOO_LATE", details: {reason: "effective_soon", effectiveAt: effectiveAt.toISOString()}});
    expect((await h.prisma.agreementVersion.findUniqueOrThrow({where: {id: d.id}})).status).toBe("pending");
    expect(await h.prisma.fileRef.findMany({where: {refId: d.id}, orderBy: {id: "asc"}})).toEqual(before);
    expect(await h.prisma.auditLog.count({where: {targetId: d.id, action: "docs.agreement_version.withdraw"}})).toBe(0);
  });
}, 60_000);
