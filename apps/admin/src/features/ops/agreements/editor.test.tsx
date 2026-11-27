import { describe, expect, it, vi } from "vitest";
import { AgreementFailure, type AgreementApi, type Version } from "./api";
import { createDraftSession, editorBody, initialFields } from "./editor";
import { effectiveInstant } from "./model";

const id = "01910000-0000-7000-8000-000000000001";
const version: Version = {
  agreementVersionId: id,
  agreementKey: "privacy",
  major: 1,
  minor: 1,
  versionLabel: "v1.1",
  status: "draft",
  displayStatus: "draft",
  effectiveAt: "2026-10-15T01:00:00.000Z",
  summary: "虚构隐私调整",
  isReconsentRequired: true,
  isLegalApproved: true,
  sourceFile: null,
  pdfFile: null,
  hasContentHtml: false,
  contentSha256: null,
  siteNoticeId: null,
  shortNoticeReason: null,
  expectedConsents: null,
  activatedAt: null,
  createdBy: {
    staffId: id,
    name: "虚构员工",
    staffNo: 1001,
    roleKey: "super_admin",
    isLead: false,
    status: "active",
  },
  publishedBy: null,
  lockVersion: 4,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  actions: ["edit", "schedule"],
};
const converted = (v: Version): Awaited<ReturnType<AgreementApi["update"]>> => ({
  version: v,
  contentHtml: "<p>虚构正文</p>",
  conversion: { state: "converted" as const, warnings: [] },
});
function ports() {
  return {
    create: vi.fn<AgreementApi["create"]>(async () => converted(version)),
    update: vi.fn<AgreementApi["update"]>(async () => converted({ ...version, lockVersion: 5 })),
    schedule: vi.fn<AgreementApi["schedule"]>(async () => ({
      version: { ...version, status: "pending" },
      siteNotice: null,
    })),
  } satisfies Pick<AgreementApi, "create" | "update" | "schedule">;
}
describe("W216 草稿提交", () => {
  const sourceId = "01910000-0000-7000-8000-000000000002";
  const pdfId = "01910000-0000-7000-8000-000000000003";
  const replacementId = "01910000-0000-7000-8000-000000000004";
  const withFiles: Version = {
    ...version,
    sourceFile: {
      fileId: sourceId,
      originalName: "agreement.docx",
      sizeBytes: "1024",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    pdfFile: {
      fileId: pdfId,
      originalName: "agreement.pdf",
      sizeBytes: "2048",
      mime: "application/pdf",
    },
    hasContentHtml: true,
  };
  it("修改生效时间只PATCH元数据，保持既有文件引用以免重复转换", async () => {
    const api = ports();
    api.update.mockResolvedValueOnce(converted({ ...withFiles, lockVersion: 5 }));
    const session = createDraftSession(api, "privacy", withFiles);
    const fields = { ...initialFields(withFiles), date: "2026-10-16", isLegalApproved: true };
    await session.save(editorBody(fields, true));
    expect(api.update.mock.calls[0]?.slice(0, 2)).toEqual([
      id,
      {
        lockVersion: 4,
        effectiveAt: "2026-10-16T01:00:00.000Z",
        summary: withFiles.summary,
        isReconsentRequired: true,
        isLegalApproved: true,
      },
    ]);
  });
  it("仅替换Word时不重发PDF，并以成功返回的文件引用比较下一次元数据修改", async () => {
    const api = ports();
    const replaced = {
      ...withFiles,
      sourceFile: { ...withFiles.sourceFile!, fileId: replacementId },
      lockVersion: 5,
    };
    api.update
      .mockResolvedValueOnce(converted(replaced))
      .mockResolvedValueOnce(converted({ ...replaced, lockVersion: 6 }));
    const session = createDraftSession(api, "privacy", withFiles);
    const body = editorBody({ ...initialFields(withFiles), sourceFileId: replacementId }, true);
    await session.save(body);
    expect(api.update.mock.calls[0]?.[1]).toMatchObject({
      sourceFileId: replacementId,
      lockVersion: 4,
    });
    expect(api.update.mock.calls[0]?.[1]).not.toHaveProperty("pdfFileId");
    await session.save({ ...body, summary: "仅调整摘要" });
    expect(api.update.mock.calls[1]?.[1]).toMatchObject({ summary: "仅调整摘要", lockVersion: 5 });
    expect(api.update.mock.calls[1]?.[1]).not.toHaveProperty("sourceFileId");
    expect(api.update.mock.calls[1]?.[1]).not.toHaveProperty("pdfFileId");
  });
  it.each(["sourceFileId", "pdfFileId"] as const)(
    "只清除%s时保留null并省略另一文件",
    async (field) => {
      const api = ports();
      const session = createDraftSession(api, "privacy", withFiles);
      await session.save(editorBody({ ...initialFields(withFiles), [field]: null }, true));
      const request = api.update.mock.calls[0]?.[1];
      expect(request).toHaveProperty(field, null);
      expect(request).not.toHaveProperty(field === "sourceFileId" ? "pdfFileId" : "sourceFileId");
    },
  );
  it("清除既有Word和PDF仍发送null，失败重试保持相同请求与幂等键", async () => {
    const api = ports();
    api.update
      .mockRejectedValueOnce(new Error("临时失败"))
      .mockResolvedValueOnce(converted({ ...version, lockVersion: 5 }));
    const session = createDraftSession(api, "privacy", withFiles);
    const body = editorBody(
      { ...initialFields(withFiles), sourceFileId: null, pdfFileId: null },
      true,
    );
    await expect(session.save(body)).rejects.toThrow("临时失败");
    await session.save(body);
    expect(api.update.mock.calls[0]?.[1]).toMatchObject({
      sourceFileId: null,
      pdfFileId: null,
      lockVersion: 4,
    });
    expect(api.update.mock.calls[1]).toEqual(api.update.mock.calls[0]);
  });
  it("新建成功后只改摘要不重发create返回的文件引用", async () => {
    const api = ports();
    api.create.mockResolvedValueOnce(converted(withFiles));
    const session = createDraftSession(api, "privacy");
    const body = editorBody(initialFields(withFiles), false);
    await session.save(body);
    await session.save({ ...body, summary: "新建后调整摘要" });
    expect(api.create.mock.calls[0]?.[1]).toMatchObject({
      sourceFileId: sourceId,
      pdfFileId: pdfId,
    });
    expect(api.update.mock.calls[0]?.[1]).not.toHaveProperty("sourceFileId");
    expect(api.update.mock.calls[0]?.[1]).not.toHaveProperty("pdfFileId");
  });
  it("法务确认默认off，服务器既有审核事实不会替用户勾选；BJT日期严格转换", () => {
    const fields = initialFields(version);
    expect(fields.isLegalApproved).toBe(false);
    expect(fields.date).toBe("2026-10-15");
    expect(fields.time).toBe("09:00");
    expect(effectiveInstant("2026-10-15", "00:00")).toBe("2026-10-14T16:00:00.000Z");
    expect(() => effectiveInstant("2026-02-30", "09:00")).toThrow();
    expect(() => effectiveInstant("2026-10-15", "25:00")).toThrow();
  });
  it("清空字段回传null，未上传完成的选择不产生文件id；新建不发送nullable字段", () => {
    const fields = {
      ...initialFields(),
      date: "",
      time: "",
      summary: "",
      sourceFileId: null,
      pdfFileId: null,
    };
    expect(editorBody(fields, false)).toEqual({
      isLegalApproved: false,
      isReconsentRequired: false,
      bumpMajor: false,
    });
    expect(editorBody(fields, true)).toEqual({
      effectiveAt: null,
      summary: null,
      sourceFileId: null,
      pdfFileId: null,
      isLegalApproved: false,
      isReconsentRequired: false,
    });
  });
  it("新建成功后安排失败保留真实id/lock，同意图重试不重复create或update", async () => {
    const api = ports(),
      session = createDraftSession(api, "privacy");
    const fields = initialFields();
    fields.summary = "虚构说明";
    api.schedule.mockRejectedValueOnce(new Error("上游暂不可用"));
    const body = editorBody(fields, false);
    await expect(session.schedule(body, "")).rejects.toThrow("上游暂不可用");
    await session.schedule(body, "");
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.update).not.toHaveBeenCalled();
    expect(api.schedule.mock.calls[0]?.slice(0, 2)).toEqual([id, { lockVersion: 4 }]);
    expect(api.schedule.mock.calls[0]?.[2]).toBe(api.schedule.mock.calls[1]?.[2]);
  });
  it("修改表单后使用返回lock与新key；失败重试仍同key，冲突不自动偷换锁", async () => {
    const api = ports(),
      session = createDraftSession(api, "privacy", version);
    const body = editorBody(initialFields(version), true);
    api.update.mockRejectedValueOnce(
      new AgreementFailure({
        symbol: "VERSION_CONFLICT",
        status: 409,
        message: "版本已更新",
        requestId: null,
        body: null,
        disposition: "invalidate",
      }),
    );
    await expect(session.save(body)).rejects.toThrow("版本已更新");
    await session.save(body);
    expect(api.update.mock.calls[0]?.[1].lockVersion).toBe(4);
    expect(api.update.mock.calls[1]?.[1].lockVersion).toBe(4);
    expect(api.update.mock.calls[0]?.[2]).toBe(api.update.mock.calls[1]?.[2]);
    await session.save({ ...body, summary: "新意图" });
    expect(api.update.mock.calls[2]?.[1].lockVersion).toBe(5);
    expect(api.update.mock.calls[2]?.[2]).not.toBe(api.update.mock.calls[1]?.[2]);
  });
  it("转换差异原样保留，安排严格使用服务器schedule动作；旧session关闭拒绝迟到写回", async () => {
    const api = ports(),
      session = createDraftSession(api, "privacy", { ...version, actions: ["edit"] });
    api.update.mockResolvedValueOnce({
      ...converted({ ...version, actions: ["edit"], lockVersion: 5 }),
      conversion: { state: "converted", warnings: [{ code: "text_mismatch", similarityBp: 5000 }] },
    });
    const result = await session.save(editorBody(initialFields(version), true));
    expect(result.conversion.warnings).toEqual([{ code: "text_mismatch", similarityBp: 5000 }]);
    await expect(session.schedule(editorBody(initialFields(version), true), "")).rejects.toThrow(
      "当前版本不可安排",
    );
    expect(api.schedule).not.toHaveBeenCalled();
    session.close();
    await expect(session.save(editorBody(initialFields(version), true))).rejects.toThrow(
      "编辑已结束",
    );
  });
});
