import { createSessionMutexConnectionFactory } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvents } from "../../events/index.js";
import {
  createIdentityContext,
  createSessionMutex,
  createTxRunner,
  uuidv7,
} from "../../kernel/index.js";
import { decryptField } from "../../security/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  TEST_KEYRING,
  useSeededDatabase,
} from "../../testing/index.js";
import { createMedia } from "../index.js";
import type { Media } from "../index.js";

const db = useSeededDatabase("services", { label: "receipt", max: 1 });
const clock = createClock(),
  fake = createFakeProviders({ clock });
let prisma: Awaited<ReturnType<typeof db.prisma>>,
  make: ReturnType<typeof createFactories>,
  tx: ReturnType<typeof createTxRunner>,
  mutex: ReturnType<typeof createSessionMutex>;
const owned: Media[] = [];
beforeAll(async () => {
  prisma = await db.prisma();
  make = createFactories({ db: prisma, clock });
  tx = createTxRunner({ prisma, appEnv: "test" });
  mutex = createSessionMutex({
    connect: createSessionMutexConnectionFactory({ connectionString: await db.url() }),
    maxConcurrent: 1,
  });
}, 90_000);
afterAll(async () => {
  for (const media of owned) await media.jobs.shutdown();
  await mutex?.close();
});
function media(configured = true) {
  const assembly = assembleForTest({ entry: "api" });
  const instance = createMedia({
    tx,
    clock,
    assembly,
    storage: fake.storage,
    events: createEvents({ tx, clock, assembly }),
    ...(configured
      ? { ocr: { provider: fake.ocr, keyring: () => TEST_KEYRING, sessionMutex: mutex } }
      : {}),
  });
  owned.push(instance);
  return instance;
}
async function target() {
  const owner = await make.merchant();
  const file = await make.fileObject({
    category: "pay_receipt",
    bucket: "secure",
    scopeType: "entity",
    entityId: owner.entity.id,
    storeId: null,
    uploadActorType: "merchant",
    uploadActorId: owner.user.id,
    uploadClient: "weapp",
    etag: "receipt-etag",
    ext: "pdf",
    declaredMime: "application/pdf",
    mime: "application/pdf",
  });
  fake.storage.put(
    { bucket: "secure", key: file.objectKey },
    new Uint8Array(1024),
    "application/pdf",
  );
  return {
    input: { fileId: file.id, entityId: owner.entity.id },
    ctx: createIdentityContext({
      actor: { type: "merchant", id: owner.user.id, client: "weapp" },
      entityId: owner.entity.id,
    }),
  };
}

describe("W4-04 银行回单技术任务", { timeout: 30_000 }, () => {
  it("调用方回滚零行；真实runner完成/缓存/密文脱敏/范围与终态失败，账务表零写", async () => {
    const off = media(false),
      active = media(),
      item = await target();
    const money = async () => ({
      orders: await prisma.billingOrder.count(),
      proofs: await prisma.transferProof.count(),
      transactions: await prisma.paymentTxn.count(),
      operations: await prisma.ledgerOperation.count(),
      terms: await prisma.subscriptionTerm.count(),
    });
    const moneyBefore = await money();
    const before = {
      ocr: await prisma.ocrResult.count(),
      jobs: await prisma.mediaJob.count(),
      events: await prisma.outboxEvent.count(),
    };
    expect(await tx.run((t) => off.enqueueBankReceiptOcr(t, item.ctx, item.input))).toEqual({
      ocrResultId: null,
      status: "unavailable",
    });
    await expect(
      tx.run(async (t) => {
        await active.enqueueBankReceiptOcr(t, item.ctx, item.input);
        throw new Error("caller rollback");
      }),
    ).rejects.toThrow("caller rollback");
    expect({
      ocr: await prisma.ocrResult.count(),
      jobs: await prisma.mediaJob.count(),
      events: await prisma.outboxEvent.count(),
    }).toEqual(before);
    fake.ocr.defaultReceipt = {
      payerName: null,
      payerAccount: "1234567890123456",
      payeeName: null,
      amountFen: 123456,
      remark: null,
      tradedAt: "2026-10-16T04:34:56.000Z",
      warnings: ["MISSING_PAYER_NAME"],
      raw: '{"public":"RAW_RECEIPT_MARKER"}',
    };
    const created = await tx.run((t) => active.enqueueBankReceiptOcr(t, item.ctx, item.input));
    expect(created.status).toBe("pending");
    const id = created.ocrResultId!;
    const job = await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `ocr:bank_receipt:${id}` },
    });
    expect(job).toMatchObject({
      kind: "ocr",
      mode: "local",
      subjectType: "ocr_result",
      subjectId: id,
      maxAttempts: 3,
    });
    await active.jobs.run({ jobId: job.id });
    const read = await tx.run((t) =>
      active.readBankReceiptOcr(t, { ...item.input, ocrResultId: id }),
    );
    expect(read).toMatchObject({
      status: "ok",
      recognized: { payerAccountMask: "****3456", amountFen: 123456 },
    });
    expect(JSON.stringify(read)).not.toContain("1234567890123456");
    expect(JSON.stringify(read)).not.toContain("RAW_RECEIPT_MARKER");
    const saved = await prisma.ocrResult.findUniqueOrThrow({ where: { id } });
    expect(saved.fieldsEnc).not.toContain("1234567890123456");
    expect(decryptField(TEST_KEYRING, "ocr_result.fields_enc", saved.fieldsEnc!)).toContain(
      "1234567890123456",
    );
    expect(saved.rawEnc).not.toContain("RAW_RECEIPT_MARKER");
    expect(saved.rawPurgeAt?.getTime()).toBe(clock.now().getTime() + 30 * 86400000);
    expect((await prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).output).toEqual({
      ocrResultId: id,
      status: "ok",
    });
    expect(await tx.run((t) => active.enqueueBankReceiptOcr(t, item.ctx, item.input))).toEqual({
      ocrResultId: id,
      status: "ok",
    });
    await active.jobs.run({ jobId: job.id });
    expect(fake.ocr.callsOf("recognizeBankReceipt")).toHaveLength(1);
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "media.ocr.completed", aggregateId: id },
    });
    expect(event.payload).toEqual({
      v: 1,
      ocrResultId: id,
      fileId: item.input.fileId,
      entityId: item.input.entityId,
      mediaJobId: job.id,
      docType: "bank_receipt",
      status: "ok",
    });
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: "media.ocr.completed", aggregateId: id },
      }),
    ).toBe(1);
    expect(
      await tx.run((t) =>
        active.readBankReceiptOcr(t, { ...item.input, ocrResultId: id, mediaJobId: job.id }),
      ),
    ).toEqual(read);
    expect(
      await tx.run((t) =>
        active.readBankReceiptOcr(t, { ...item.input, ocrResultId: id, mediaJobId: uuidv7() }),
      ),
    ).toBeNull();
    const other = await target();
    expect(
      await tx.run((t) => active.readBankReceiptOcr(t, { ...other.input, ocrResultId: id })),
    ).toBeNull();
    fake.ocr.failNext("recognizeBankReceipt", { reason: "unavailable", times: 3 });
    const pending = await tx.run((t) => active.enqueueBankReceiptOcr(t, other.ctx, other.input));
    const failedJob = await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `ocr:bank_receipt:${pending.ocrResultId}` },
    });
    expect(
      await tx.run((t) =>
        active.readBankReceiptOcr(t, {
          ...other.input,
          ocrResultId: pending.ocrResultId!,
          mediaJobId: job.id,
        }),
      ),
    ).toBeNull();
    for (let attempt = 0; attempt < 3; attempt++) {
      await active.jobs.run({ jobId: failedJob.id });
      const current = await prisma.mediaJob.findUniqueOrThrow({ where: { id: failedJob.id } });
      if (attempt < 2) {
        expect(current.state).toBe("queued");
        clock.set(current.nextRunAt);
      } else expect(current).toMatchObject({ state: "failed", attemptNo: 3 });
    }
    expect(
      await tx.run((t) =>
        active.readBankReceiptOcr(t, { ...other.input, ocrResultId: pending.ocrResultId! }),
      ),
    ).toMatchObject({ status: "unavailable", recognized: null });
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: "media.ocr.completed", aggregateId: pending.ocrResultId! },
      }),
    ).toBe(1);
    expect(await money()).toEqual(moneyBefore);
  });
});
