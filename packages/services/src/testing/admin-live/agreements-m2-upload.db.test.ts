import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../../kernel/index.js";
import { createDocsAdminFixture, fictionalDocumentPdf, useSeededDatabase } from "../index.js";
import { findAgreementLiveUploadJobIds } from "./agreements-m2-upload.js";

const db = useSeededDatabase("services");
let h: ReturnType<typeof createDocsAdminFixture>;
beforeAll(async () => {
  h = createDocsAdminFixture(await db.prisma());
});
afterAll(async () => {
  await h?.close();
});

describe("W216 真实上传任务范围", () => {
  it("仅本次本人legal_doc promoting；真实promote入库后不再次执行", async () => {
    const actor = await h.actor(),
      other = await h.actor(),
      bytes = fictionalDocumentPdf();
    const registered = await h.media.register(actor, {
      category: "legal_doc",
      files: [
        { fileName: "fictional.pdf", sizeBytes: String(bytes.length), clientToken: uuidv7() },
      ],
    });
    const file = registered.items[0];
    if (!file) throw new Error("缺少真实登记结果");
    const input = { staffId: actor.staff.staff.id, fileIds: [file.fileId] };
    expect(await findAgreementLiveUploadJobIds(h, input)).toEqual([]);
    h.providers.storage.put({ bucket: "secure", key: file.key }, bytes, "application/pdf");
    await h.media.completeAdmin(actor, file.fileId);
    expect(
      await findAgreementLiveUploadJobIds(h, { ...input, staffId: other.staff.staff.id }),
    ).toEqual([]);
    expect(await findAgreementLiveUploadJobIds(h, { ...input, fileIds: [uuidv7()] })).toEqual([]);
    const jobs = await findAgreementLiveUploadJobIds(h, input);
    expect(jobs).toHaveLength(1);
    const jobId = jobs[0];
    if (!jobId) throw new Error("缺少真实待执行任务");
    const job = await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({
      subjectType: "file_object",
      subjectId: file.fileId,
      dedupeKey: `promote:${file.fileId}`,
      kind: "promote",
      state: "queued",
    });
    await h.media.promote({ jobId });
    expect(
      await h.prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } }),
    ).toMatchObject({
      status: "stored",
      uploadActorId: actor.staff.staff.id,
      category: "legal_doc",
      sizeBytes: BigInt(bytes.length),
    });
    expect(await findAgreementLiveUploadJobIds(h, input)).toEqual([]);
  });
  it("非法、重复、超界ID明确拒绝且不访问事务，空集合不扫描", async () => {
    const run = vi.spyOn(h.tx, "run"),
      staffId = uuidv7(),
      id = uuidv7();
    try {
      for (const fileIds of [["bad-id"], [id, id], Array.from({ length: 9 }, () => uuidv7())])
        await expect(findAgreementLiveUploadJobIds(h, { staffId, fileIds })).rejects.toThrow(
          "范围不合法",
        );
      await expect(
        findAgreementLiveUploadJobIds(h, { staffId: "bad-staff", fileIds: [id] }),
      ).rejects.toThrow("范围不合法");
      expect(await findAgreementLiveUploadJobIds(h, { staffId, fileIds: [] })).toEqual([]);
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });
});
