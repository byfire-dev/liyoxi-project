// Real file handlers and CPU converter; only private object storage is fictional.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSeed, SEED_MODULES, uuidv7 } from "@liyoxi/services";
import {
  fictionalDocumentDocx,
  fictionalDocumentPdf,
  signInAsStaff,
} from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import type { FileRegistration, AgreementVersionMutationResult } from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
const apiDir = fileURLToPath(new URL("../", import.meta.url));
const output = `dist/test-legal-upload-${process.pid}-${Date.now().toString(36)}`;
let api: TestApi;
let editor: SignedInStaff;
let reader: SignedInStaff;
let storage: FakeStorage;
let peer = 0;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const post = (path: string, json: unknown, staff = editor, key = uuidv7()) =>
  api.request(`/api/v1${path}`, {
    method: "POST",
    json,
    headers: { ...staff.headers, "idempotency-key": key },
    peer: `198.19.78.${++peer}`,
  });
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
const request = (ext = "pdf", bytes = fictionalDocumentPdf()) => ({
  category: "legal_doc",
  fileName: `fictional-agreement.${ext}`,
  sizeBytes: String(bytes.byteLength),
  clientToken: uuidv7(),
});
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ["scripts/build.mjs", "--outdir", output], {
    cwd: apiDir,
  });
  api = await handle.start({
    documentConverterWorkerUrl: pathToFileURL(`${apiDir}${output}/document-converter.js`),
  });
  await runSeed({ tx: api.runtime.tx, clock: api.clock, modules: SEED_MODULES });
  const db = await handle.db.prisma();
  editor = await signInAsStaff(db, { roleKey: "super_admin", now: api.clock.now() });
  reader = await signInAsStaff(db, { roleKey: "editor", now: api.clock.now() });
  const role = await db.staffRole.findUniqueOrThrow({ where: { key: "editor" } });
  const levels = role.moduleLevels as Record<string, string>;
  await db.staffRole.update({
    where: { key: "editor" },
    data: { moduleLevels: { ...levels, ops: "v" } },
  });
  storage = api.runtime.providers.storage as FakeStorage;
}, 120_000);
afterAll(() => rmSync(`${apiDir}${output}`, { recursive: true, force: true }));

describe("协议正文后台上传正式授权与真实入库", () => {
  it.each(["pdf", "docx"] as const)("ops编辑上传%s后能作为本人草稿正文", async (ext) => {
    const bytes = ext === "pdf" ? fictionalDocumentPdf() : fictionalDocumentDocx();
    const input = request(ext, bytes);
    const file = await data<FileRegistration>(await post("/admin/files", input));
    const reused = await data<FileRegistration>(await post("/admin/files", input));
    expect(reused.fileId).toBe(file.fileId);
    storage.put(
      { bucket: "secure", key: file.key },
      bytes,
      ext === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    await data(await post(`/admin/files/${file.fileId}/complete`, {}));
    const db = await handle.db.prisma();
    const job = await db.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${file.fileId}` },
    });
    await api.runtime.media.promote({ jobId: job.id });
    const stored = await db.fileObject.findUniqueOrThrow({ where: { id: file.fileId } });
    expect(stored).toMatchObject({
      status: "stored",
      category: "legal_doc",
      bucket: "secure",
      scopeType: "platform",
      entityId: null,
      storeId: null,
      onBehalfStoreId: null,
      uploadActorType: "staff",
      uploadActorId: editor.staff.id,
      uploadClient: "admin",
      ext,
      sizeBytes: BigInt(bytes.byteLength),
    });
    expect(
      await data(
        await api.request(`/api/v1/admin/files/${file.fileId}`, {
          headers: editor.headers,
        }),
      ),
    ).toMatchObject({ status: "stored", fileId: file.fileId });
    const unsigned = await post(`/admin/files/${file.fileId}/download-urls`, {});
    expect(unsigned.status).toBe(404);
    const result = await data<AgreementVersionMutationResult>(
      await post(
        `/admin/agreements/${ext === "pdf" ? "user" : "privacy"}/agreement-versions`,
        ext === "pdf" ? { pdfFileId: file.fileId } : { sourceFileId: file.fileId },
      ),
    );
    expect(result.version.isLegalApproved).toBe(false);
    if (ext === "pdf") expect(result.version.contentSha256).toBe(sha(bytes));
    else expect(result.contentHtml).toContain("狸有戏虚构协议");
    expect(
      await db.fileRef.count({
        where: {
          fileId: file.fileId,
          refType: "agreement_version",
          refId: result.version.agreementVersionId,
          state: "live",
          role: ext === "pdf" ? "pdf" : "source",
        },
      }),
    ).toBe(1);
  });
  it("只读、错误扩展/范围及系统专用类别拒绝且无新增行", async () => {
    const db = await handle.db.prisma();
    const before = await db.fileObject.count();
    const cases = [
      { input: request(), staff: reader, status: 403, error: "PERMISSION_DENIED" },
      { input: request("txt"), staff: editor, status: 400, error: "FILE_TYPE_NOT_ALLOWED" },
      {
        input: { ...request(), storeId: uuidv7() },
        staff: editor,
        status: 400,
        error: "FILE_CATEGORY_NOT_ALLOWED",
      },
      {
        input: { ...request(), entityId: uuidv7() },
        staff: editor,
        status: 400,
        error: "FILE_CATEGORY_NOT_ALLOWED",
      },
      {
        input: { ...request(), onBehalfStore: true },
        staff: editor,
        status: 400,
        error: "FILE_CATEGORY_NOT_ALLOWED",
      },
      {
        input: { ...request(), category: "seal_image" },
        staff: editor,
        status: 400,
        error: "FILE_CATEGORY_NOT_ALLOWED",
      },
    ];
    for (const item of cases) {
      const response = await post("/admin/files", item.input, item.staff);
      expect(response.status, await response.clone().text()).toBe(item.status);
      expect(await response.json()).toMatchObject({ error: item.error });
    }
    expect(await db.fileObject.count()).toBe(before);
  });
});
