import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { STAFF_ROLE_DEFAULTS, defaultRoleActions } from "@liyoxi/contract";
import { readUrlExpiry } from "@liyoxi/shared/uploads";
import { buildStaffContext, normalizeRoleConfig } from "../authz/index.js";
import { createEvents } from "../events/index.js";
import {
  createIdentityContext,
  createIdempotencyContext,
  createTxRunner,
  defineRegistration,
  implementKeyed,
  assemble,
  uuidv7,
  lockRows,
  assembleProviders,
} from "../kernel/index.js";
import { failed } from "../providers/types.js";
import type { ObjectRef } from "../providers/types.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  useSeededDatabase,
  createRecordingLogger,
} from "../testing/index.js";
import {
  createMedia,
  fileRefTypePort,
  fileCategoryGuardPort,
  findI2Violations,
  findI14Violations,
  placeholderPdf,
} from "./index.js";
import type { MediaActor, Media } from "./index.js";
const db = useSeededDatabase("services");
const clock = createClock();
const storage = assembleProviders({ appEnv: "test", logger: createRecordingLogger() }).storage;
const ownObjects: ObjectRef[] = [];
const run = `w107-${randomUUID()}`;
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let make: ReturnType<typeof createFactories>;
let tx: ReturnType<typeof createTxRunner>;
let fake: ReturnType<typeof createFakeProviders>;
let media: Media;
let real: Media;
let actor: MediaActor;
let actor2: MediaActor;
let store2: string;
let actorOther: MediaActor;
let staff: MediaActor;
let assembly: ReturnType<typeof assembleForTest>;
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const register = (
  a = actor,
  category: "profile_image" | "pay_receipt" | "kyc_license" = "profile_image",
  token = uuidv7(),
  size = bytes.byteLength.toString(),
) =>
  media.register(a, {
    category,
    ...(category === "kyc_license" ? { licenseKind: "business_license" as const } : {}),
    files: [{ fileName: "TEST.PNG", sizeBytes: size, clientToken: token }],
  });
const idem = (a: MediaActor, fileId: string, key = uuidv7()) =>
  createIdempotencyContext({
    mode: "required",
    scope: "m.file.complete",
    actor: a.identity.actor,
    key,
    request: { method: "POST", pathParams: { fileId }, body: null, storeId: a.merchant?.storeId },
  });
async function registered(a = actor) {
  const r = (await register(a)).items[0]!;
  fake.storage.put({ bucket: "asset", key: r.key }, bytes, "image/jpeg");
  return r;
}
async function finish(fileId: string) {
  await media.complete(actor, fileId);
  const job = await prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${fileId}` },
  });
  await media.promote({ jobId: job.id });
  return prisma.fileObject.findUniqueOrThrow({ where: { id: fileId } });
}
beforeAll(async () => {
  prisma = await db.prisma();
  make = createFactories({ db: prisma, clock });
  tx = createTxRunner({ prisma, appEnv: "test" });
  fake = createFakeProviders({ clock });
  assembly = assembleForTest({
    entry: "worker",
    extra: [
      defineRegistration("lyxtest_media_refs", {
        portImplementations: [
          implementKeyed(fileRefTypePort, "store_profile", {
            roles: { logo: { categories: ["profile_image"], retentionDays: 30 } },
          }),
          implementKeyed(fileRefTypePort, "qualification_doc", {
            roles: { main: { categories: ["kyc_license"], retentionDays: 7 } },
          }),
        ],
      }),
    ],
  });
  const events = createEvents({ assembly, clock, tx });
  media = createMedia({ tx, clock, assembly, events, storage: fake.storage, pollMs: 0 });
  real = createMedia({ tx, clock, assembly, events, storage, pollMs: 0 });
  const user = await make.merchantUser();
  const entity = await make.entity({ createdByUserId: user.id });
  const store = await make.store({ entityId: entity.id });
  store2 = (await make.store({ entityId: entity.id })).id;
  actor = {
    identity: createIdentityContext({
      actor: { type: "merchant", id: user.id, client: "weapp", role: "owner" },
      entityId: entity.id,
      storeId: store.id,
    }),
    merchant: { standing: "owner", entityId: entity.id, storeId: store.id },
  };
  actor2 = {
    ...actor,
    identity: createIdentityContext({
      actor: { type: "merchant", id: user.id, client: "weapp", role: "owner" },
      entityId: entity.id,
      storeId: store2,
    }),
    merchant: { standing: "owner", entityId: entity.id, storeId: store2 },
  };
  const other = await make.entity({ createdByUserId: user.id });
  const otherStore = await make.store({ entityId: other.id });
  actorOther = {
    ...actor,
    identity: createIdentityContext({
      actor: { type: "merchant", id: user.id, client: "weapp", role: "owner" },
      entityId: other.id,
      storeId: otherStore.id,
    }),
    merchant: { standing: "owner", entityId: other.id, storeId: otherStore.id },
  };
  const row = await make.staff({ staffRoleKey: "super_admin" });
  const role = STAFF_ROLE_DEFAULTS.find((role) => role.key === "super_admin")!;
  staff = {
    identity: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
    staff: buildStaffContext({
      staff: { id: row.id, roleKey: "super_admin", isLead: true, staffGroupId: null },
      role: normalizeRoleConfig("super_admin", {
        moduleLevels: role.moduleLevels,
        dataScope: role.dataScope,
        actions: defaultRoleActions("super_admin"),
      }),
      groupStaffIds: [],
      stepUpAt: null,
    }),
  };
}, 180_000);
afterAll(async () => {
  for (const ref of ownObjects) await storage.delete(ref);
  (storage as typeof storage & { close(): void }).close();
});
describe("W1-07 文件生命周期", { timeout: 60_000 }, () => {
  it("自然重用相同归属/大小；同 token 跨门店独立，跨主体 noscope 冲突不泄露", async () => {
    const token = uuidv7();
    const first = (await register(actor, "pay_receipt", token)).items[0]!;
    expect((await register(actor2, "pay_receipt", token)).items[0]!.fileId).toBe(first.fileId);
    await expect(register(actorOther, "pay_receipt", token)).rejects.toMatchObject({
      error: "VALIDATION_FAILED",
      details: {
        fieldErrors: [
          { path: "files.0.clientToken", message: expect.stringContaining("重新生成") },
        ],
      },
    });
    await expect(register(actor, "pay_receipt", token, "9")).rejects.toMatchObject({
      error: "VALIDATION_FAILED",
    });
    const storeToken = uuidv7();
    expect((await register(actor)).items[0]!.fileId).toBeDefined();
    expect((await register(actor, "profile_image", storeToken)).items[0]!.fileId).not.toBe(
      (await register(actor2, "profile_image", storeToken)).items[0]!.fileId,
    );
  });
  it("8 路并发同自然键恰有一行/同写入区键", async () => {
    const token = uuidv7();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => register(actor, "profile_image", token)),
    );
    expect(new Set(results.map((result) => result.items[0]!.fileId)).size).toBe(1);
    expect(await prisma.fileObject.count({ where: { clientToken: token } })).toBe(1);
  });
  it("批登记遇无效类型、超限或 Provider 失败整批零新增；不相信声明 mime", async () => {
    const before = await prisma.fileObject.count();
    await expect(
      media.register(actor, {
        category: "profile_image",
        files: [
          { fileName: "ok.png", sizeBytes: "8", clientToken: uuidv7() },
          { fileName: "bad.svg", sizeBytes: "8", clientToken: uuidv7() },
        ],
      }),
    ).rejects.toMatchObject({ error: "FILE_TYPE_NOT_ALLOWED" });
    await expect(register(actor, "profile_image", uuidv7(), "5242881")).rejects.toMatchObject({
      error: "FILE_TOO_LARGE",
      details: { maxBytes: "5242880" },
    });
    fake.storage.failNext("presignPost", failed("unavailable", "故障"));
    await expect(register()).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    const off = createMedia({
      tx,
      clock,
      assembly,
      events: createEvents({ assembly, clock, tx }),
      storage: assembleProviders({ appEnv: "stg", logger: createRecordingLogger() }).storage,
    });
    await expect(
      off.register(actor, {
        category: "profile_image",
        files: [{ fileName: "x.png", sizeBytes: "8", clientToken: uuidv7() }],
      }),
    ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    expect(await prisma.fileObject.count()).toBe(before);
  });
  it("老板/店员/停用、分类守卫和业务范围闭合", async () => {
    const clerk = { ...actor, merchant: { ...actor.merchant!, standing: "clerk" as const } };
    await expect(register(clerk)).rejects.toMatchObject({ error: "ROLE_FORBIDDEN" });
    const archived = {
      ...actor,
      merchant: { ...actor.merchant!, standing: "archivedOwner" as const },
    };
    await expect(register(archived)).rejects.toMatchObject({ error: "STORE_ARCHIVED" });
    await expect(register(archived, "pay_receipt")).resolves.toHaveProperty("items");
    await expect(
      media.register(staff, {
        category: "sample_video",
        files: [{ fileName: "x.mp4", sizeBytes: "8", clientToken: uuidv7() }],
      }),
    ).rejects.toMatchObject({ error: "FILE_CATEGORY_NOT_ALLOWED" });
    const first = await registered();
    await expect(media.getMerchant(actorOther, first.fileId)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
  });
  it("GET 与 post 续签不改行；24h 边界保留 pending", async () => {
    const first = await registered();
    const before = await prisma.fileObject.findUnique({ where: { id: first.fileId } });
    await media.getMerchant(actor, first.fileId);
    await media.refresh(actor, first.fileId);
    expect(await prisma.fileObject.findUnique({ where: { id: first.fileId } })).toEqual(before);
    await prisma.fileObject.update({
      where: { id: first.fileId },
      data: { uploadExpiresAt: clock.now() },
    });
    await expect(media.complete(actor, first.fileId)).rejects.toMatchObject({
      error: "UPLOAD_EXPIRED",
    });
    expect(
      (await prisma.fileObject.findUniqueOrThrow({ where: { id: first.fileId } })).status,
    ).toBe("pending");
  });
  it("missing 释放确认和幂等占用，同键补传可重试；拒收持久化且无 promote", async () => {
    const file = (await register()).items[0]!;
    const key = uuidv7();
    await expect(
      media.complete(actor, file.fileId, { idem: idem(actor, file.fileId, key) }),
    ).rejects.toMatchObject({ error: "UPLOAD_NOT_FOUND" });
    expect(
      (await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } })).confirmingUntil,
    ).toBeNull();
    fake.storage.put({ bucket: "asset", key: file.key }, bytes, "image/png");
    await expect(
      media.complete(actor, file.fileId, { idem: idem(actor, file.fileId, key) }),
    ).resolves.toMatchObject({ status: "promoting" });
    const bad = await registered();
    fake.storage.put({ bucket: "asset", key: bad.key }, new Uint8Array(8), "image/png");
    await expect(media.complete(actor, bad.fileId)).rejects.toMatchObject({
      error: "UPLOAD_REJECTED",
      details: { rejectReason: "bad_magic" },
    });
    expect(await prisma.fileObject.findUniqueOrThrow({ where: { id: bad.fileId } })).toMatchObject({
      status: "rejected",
      rejectReason: "bad_magic",
      confirmingUntil: null,
    });
    expect(await prisma.mediaJob.count({ where: { subjectId: bad.fileId } })).toBe(0);
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: "file.rejected", aggregateId: bad.fileId },
      }),
    ).toBe(1);
  });
  it("确认竞争与自然成功重放都不重复任务；幂等保存 promoting 而首读可变 stored", async () => {
    const first = await registered();
    const key = uuidv7();
    await media.complete(actor, first.fileId, { idem: idem(actor, first.fileId, key) });
    await finish(first.fileId);
    const replay = idem(actor, first.fileId, key);
    expect(await media.complete(actor, first.fileId, { idem: replay })).toMatchObject({
      status: "promoting",
    });
    expect(replay.replayed).toBe(true);
    expect(await prisma.mediaJob.count({ where: { subjectId: first.fileId } })).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: "file.stored", aggregateId: first.fileId },
      }),
    ).toBe(1);
  });
  it("条件复制防确认后偷换；promote 重复/故障重试与到期接管", async () => {
    const changed = await registered();
    await media.complete(actor, changed.fileId);
    fake.storage.put({ bucket: "asset", key: changed.key }, new Uint8Array(8), "image/png");
    const job = await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${changed.fileId}` },
    });
    await Promise.all([media.promote({ jobId: job.id }), media.promote({ jobId: job.id })]);
    expect(
      await prisma.fileObject.findUniqueOrThrow({ where: { id: changed.fileId } }),
    ).toMatchObject({ status: "rejected", rejectReason: "changed_after_confirm" });
    const retry = await registered();
    await media.complete(actor, retry.fileId);
    const queued = await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${retry.fileId}` },
    });
    fake.storage.failNext("copy", failed("unavailable", "故障"));
    await media.promote({ jobId: queued.id });
    expect(await prisma.mediaJob.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({
      state: "queued",
      attemptNo: 1,
    });
    clock.advance(30_001);
    await media.promote({ jobId: queued.id });
    await media.promote({ jobId: queued.id });
    expect(await prisma.mediaJob.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({
      state: "succeeded",
      attemptNo: 2,
    });
  });
  it("promote 旧租约的迟到响应不能覆盖新尝试", async () => {
    const file = await registered();
    await media.complete(actor, file.fileId);
    const job = await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${file.fileId}` },
    });
    fake.storage.delayNext("copy", 31_000);
    const old = media.promote({ jobId: job.id });
    while (fake.storage.pendingCalls() === 0)
      await new Promise((resolve) => setTimeout(resolve, 10));
    clock.advance(30_001);
    await media.promote({ jobId: job.id });
    const winner = await prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(winner).toMatchObject({ state: "succeeded", attemptNo: 2 });
    clock.advance(1000);
    fake.storage.tick();
    await old;
    expect(await prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(winner);
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: "file.stored", aggregateId: file.fileId },
      }),
    ).toBe(1);
  });
  it("取消只允许 pending/expired，stored/rejected/promoting 不可取消", async () => {
    const first = await registered();
    expect(await media.cancel(actor, first.fileId)).toMatchObject({ status: "expired" });
    expect(await media.cancel(actor, first.fileId)).toMatchObject({ status: "expired" });
    const stored = await registered();
    await finish(stored.fileId);
    await expect(media.cancel(actor, stored.fileId)).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
  });
  it("引用归属、分类、stored/block 与保留缓存；释放只顺延、复用恢复 live", async () => {
    const first = await registered();
    const refId = uuidv7();
    const input = {
      fileId: first.fileId,
      refId,
      refType: "store_profile",
      role: "logo",
      entityId: actor.merchant!.entityId,
      storeId: store2,
    };
    await expect(tx.run((handle) => media.link(handle, input))).rejects.toMatchObject({
      error: "FILE_NOT_USABLE",
      details: { reason: "not_stored" },
    });
    await finish(first.fileId);
    await expect(
      tx.run((handle) => media.link(handle, { ...input, entityId: actorOther.merchant!.entityId })),
    ).rejects.toMatchObject({ error: "FILE_NOT_USABLE", details: { reason: "scope_mismatch" } });
    await tx.run((handle) => media.link(handle, input));
    expect(await tx.run(findI2Violations)).toEqual([]);
    const long = new Date(clock.now().getTime() + 50 * 86_400_000);
    await tx.run((handle) => media.release(handle, { ...input, keepUntil: long }));
    await tx.run((handle) => media.release(handle, { ...input, keepUntil: clock.now() }));
    expect(
      (await prisma.fileObject.findUniqueOrThrow({ where: { id: first.fileId } })).purgeAfter,
    ).toEqual(long);
    await tx.run((handle) => media.link(handle, input));
    expect(
      (await prisma.fileObject.findUniqueOrThrow({ where: { id: first.fileId } })).purgeAfter,
    ).toBeNull();
    await expect(
      tx.run((handle) => media.link(handle, { ...input, released: true, keepUntil: clock.now() })),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await prisma.fileObject.update({
      where: { id: first.fileId },
      data: { moderationState: "block" },
    });
    await expect(tx.run((handle) => media.link(handle, input))).rejects.toMatchObject({
      error: "FILE_NOT_USABLE",
      details: { reason: "blocked" },
    });
    await prisma.fileObject.update({
      where: { id: first.fileId },
      data: { moderationState: "none", status: "promoting", incomingKey: "incoming/bad" },
    });
    expect(await tx.run(findI2Violations)).toEqual([
      expect.objectContaining({ subject: { type: "file_object", id: first.fileId } }),
    ]);
    await prisma.fileObject.update({
      where: { id: first.fileId },
      data: { status: "stored", incomingKey: null },
    });
  });
  it("系统写入幂等、I14 业务列缺引用；生效协议不可释放", async () => {
    const result = await media.putSystemFile({
      category: "legal_doc",
      fileName: "terms.pdf",
      objectKey: `legal_doc/${run}/terms.pdf`,
      body: placeholderPdf("terms"),
      entityId: null,
      storeId: null,
    });
    expect(
      await media.putSystemFile({
        category: "legal_doc",
        fileName: "terms.pdf",
        objectKey: `legal_doc/${run}/terms.pdf`,
        body: placeholderPdf("terms"),
        entityId: null,
        storeId: null,
      }),
    ).toMatchObject({ fileId: result.fileId, created: false });
    const version = await make.agreementVersion({
      pdfFileId: result.fileId,
      sourceFileId: result.fileId,
      status: "draft",
    });
    expect(await tx.run(findI14Violations)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: { type: "file_object", id: result.fileId } }),
      ]),
    );
    const input = {
      fileId: result.fileId,
      refType: "agreement_version",
      refId: version.id,
      entityId: null,
      storeId: null,
    };
    await tx.run(async (handle) => {
      await lockRows(handle, "file_object", [result.fileId]);
      await media.link(handle, { ...input, role: "source" });
      await media.link(handle, { ...input, role: "pdf" });
    });
    await tx.run((handle) =>
      media.release(handle, { ...input, role: "source", keepUntil: clock.now() }),
    );
    expect(
      (await prisma.fileRef.findFirstOrThrow({ where: { refId: version.id, role: "source" } }))
        .keepUntil,
    ).toEqual(new Date(clock.now().getTime() + 7 * 86_400_000));
    await prisma.agreementVersion.update({
      where: { id: version.id },
      data: {
        status: "pending",
        effectiveAt: clock.now(),
        isLegalApproved: true,
        summary: "测试发布",
        contentSha256: result.sha256,
        publishedByStaffId: staff.identity.actor.id,
      },
    });
    await expect(
      tx.run((handle) => media.release(handle, { ...input, role: "pdf", keepUntil: clock.now() })),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await expect(
      tx.run((handle) =>
        media.link(handle, { ...input, role: "pdf", released: true, keepUntil: clock.now() }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  });
  it("确认标记挡住第二个请求，大小优先拒收，重放不再次外呼", async () => {
    const first = await registered();
    fake.storage.delayNext("head", 1000);
    const pending = media.complete(actor, first.fileId);
    while (fake.storage.pendingCalls() === 0)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(media.complete(actor, first.fileId)).rejects.toMatchObject({
      error: "CONFIRM_IN_PROGRESS",
    });
    clock.advance(1000);
    fake.storage.tick();
    await pending;
    expect(await prisma.mediaJob.count({ where: { subjectId: first.fileId } })).toBe(1);
    const wrong = await registered();
    fake.storage.put({ bucket: "asset", key: wrong.key }, new Uint8Array(9), "image/png");
    const reads = fake.storage.callsOf("readPrefix").length;
    await expect(media.complete(actor, wrong.fileId)).rejects.toMatchObject({
      error: "UPLOAD_REJECTED",
      details: { rejectReason: "size_mismatch" },
    });
    expect(fake.storage.callsOf("readPrefix")).toHaveLength(reads);
    expect(
      await prisma.fileObject.findUniqueOrThrow({ where: { id: wrong.fileId } }),
    ).toMatchObject({ status: "rejected", rejectReason: "size_mismatch" });
  });
  it("系统对象不同内容竞争不覆盖胜者，DB收尾失败同内容可恢复（Fake与真实MinIO）", async () => {
    for (const [name, service, provider] of [
      ["fake", media, fake.storage],
      ["minio", real, storage],
    ] as const) {
      const input = {
        category: "legal_doc" as const,
        fileName: "race.pdf",
        objectKey: `legal_doc/${run}/race-${name}.pdf`,
        body: placeholderPdf("winner-a"),
        entityId: null,
        storeId: null,
      };
      if (name === "minio") ownObjects.push({ bucket: "secure", key: input.objectKey });
      const other = { ...input, body: placeholderPdf("winner-b") };
      const results = await Promise.allSettled([
        service.putSystemFile(input),
        service.putSystemFile(other),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const winner = results[0]!.status === "fulfilled" ? input : other;
      const row = await prisma.fileObject.findUniqueOrThrow({
        where: { bucket_objectKey: { bucket: "secure", objectKey: input.objectKey } },
      });
      const head = await provider.head({ bucket: "secure", key: input.objectKey });
      expect(head).toMatchObject({
        ok: true,
        value: { etag: row.etag, size: winner.body.byteLength },
      });
      expect(
        await provider.readPrefix({ bucket: "secure", key: input.objectKey, bytes: 4096 }),
      ).toEqual({ ok: true, value: winner.body });
      const recover = { ...input, objectKey: `legal_doc/${run}/recover-${name}.pdf` };
      if (name === "minio") ownObjects.push({ bucket: "secure", key: recover.objectKey });
      let calls = 0;
      const crash = createMedia({
        tx: {
          run: async (fn, options) => {
            if (++calls === 2) throw new Error("DB收尾故障");
            return tx.run(fn, options);
          },
        },
        clock,
        assembly,
        events: createEvents({ assembly, clock, tx }),
        storage: provider,
      });
      await expect(crash.putSystemFile(recover)).rejects.toThrow("DB收尾故障");
      expect(
        await prisma.fileObject.findUnique({
          where: { bucket_objectKey: { bucket: "secure", objectKey: recover.objectKey } },
        }),
      ).toBeNull();
      await expect(
        service.putSystemFile({ ...recover, entityId: actor.merchant!.entityId }),
      ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
      await expect(service.putSystemFile(recover)).resolves.toMatchObject({ created: true });
      await expect(service.putSystemFile(recover)).resolves.toMatchObject({ created: false });
    }
  });
  it("TTL 分类、图窗内 URL 稳定、后台逐次 access；GET 零审计", async () => {
    const now = new Date("2026-01-05T04:10:00Z");
    const minutes = (category: Parameters<typeof readUrlExpiry>[0], ext: string) =>
      (readUrlExpiry(category, ext, now).getTime() - now.getTime()) / 60_000;
    expect([
      minutes("kyc_license", "png"),
      minutes("legal_doc", "pdf"),
      minutes("sample_video", "mp4"),
      minutes("final_episode", "mp4"),
      minutes("package_zip", "zip"),
      minutes("publish_list", "txt"),
    ]).toEqual([5, 30, 60, 30, 180, 15]);
    const image = await registered();
    await finish(image.fileId);
    const a = await media.signRead({ fileId: image.fileId });
    clock.advance(1000);
    expect(await media.signRead({ fileId: image.fileId })).toEqual(a);
    const before = await prisma.auditLog.count();
    await media.getAdmin(staff, image.fileId);
    expect(await prisma.auditLog.count()).toBe(before);
    const secure = await media.putSystemFile({
      category: "drama_license_doc",
      fileName: "permit.pdf",
      objectKey: `drama_license_doc/${run}/permit.pdf`,
      body: placeholderPdf("permit"),
      entityId: null,
      storeId: null,
    });
    const meta = {
      requestId: null,
      ip: null,
      userAgent: null,
      sessionId: null,
      authMethod: "password+totp" as const,
    };
    await media.downloadUrls(staff, { fileId: secure.fileId }, meta);
    await media.downloadUrls(staff, { fileId: secure.fileId }, meta);
    expect(await prisma.auditLog.count()).toBe(before + 2);
  });
  it("按键端口冲突在构造阶段失败", () => {
    const duplicate = defineRegistration("lyxtest_media_duplicate", {
      ports: [fileCategoryGuardPort],
      portImplementations: [
        implementKeyed(fileCategoryGuardPort, "sample_video", { assert: async () => {} }),
        implementKeyed(fileCategoryGuardPort, "sample_video", { assert: async () => {} }),
      ],
    });
    expect(() => assemble({ entry: "api", appEnv: "test", registrations: [duplicate] })).toThrow(
      /重|同/,
    );
  });
  it("真实 MinIO 表单→HEAD/4KB→条件复制→stored，inline/attachment HTTP 响应", async () => {
    const created = (
      await real.register(actor, {
        category: "profile_image",
        files: [{ fileName: "photo.PNG", sizeBytes: "8", clientToken: uuidv7() }],
      })
    ).items[0]!;
    ownObjects.push({ bucket: "asset", key: created.key });
    const form = new FormData();
    for (const [name, value] of Object.entries(created.post!.fields)) form.set(name, value);
    form.set("file", new Blob([bytes]));
    expect((await fetch(created.post!.url, { method: "POST", body: form })).status).toBe(204);
    await real.complete(actor, created.fileId);
    const job = await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${created.fileId}` },
    });
    await real.promote({ jobId: job.id });
    await real.promote({ jobId: job.id });
    const stored = await prisma.fileObject.findUniqueOrThrow({ where: { id: created.fileId } });
    ownObjects.push({ bucket: "asset", key: stored.objectKey });
    expect(stored).toMatchObject({
      status: "stored",
      mime: "image/png",
      sizeBytes: 8n,
      incomingKey: null,
    });
    for (const disposition of ["inline", "attachment"] as const) {
      const signed = await real.signRead({ fileId: stored.id, disposition });
      const response = await fetch(signed.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain(disposition);
      expect(response.headers.get("content-type")).toBe("image/png");
    }
  });
});
