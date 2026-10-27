import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "../../kernel/index.js";
import { createDocsAdminFixture, fictionalDocumentPdf, useSeededDatabase } from "../index.js";
import { findBillingLiveUploadJobIds } from "./billing-upload.js";
const db = useSeededDatabase("services");
let h: ReturnType<typeof createDocsAdminFixture>;
let prepared: Awaited<ReturnType<typeof prepare>>;
beforeAll(async () => {
  h = createDocsAdminFixture(await db.prisma());
  prepared = await prepare();
});
afterAll(async () => {
  await h?.close();
});
async function prepare() {
  const actor = await h.actor(),
    other = await h.actor(),
    merchant = await h.make.merchant({ verified: true }),
    bytes = fictionalDocumentPdf();
  // complete 对小文件保留原3秒入库轮询；反例文件在fixture阶段真实入队，测试本身不串等两次窗口。
  const legal = await h.media.register(actor, {
    category: "legal_doc",
    files: [
      {
        fileName: "fictional-agreement.pdf",
        sizeBytes: String(bytes.length),
        clientToken: uuidv7(),
      },
    ],
  });
  h.providers.storage.put({ bucket: "secure", key: legal.items[0]!.key }, bytes, "application/pdf");
  await h.media.completeAdmin(actor, legal.items[0]!.fileId);
  return { actor, other, merchant, bytes, legalId: legal.items[0]!.fileId };
}
it("仅本人同主体pay_receipt单个成功登记入队；真实promote后不重复，外人/外主体/协议文件均不扫描任务", async () => {
  const { actor, other, merchant, bytes, legalId } = prepared;
  const registration = await h.media.register(actor, {
      category: "pay_receipt",
      entityId: merchant.entity.id,
      files: [
        {
          fileName: "fictional-receipt.pdf",
          sizeBytes: String(bytes.length),
          clientToken: uuidv7(),
        },
      ],
    }),
    file = registration.items[0]!;
  const input = {
    staffId: actor.staff.staff.id,
    entityId: merchant.entity.id,
    fileIds: [file.fileId],
  };
  expect(await findBillingLiveUploadJobIds(h, input)).toEqual([]);
  h.providers.storage.put({ bucket: "secure", key: file.key }, bytes, "application/pdf");
  await h.media.completeAdmin(actor, file.fileId);
  expect(await findBillingLiveUploadJobIds(h, { ...input, staffId: other.staff.staff.id })).toEqual(
    [],
  );
  expect(await findBillingLiveUploadJobIds(h, { ...input, entityId: uuidv7() })).toEqual([]);
  const jobs = await findBillingLiveUploadJobIds(h, input);
  expect(jobs).toHaveLength(1);
  await h.media.promote({ jobId: jobs[0]! });
  expect(await h.prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } })).toMatchObject(
    {
      status: "stored",
      entityId: merchant.entity.id,
      uploadActorId: actor.staff.staff.id,
      category: "pay_receipt",
      sizeBytes: BigInt(bytes.length),
    },
  );
  expect(await findBillingLiveUploadJobIds(h, input)).toEqual([]);
  expect(await findBillingLiveUploadJobIds(h, { ...input, fileIds: [legalId] })).toEqual([]);
});
it("范围输入在访问事务前拒绝多文件或无效ID，空集合不访问库", async () => {
  const run = vi.spyOn(h.tx, "run"),
    input = { staffId: uuidv7(), entityId: uuidv7(), fileIds: [uuidv7()] };
  try {
    for (const wrong of [
      { ...input, fileIds: [uuidv7(), uuidv7()] },
      { ...input, fileIds: ["bad"] },
      { ...input, staffId: "bad" },
      { ...input, entityId: "bad" },
    ])
      await expect(findBillingLiveUploadJobIds(h, wrong)).rejects.toThrow("范围不合法");
    expect(await findBillingLiveUploadJobIds(h, { ...input, fileIds: [] })).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  } finally {
    run.mockRestore();
  }
});
