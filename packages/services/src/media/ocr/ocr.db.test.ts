import { createSessionMutexConnectionFactory } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvents } from "../../events/index.js";
import { createSessionMutex, createTxRunner, isInTransaction, uuidv7 } from "../../kernel/index.js";
import type { OcrProvider } from "../../providers/types.js";
import { decryptField, encryptField } from "../../security/index.js";
import {
  assembleForTest,
  assertSnapshotsEqual,
  createClock,
  createFactories,
  createFakeProviders,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "../../testing/index.js";
import { createMedia } from "../index.js";
import type { QualificationOcrInput } from "./service.js";

const db = useSeededDatabase("services", { label: "kycocr", max: 1 });
const clock = createClock(),
  fake = createFakeProviders({ clock });
let prisma: Awaited<ReturnType<typeof db.prisma>>,
  make: ReturnType<typeof createFactories>,
  tx: ReturnType<typeof createTxRunner>,
  mutex: ReturnType<typeof createSessionMutex>;
beforeAll(async () => {
  prisma = await db.prisma();
  make = createFactories({ db: prisma, clock });
  tx = createTxRunner({ prisma, appEnv: "test" });
  mutex = createSessionMutex({
    connect: createSessionMutexConnectionFactory({ connectionString: await db.url() }),
    maxConcurrent: 2,
    probeMs: 50,
  });
}, 120000);
afterAll(async () => mutex?.close());
function media(provider: OcrProvider | null = fake.ocr) {
  const assembly = assembleForTest({ entry: "api" });
  return createMedia({
    tx,
    clock,
    assembly,
    events: createEvents({ tx, clock, assembly }),
    storage: fake.storage,
    ...(provider ? { ocr: { provider, sessionMutex: mutex, keyring: () => TEST_KEYRING } } : {}),
  });
}
async function target() {
  const owner = await make.merchant();
  const file = await make.fileObject({
    category: "kyc_license",
    bucket: "secure",
    scopeType: "entity",
    entityId: owner.entity.id,
    storeId: null,
    uploadActorType: "merchant",
    uploadActorId: owner.user.id,
    uploadClient: "weapp",
    etag: "etag-current",
    crc64: "123",
  });
  fake.storage.put({ bucket: "secure", key: file.objectKey }, new Uint8Array(1024), "image/jpeg");
  const input: QualificationOcrInput = {
    fileId: file.id,
    docType: "business_license",
    entityId: owner.entity.id,
    storeId: owner.store.id,
    merchantUserId: owner.user.id,
  };
  return { owner, file, input };
}
const row = (input: QualificationOcrInput, status = "unreadable", at = clock.now()) => ({
  id: uuidv7(),
  entityId: input.entityId,
  storeId: input.storeId,
  fileId: input.fileId,
  docType: "business_license",
  permitType: null,
  provider: "fake",
  status,
  fieldsEnc:
    status === "ok"
      ? encryptField(
          TEST_KEYRING,
          "ocr_result.fields_enc",
          JSON.stringify({
            name: "已保存最新识别",
            uscc: "",
            principal: "",
            subjectType: "unknown",
          }),
        )
      : null,
  warnings: [],
  requestActorType: "merchant",
  requestActorId: input.merchantUserId,
  requestClient: "weapp",
  createdAt: at,
  updatedAt: at,
});
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((done) => {
    open = done;
  });
  return { wait, open };
}

describe("W316媒体同步OCR真实DB", () => {
  it("独立加密结果、最新ok精确scope复用且无跨文件摘要缓存；缺配/日额0不阻止已有事实", async () => {
    clock.set(new Date("2026-01-09T15:59:59Z"));
    const a = await target(),
      service = media();
    fake.ocr.defaultLicense = {
      name: "真实替身名称",
      uscc: " 91310000fake000001 ",
      principal: "原识别负责人",
      subjectType: "individual",
      address: "虚构登记地址",
      validTo: "long_term",
      warnings: ["WARN_COPY_CARD"],
      raw: '{"Type":"个体工商户","Period":"长期"}',
    };
    const calls = fake.ocr.callsOf("recognizeBusinessLicense").length;
    const resultId = await service.ocr.recognize(a.input);
    expect(resultId).not.toBeNull();
    const saved = await prisma.ocrResult.findUniqueOrThrow({ where: { id: resultId! } });
    expect(saved).toMatchObject({
      entityId: a.owner.entity.id,
      storeId: a.owner.store.id,
      fileId: a.file.id,
      docType: "business_license",
      status: "ok",
      requestActorType: "merchant",
      requestActorId: a.owner.user.id,
      requestClient: "weapp",
    });
    expect(
      JSON.parse(decryptField(TEST_KEYRING, "ocr_result.fields_enc", saved.fieldsEnc!)),
    ).toEqual({
      name: "真实替身名称",
      uscc: "91310000FAKE000001",
      principal: "原识别负责人",
      subjectType: "individual",
      principalRole: "operator",
      address: "虚构登记地址",
      validTo: "long_term",
    });
    expect(decryptField(TEST_KEYRING, "ocr_result.raw_enc", saved.rawEnc!)).toBe(
      fake.ocr.defaultLicense.raw,
    );
    expect(saved.rawPurgeAt).toEqual(new Date(clock.now().getTime() + 30 * 86400000));
    expect(saved.fieldsEnc).not.toContain("真实替身名称");
    expect(saved.rawEnc).not.toContain("个体工商户");
    expect(fake.ocr.callsOf("recognizeBusinessLicense")).toHaveLength(calls + 1);
    const tables = ["ocr_result", "media_job", "outbox_event", "audit_log", "file_ref"];
    const before = await snapshotTables(prisma, tables);
    expect(await media(null).ocr.recognize(a.input)).toBe(resultId);
    expect(await service.ocr.recognize(a.input)).toBe(resultId);
    assertSnapshotsEqual(before, await snapshotTables(prisma, tables));

    const latest = await prisma.ocrResult.create({
      data: row(a.input, "ok", new Date(clock.now().getTime() + 1)),
    });
    await prisma.ocrResult.create({
      data: row(a.input, "unreadable", new Date(clock.now().getTime() + 2)),
    });
    expect(await service.ocr.recognize(a.input)).toBe(latest.id);
    expect(fake.ocr.callsOf("recognizeBusinessLicense")).toHaveLength(calls + 1);
    const otherStore = await make.store({ entityId: a.owner.entity.id });
    const otherResult = await service.ocr.recognize({ ...a.input, storeId: otherStore.id });
    expect(otherResult).not.toBe(latest.id);
    expect(
      (await prisma.ocrResult.findUniqueOrThrow({ where: { id: otherResult! } })).storeId,
    ).toBe(otherStore.id);
    const sameBytes = await make.fileObject({
      category: "kyc_license",
      bucket: "secure",
      scopeType: "entity",
      entityId: a.owner.entity.id,
      storeId: null,
      uploadActorType: "merchant",
      uploadActorId: a.owner.user.id,
      uploadClient: "weapp",
      crc64: a.file.crc64,
      sizeBytes: a.file.sizeBytes,
    });
    fake.storage.put(
      { bucket: "secure", key: sameBytes.objectKey },
      new Uint8Array(1024),
      "image/jpeg",
    );
    expect(await service.ocr.recognize({ ...a.input, fileId: sameBytes.id })).not.toBe(latest.id);
    expect(fake.ocr.callsOf("recognizeBusinessLicense")).toHaveLength(calls + 3);
    await prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key: "ocr.daily_limit_per_store",
        value: 0,
        effectiveAt: clock.now(),
        createdByStaffId: uuidv7(),
        createdAt: clock.now(),
      },
    });
    const fresh = await target();
    expect(await service.ocr.recognize(fresh.input)).toBeNull();
    expect(await service.ocr.recognize(a.input)).toBe(latest.id);
    expect(fake.ocr.callsOf("recognizeBusinessLicense")).toHaveLength(calls + 3);
  });

  it("前置文件守卫零外呼，失败手填不造unavailable行；真实会话互斥封住20次边界并按北京时间重置", async () => {
    clock.set(new Date("2026-01-10T15:59:59Z"));
    await prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key: "ocr.daily_limit_per_store",
        value: 20,
        effectiveAt: clock.now(),
        createdByStaffId: uuidv7(),
        createdAt: clock.now(),
      },
    });
    const a = await target(),
      service = media();
    const calls = fake.ocr.callsOf("recognizeBusinessLicense").length;
    for (const [data, reason] of [
      [{ status: "deleted", deletedAt: clock.now() }, "not_stored"],
      [{ moderationState: "block" }, "blocked"],
    ] as const) {
      await prisma.fileObject.update({ where: { id: a.file.id }, data });
      await expect(service.ocr.recognize(a.input)).rejects.toMatchObject({
        error: "FILE_NOT_USABLE",
        details: { reason },
      });
      await prisma.fileObject.update({
        where: { id: a.file.id },
        data: { status: "stored", deletedAt: null, moderationState: "none" },
      });
    }
    await expect(
      service.ocr.recognize({ ...a.input, merchantUserId: uuidv7() }),
    ).rejects.toMatchObject({ error: "FILE_NOT_USABLE", details: { reason: "scope_mismatch" } });
    await expect(
      service.ocr.recognize({
        ...a.input,
        docType: "industry_permit",
        permitType: "food_business",
      }),
    ).rejects.toMatchObject({ error: "FILE_NOT_USABLE", details: { reason: "category_mismatch" } });
    expect(fake.ocr.callsOf("recognizeBusinessLicense")).toHaveLength(calls);
    fake.ocr.failNext("recognizeBusinessLicense");
    expect(await service.ocr.recognize(a.input)).toBeNull();
    expect(await prisma.ocrResult.count({ where: { storeId: a.owner.store.id } })).toBe(0);
    fake.ocr.failNext("recognizeBusinessLicense", { reason: "rejected" });
    const unreadable = await service.ocr.recognize(a.input);
    expect(await prisma.ocrResult.findUniqueOrThrow({ where: { id: unreadable! } })).toMatchObject({
      status: "unreadable",
      fieldsEnc: null,
    });
    await prisma.ocrResult.createMany({ data: Array.from({ length: 18 }, () => row(a.input)) });
    const entered = gate(),
      release = gate();
    let inTx = true;
    const slow: OcrProvider = {
      ...fake.ocr,
      recognizeBusinessLicense: async (input) => {
        inTx = isInTransaction();
        entered.open();
        await release.wait;
        return fake.ocr.recognizeBusinessLicense(input);
      },
    };
    const pending = media(slow).ocr.recognize(a.input);
    await entered.wait;
    expect(inTx).toBe(false);
    const second = await make.fileObject({
      category: "kyc_license",
      bucket: "secure",
      scopeType: "entity",
      entityId: a.owner.entity.id,
      storeId: null,
      uploadActorType: "merchant",
      uploadActorId: a.owner.user.id,
      uploadClient: "weapp",
    });
    expect(await service.ocr.recognize({ ...a.input, fileId: second.id })).toBeNull();
    release.open();
    expect(await pending).not.toBeNull();
    expect(await prisma.ocrResult.count({ where: { storeId: a.owner.store.id } })).toBe(20);
    expect(await service.ocr.recognize({ ...a.input, fileId: second.id })).toBeNull();
    fake.storage.put(
      { bucket: "secure", key: second.objectKey },
      new Uint8Array(1024),
      "image/jpeg",
    );
    clock.set(new Date("2026-01-10T16:00:00Z"));
    expect(await service.ocr.recognize({ ...a.input, fileId: second.id })).not.toBeNull();
    expect(
      await prisma.ocrResult.count({
        where: { storeId: a.owner.store.id, createdAt: { gte: clock.now() } },
      }),
    ).toBe(1);
    expect(await prisma.mediaJob.count({ where: { kind: "ocr" } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { eventType: "media.ocr.completed" } })).toBe(0);
  });
});
