import { describe, expect, it } from "vitest";
import { createAssetUploadApi } from "./upload-api";
import type { RequestLayer } from "@/lib/request";
import { intentBody, uploadTypes, validateUploadForm } from "./upload-model";
import type { UploadForm, UploadIntent, UploadType } from "./upload-model";

const form = (type: UploadType = "image"): UploadForm => ({
  type,
  files: type === "text" ? [] : [{ path: "private-temp", name: "a.png", size: 8 }],
  textBody: type === "text" ? "门店故事" : "",
  note: "",
  tags: [],
  demandId: null,
});
const intent = (type: UploadType = "image"): UploadIntent => ({
  version: 1,
  id: "intent",
  createKey: "asset_create:original",
  expiresAt: 1000,
  owner: {
    userId: "u",
    memberId: "m",
    entityId: "e",
    storeId: "s",
    role: "owner",
    storeScope: "all",
  },
  type,
  textBody: type === "text" ? "门店故事" : "",
  note: "",
  tags: ["content-a"],
  demandId: null,
  phase: "uploading",
  files:
    type === "text"
      ? []
      : [
          {
            name: "a.png",
            size: 8,
            width: 0,
            height: 0,
            durationMs: 0,
            token: "fingerprint",
            fileId: "file-a",
            cancelKey: "cancel:a",
            status: "stored",
          },
        ],
});

describe("素材上传表单与冻结请求", () => {
  it("六个真实类型齐全", () => {
    expect(uploadTypes).toEqual(["image", "video", "recording", "audio", "document", "text"]);
  });
  it.each([
    ["image", "a.JPG"],
    ["image", "a.jpeg"],
    ["image", "a.png"],
    ["video", "a.mp4"],
    ["video", "a.mov"],
    ["recording", "a.mp3"],
    ["audio", "a.mp3"],
    ["audio", "a.m4a"],
    ["audio", "a.wav"],
    ["audio", "a.aac"],
    ["document", "a.pdf"],
    ["document", "a.docx"],
    ["document", "a.txt"],
  ] as const)("允许当前服务支持的 %s/%s", (type, name) => {
    const input = form(type);
    input.files[0]!.name = name;
    expect(() => validateUploadForm(input)).not.toThrow();
  });
  it.each(["a.xls", "a.pptx", "a.doc", "a.exe", "no-extension"])("不扩展文档格式 %s", (name) => {
    const input = form("document");
    input.files[0]!.name = name;
    expect(() => validateUploadForm(input)).toThrow();
  });
  it.each([0, 10])("文件数拒绝 %i", (count) => {
    const input = form();
    input.files = Array.from({ length: count }, () => ({ ...input.files[0]! }));
    expect(() => validateUploadForm(input)).toThrow();
  });
  it("九个文件、八个标签及200字说明允许", () => {
    const input = form();
    input.files = Array.from({ length: 9 }, () => ({ ...input.files[0]! }));
    input.tags = Array.from({ length: 8 }, (_, n) => `tag-${n}`);
    input.note = "说".repeat(200);
    expect(() => validateUploadForm(input)).not.toThrow();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])("非法字节数 %s", (size) => {
    const input = form();
    input.files[0]!.size = size;
    expect(() => validateUploadForm(input)).toThrow();
  });
  it.each(["", " ", "字".repeat(501)])("文字边界拒绝空白或超长 [%s]", (textBody) => {
    expect(() => validateUploadForm({ ...form("text"), textBody })).toThrow();
  });
  it("文字500字且无文件或说明", () => {
    expect(() => validateUploadForm({ ...form("text"), textBody: "字".repeat(500) })).not.toThrow();
    expect(() => validateUploadForm({ ...form("text"), note: "说明" })).toThrow();
    expect(() => validateUploadForm({ ...form("text"), files: form().files })).toThrow();
  });
  it("文件类型不接受正文、过长说明和重复标签", () => {
    expect(() => validateUploadForm({ ...form(), textBody: "正文" })).toThrow();
    expect(() => validateUploadForm({ ...form(), note: "字".repeat(201) })).toThrow();
    expect(() => validateUploadForm({ ...form(), tags: ["a", "a"] })).toThrow();
    expect(() =>
      validateUploadForm({ ...form(), tags: Array.from({ length: 9 }, (_, n) => `${n}`) }),
    ).toThrow();
  });
  it("录音限一段且不超过300000ms", () => {
    const input = form("recording");
    input.files[0] = { ...input.files[0]!, name: "recording.mp3", durationMs: 300000 };
    expect(() => validateUploadForm(input)).not.toThrow();
    expect(() =>
      validateUploadForm({ ...input, files: [...input.files, ...input.files] }),
    ).toThrow();
    expect(() =>
      validateUploadForm({ ...input, files: [{ ...input.files[0]!, durationMs: 300001 }] }),
    ).toThrow();
  });
  it.each(["pending", "cancelled"] as const)("%s 不能引用创建素材", (status) => {
    const input = intent();
    input.files[0]!.status = status;
    expect(() => intentBody(input)).toThrow(/入库/u);
  });
  it("缺fileId或重复引用不能创建", () => {
    const input = intent();
    input.files[0]!.fileId = null;
    expect(() => intentBody(input)).toThrow();
    input.files[0]!.fileId = "file-a";
    input.files.push({ ...input.files[0]! });
    expect(() => intentBody(input)).toThrow(/重复/u);
  });
  it("文件body只有服务端字段，标签复制而非共享可变引用", () => {
    const input = intent();
    input.note = "门店说明";
    input.demandId = "demand-a";
    const body = intentBody(input);
    input.tags.push("later");
    expect(body).toEqual({
      type: "image",
      fileIds: ["file-a"],
      note: "门店说明",
      contentTagCodes: ["content-a"],
      assetDemandId: "demand-a",
    });
    expect(JSON.stringify(body)).not.toMatch(/private-temp|cancelKey|createKey|fingerprint/u);
  });
  it("文字body不带fileIds、note或空需求", () => {
    expect(intentBody(intent("text"))).toEqual({
      type: "text",
      textBody: "门店故事",
      contentTagCodes: ["content-a"],
    });
  });
});

describe("真实 typed 素材 API 边界", () => {
  it("create 原键原体；需求游标编码；标签仅当前启用content维度", async () => {
    const calls: { path: string; options: unknown }[] = [];
    const content = { code: "content", isSelectable: true, ext: { dimension: "content" } };
    const send: RequestLayer["request"] = async <T>(
      path: string,
      options?: unknown,
    ): Promise<T> => {
      calls.push({ path, options });
      return (
        path.includes("dict-items")
          ? {
              items: [
                { typeKey: "other", items: [content] },
                {
                  typeKey: "asset_tag",
                  items: [
                    content,
                    { ...content, code: "disabled", isSelectable: false },
                    { ...content, code: "format", ext: { dimension: "format" } },
                  ],
                },
              ],
            }
          : { items: [], hasMore: false, nextCursor: null }
      ) as T;
    };
    const api = createAssetUploadApi(send),
      body = intentBody(intent());
    await api.create(body, "asset_create:stable");
    await api.demands("a+/=?");
    expect(await api.tags()).toEqual([content]);
    expect(calls).toEqual([
      {
        path: "/m/store-assets",
        options: { method: "POST", data: body, idempotencyKey: "asset_create:stable" },
      },
      { path: "/m/asset-demands?status=open&limit=20&cursor=a%2B%2F%3D%3F", options: undefined },
      { path: "/m/dict-items?typeKey=asset_tag&includeDisabled=false", options: undefined },
    ]);
  });
});
