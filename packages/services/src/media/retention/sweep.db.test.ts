import { createSessionMutexConnectionFactory } from "@liyoxi/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdempotencyContext,
  createIdentityContext,
  createSessionMutex,
  uuidv7,
} from "../../kernel/index.js";
import type { RecurringRunContext, Tx } from "../../kernel/index.js";
import { failed } from "../../providers/types.js";
import type { ObjectRef } from "../../providers/types.js";
import {
  configTestStaffBriefs,
  createMediaAssetsHarness,
  notificationFixture,
  sampleStaffContext,
  signInAsStaff,
  useSeededDatabase,
} from "../../testing/index.js";
import { findI13Violations } from "./sweep-invariants.js";
import { createMedia } from "../index.js";
import type { RetentionOptions, RetentionActor } from "../index.js";

const db = useSeededDatabase("services", { label: "sweep", max: 1 });
const DAY = 86_400_000,
  START = new Date("2030-10-21T04:00:00Z");
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>,
  n: ReturnType<typeof notificationFixture>,
  mutex: ReturnType<typeof createSessionMutex>;
let params: { mode: "list_only" | "auto"; maxObjects: number; maxBytes: bigint },
  sequence = 0;
const tracked: string[] = [],
  notices: unknown[] = [];
const ref = (file: { bucket: string; objectKey: string }): ObjectRef => ({
  bucket: file.bucket as ObjectRef["bucket"],
  key: file.objectKey,
});
const context = (
  signal = new AbortController().signal,
  runTx: NonNullable<RecurringRunContext["runTx"]> = h.tx.run,
): RecurringRunContext => ({ scheduledFor: h.clock.now(), signal, runTx });
const sweep = (ctx = context()) => h.media.retention.sweep(ctx);
const retention = (): RetentionOptions => ({
  sessionMutex: mutex,
  staffBriefs: configTestStaffBriefs,
  alerts: {
    raise: async (notice) => {
      notices.push(notice);
    },
  },
  sweep: {
    parameters: async () => params,
    remindDemand: (tx, id) => n.service.remindAssetDemand(tx, id),
  },
});
const freshMedia = () =>
  createMedia({
    assembly: h.assembly,
    tx: h.tx,
    clock: h.clock,
    storage: h.fake.storage,
    events: h.events,
    assets: h.assets,
    retention: retention(),
  });
beforeAll(async () => {
  const prisma = await db.prisma();
  mutex = createSessionMutex({
    connect: createSessionMutexConnectionFactory({ connectionString: await db.url() }),
    maxConcurrent: 1,
    probeMs: 50,
  });
  n = notificationFixture(prisma);
  h = await createMediaAssetsHarness(prisma, { retention: retention() });
  h.fake.storage.capabilities.versioning = true;
}, 120_000);
beforeEach(async () => {
  h.clock.set(new Date(START.getTime() + sequence++ * 10 * DAY));
  n.clock.set(h.clock.now());
  params = { mode: "list_only", maxObjects: 500, maxBytes: 53_687_091_200n };
  notices.length = 0;
  await h.prisma.filePurgeRun.updateMany({
    where: { state: "running" },
    data: { state: "aborted", finishedAt: h.clock.now(), updatedAt: h.clock.now() },
  });
  // 前组样本只做本文件隔离收尾；保留行/历史，不让已验对象串入下一组日清单。
  const previous = await h.prisma.fileObject.findMany({
    where: { id: { in: tracked }, status: "stored" },
  });
  for (const row of previous) await h.fake.storage.delete(ref(row));
  await h.prisma.fileObject.updateMany({
    where: { id: { in: tracked }, status: "stored" },
    data: {
      status: "deleted",
      deletedAt: h.clock.now(),
      purgeAfter: null,
      updatedAt: h.clock.now(),
    },
  });
  h.fake.storage.resetCalls();
  await h.prisma.fileRef.updateMany({
    where: { fileId: { in: tracked }, state: "released" },
    data: { keepUntil: new Date("2100-01-01T00:00:00Z"), updatedAt: h.clock.now() },
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await h?.close();
  await n?.service.close();
  await mutex?.close();
});
async function file(input: Parameters<typeof h.make.fileObject>[0] = {}) {
  const old = new Date(h.clock.now().getTime() - 3 * DAY);
  const row = await h.make.fileObject({
    storedAt: old,
    createdAt: old,
    updatedAt: old,
    sizeBytes: 8n,
    ...input,
  });
  tracked.push(row.id);
  if (row.status === "stored")
    h.fake.storage.put(ref(row), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "image/jpeg");
  return row;
}
async function storeFile() {
  return file({
    category: "store_asset",
    bucket: "asset",
    scopeType: "store",
    entityId: h.merchant.entity.id,
    storeId: h.merchant.store.id,
    uploadActorType: "merchant",
    uploadActorId: h.merchant.user.id,
    uploadClient: "weapp",
  });
}
async function asset(fileId: string, own = h.merchant, portrait: string[] = []) {
  const row = await h.prisma.storeAsset.create({
    data: {
      id: uuidv7(),
      entityId: own.entity.id,
      storeId: own.store.id,
      type: "image",
      uploadActorType: "merchant",
      uploadActorId: own.user.id,
      uploadActorRole: "owner",
      uploadClient: "weapp",
      processingState: "processed",
      reviewState: "unreviewed",
      portraitAuthFileIds: portrait,
      idempotencyKey: uuidv7(),
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  await h.prisma.storeAssetFile.create({
    data: { storeAssetId: row.id, fileId, position: 1, createdAt: h.clock.now() },
  });
  return row;
}
async function ocr(fileId: string) {
  return h.prisma.ocrResult.create({
    data: {
      id: uuidv7(),
      entityId: h.merchant.entity.id,
      storeId: h.merchant.store.id,
      fileId,
      docType: "business_license",
      provider: "none",
      status: "unavailable",
      rawEnc: "fictional-encrypted-raw",
      rawPurgeAt: h.clock.now(),
      requestActorType: "system",
      warnings: [],
      createdAt: new Date(h.clock.now().getTime() - 30 * DAY),
      updatedAt: h.clock.now(),
    },
  });
}
async function latestRun() {
  return h.prisma.filePurgeRun.findFirstOrThrow({ orderBy: { id: "desc" } });
}

describe("media.sweep真实租约、分步清扫与持久恢复", { timeout: 120_000 }, () => {
  it("分步失败不挡后续：pending/production过期、批次遵分类保留期、24小时缓存与OCR只清raw", async () => {
    const pending = await file({
      status: "pending",
      storedAt: null,
      sizeBytes: null,
      uploadActorType: "staff",
      uploadActorId: h.staff.id,
      uploadClient: "admin",
      uploadMode: "post",
      incomingBucket: "asset",
      incomingKey: `incoming/${uuidv7()}`,
      uploadExpiresAt: new Date(h.clock.now().getTime() - 1),
    });
    await h.prisma.productionRecord.create({
      data: {
        fileId: pending.id,
        kind: "ad",
        adId: uuidv7(),
        source: "manual_upload",
        aiUsage: { used: false },
        aigcState: "not_required",
        pipelineState: "uploading",
        uploadedByStaffId: h.staff.id,
        createdAt: new Date(h.clock.now().getTime() - DAY),
        updatedAt: h.clock.now(),
      },
    });
    const rejected = await file({
      status: "rejected",
      rejectReason: "bad_magic",
      storedAt: null,
      sizeBytes: null,
      incomingBucket: "asset",
      incomingKey: `incoming/${uuidv7()}`,
    });
    const rawFile = await file({
      category: "kyc_license",
      bucket: "secure",
      scopeType: "entity",
      entityId: h.merchant.entity.id,
      storedAt: new Date(h.clock.now().getTime() - 40 * DAY),
      createdAt: new Date(h.clock.now().getTime() - 40 * DAY),
    });
    const raw = await ocr(rawFile.id),
      orphan = await file(),
      young = await file({ storedAt: h.clock.now() });
    const batch = await h.prisma.uploadBatch.create({
      data: {
        id: uuidv7(),
        purpose: "drama_master",
        targetId: uuidv7(),
        createdByStaffId: h.staff.id,
        state: "uploading",
        expectedCount: 1,
        scope: "partial",
        idempotencyKey: uuidv7(),
        expiresAt: new Date(h.clock.now().getTime() - 1),
        createdAt: new Date(h.clock.now().getTime() - 3 * DAY),
        updatedAt: h.clock.now(),
      },
    });
    const master = await file({
      category: "drama_master",
      bucket: "media",
      ext: "mp4",
      declaredMime: "video/mp4",
      uploadBatchId: batch.id,
    });
    await h.tx.run((tx) =>
      h.media.link(tx, {
        fileId: master.id,
        entityId: null,
        storeId: null,
        refType: "upload_batch",
        refId: batch.id,
        role: "main",
      }),
    );
    vi.spyOn(h.fake.storage, "delete").mockResolvedValue(
      failed("unavailable", "lyxtest storage result unknown"),
    );
    const result = await sweep();
    expect(result.failed).toEqual(["incoming"]);
    expect(await h.prisma.fileObject.findUnique({ where: { id: pending.id } })).toMatchObject({
      status: "expired",
      incomingKey: null,
    });
    expect(
      await h.prisma.productionRecord.findUnique({ where: { fileId: pending.id } }),
    ).toMatchObject({ pipelineState: "rejected" });
    expect(await h.prisma.fileObject.findUnique({ where: { id: rejected.id } })).toMatchObject({
      incomingKey: rejected.incomingKey,
    });
    expect(await h.prisma.fileObject.findUnique({ where: { id: orphan.id } })).toMatchObject({
      purgeAfter: new Date(orphan.storedAt!.getTime() + DAY),
    });
    expect(await h.prisma.fileObject.findUnique({ where: { id: young.id } })).toMatchObject({
      purgeAfter: null,
    });
    expect(await h.prisma.uploadBatch.findUnique({ where: { id: batch.id } })).toMatchObject({
      state: "expired",
    });
    expect(await h.prisma.fileRef.findFirst({ where: { fileId: master.id } })).toMatchObject({
      state: "released",
      keepUntil: new Date(h.clock.now().getTime() + 7 * DAY),
    });
    expect(await h.prisma.ocrResult.findUnique({ where: { id: raw.id } })).toMatchObject({
      rawEnc: null,
      status: "unavailable",
      warnings: [],
    });
  });

  it("每日清单持久去重、auto数量字节熔断；真实批准后漏记当前引用累计3guard中止", async () => {
    const incoming = await h.prisma.fileObject.findMany({
      where: { status: "rejected", incomingKey: { not: null } },
      orderBy: { id: "asc" },
      take: 100,
      select: { incomingBucket: true, incomingKey: true },
    });
    const files = await Promise.all([storeFile(), storeFile(), storeFile()]);
    const job = h.assembly.recurringJob("media.sweep")!;
    expect(job).toMatchObject({
      mode: "job",
      schedule: { every: "minutes", minutes: 10 },
      deadlineMin: 30,
    });
    await job.run(context());
    const proposed = await latestRun();
    expect(proposed).toMatchObject({
      state: "proposed",
      candidateCount: 3,
      candidateBytes: 24n,
      deletedCount: null,
    });
    const restart = freshMedia();
    await restart.retention.sweep(context());
    await restart.jobs.shutdown();
    expect(await h.prisma.filePurgeRun.count({ where: { createdAt: proposed.createdAt } })).toBe(1);
    for (const row of files) await asset(row.id);
    const signed = await signInAsStaff(h.prisma, { roleKey: "super_admin", now: h.clock.now() });
    const actor: RetentionActor = {
      identity: createIdentityContext({
        actor: { type: "staff", id: signed.staff.id, client: "admin" },
      }),
      staff: await sampleStaffContext(h.prisma, signed.staff.id, { stepUpAt: h.clock.now() }),
      meta: {
        requestId: "lyxtest-sweep-approve",
        sessionId: signed.sessionId,
        authMethod: "password+totp",
        ip: "192.0.2.78",
        userAgent: "lyxtest sweep",
      },
    };
    const body = { confirm: { candidateCount: 3, candidateBytes: "24" } };
    await h.media.retention.approveRun(actor, proposed.id, body, {
      idem: createIdempotencyContext({
        mode: "required",
        scope: "admin.purgeRun.approve",
        actor: actor.identity.actor,
        key: uuidv7(),
        request: { method: "POST", pathParams: { purgeRunId: proposed.id }, body },
      }),
    });
    await sweep();
    expect(await h.prisma.filePurgeRun.findUnique({ where: { id: proposed.id } })).toMatchObject({
      state: "aborted",
      guardTrips: 3,
      deletedCount: 0,
    });
    // 唯一允许的删除是前组保留的rejected incoming；精确key trace排除任何guard候选。
    expect(h.fake.storage.callsOf("delete").map((call) => call.input)).toEqual(
      incoming.map((row) =>
        expect.objectContaining({ bucket: row.incomingBucket, key: row.incomingKey }),
      ),
    );
    expect(
      await h.prisma.fileObject.count({
        where: { id: { in: files.map((row) => row.id) }, status: "stored" },
      }),
    ).toBe(3);
    h.clock.advance(DAY);
    n.clock.set(h.clock.now());
    params = { mode: "auto", maxObjects: 2, maxBytes: 15n };
    await sweep();
    const held = await latestRun();
    expect(held).toMatchObject({ state: "held", candidateCount: 3, candidateBytes: 24n });
    expect(held.heldReason).toContain("max_objects");
    expect(held.heldReason).toContain("max_bytes");
    expect(notices).toContainEqual(
      expect.objectContaining({ rule: "purge.held", dimension: held.id }),
    );
  });

  it("100文件小批跨轮续作；marker未知/settle失败后3guard中止，重启续作只恢复已证明意图", async () => {
    params.mode = "auto";
    const first = await file();
    const bulk = Array.from({ length: 100 }, () => ({
      id: uuidv7(),
      objectKey: `test/${uuidv7()}.jpg`,
      bucket: "pub",
      category: "poster",
      scopeType: "platform",
      uploadActorType: "system",
      status: "stored",
      declaredSize: 8n,
      declaredMime: "image/jpeg",
      ext: "jpg",
      sizeBytes: 8n,
      mime: "image/jpeg",
      storedAt: first.storedAt!,
      createdAt: first.createdAt,
      updatedAt: first.updatedAt,
    }));
    await h.prisma.fileObject.createMany({ data: bulk });
    for (const row of bulk) {
      tracked.push(row.id);
      h.fake.storage.put(ref(row), new Uint8Array(8), "image/jpeg");
    }
    await sweep();
    const running = await latestRun();
    expect(running).toMatchObject({ state: "running", candidateCount: 101, deletedCount: 100 });
    await sweep();
    expect(await h.prisma.filePurgeRun.findUnique({ where: { id: running.id } })).toMatchObject({
      state: "done",
      deletedCount: 101,
    });
    h.clock.advance(DAY);
    n.clock.set(h.clock.now());
    const unknown = await file(),
      lostCommit = await file();
    const guarded = await Promise.all([storeFile(), storeFile(), storeFile()]);
    for (const row of guarded) await asset(row.id);
    const original = h.fake.storage.delete.bind(h.fake.storage);
    let failSettle = false;
    const deleting = vi.spyOn(h.fake.storage, "delete").mockImplementation(async (input) => {
      const result = await original(input);
      if (input.key === unknown.objectKey)
        return failed("unavailable", "lyxtest storage result unknown");
      if (input.key === lostCommit.objectKey) failSettle = true;
      return result;
    });
    const runTx = async <T>(fn: (tx: Tx) => Promise<T>) => {
      if (failSettle) {
        failSettle = false;
        throw new Error("lyxtest-settle-connection-lost");
      }
      return h.tx.run(fn);
    };
    await sweep(context(undefined, runTx));
    const aborted = await latestRun();
    expect(aborted).toMatchObject({ state: "aborted", deletedCount: 0, guardTrips: 3 });
    for (const row of [unknown, lostCommit]) {
      expect(await h.prisma.fileObject.findUnique({ where: { id: row.id } })).toMatchObject({
        status: "deleting",
        deletedAt: null,
      });
      expect(await h.fake.storage.head(ref(row))).toMatchObject({ ok: false, reason: "not_found" });
    }
    deleting.mockRestore();
    const manual = await file();
    await h.prisma.fileObject.update({
      where: { id: manual.id },
      data: { status: "deleting", updatedAt: h.clock.now() },
    });
    const unrelated = await h.prisma.filePurgeRun.create({
      data: {
        id: uuidv7(),
        mode: "auto",
        state: "aborted",
        candidateIds: [manual.id],
        candidateCount: 1,
        candidateBytes: 8n,
        byCategory: { poster: { count: 1, bytes: "8" } },
        deletedCount: 0,
        guardTrips: 3,
        startedAt: h.clock.now(),
        finishedAt: h.clock.now(),
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const restoring = vi.spyOn(h.fake.storage, "restoreVersions");
    h.clock.advance(31_000);
    n.clock.set(h.clock.now());
    // 新实例不保留旧回调内存；同key持久记录证明意图，aborted只恢复不继续删除。
    const restart = freshMedia();
    await restart.retention.sweep(context());
    await restart.jobs.shutdown();
    for (const row of [unknown, lostCommit]) {
      expect(await h.prisma.fileObject.findUnique({ where: { id: row.id } })).toMatchObject({
        status: "stored",
        deletedAt: null,
        erasedAt: null,
      });
      expect(await h.fake.storage.head(ref(row))).toMatchObject({ ok: true });
    }
    expect(await h.prisma.filePurgeRun.findUnique({ where: { id: aborted.id } })).toMatchObject({
      state: "aborted",
      deletedCount: 0,
    });
    expect(await h.prisma.fileObject.findUnique({ where: { id: manual.id } })).toMatchObject({
      status: "deleting",
      deletedAt: null,
    });
    expect(await h.fake.storage.head(ref(manual))).toMatchObject({ ok: true });
    expect(restoring.mock.calls.filter(([input]) => input.key === manual.objectKey)).toHaveLength(
      0,
    );
    expect(await h.prisma.filePurgeRun.findUnique({ where: { id: unrelated.id } })).toMatchObject({
      state: "aborted",
      deletedCount: 0,
    });
  });

  it("真实job signal在marker外呼后失租，后续settle/OCR零写且Provider收到同一取消信号", async () => {
    params.mode = "auto";
    const row = await file({
        category: "kyc_license",
        bucket: "secure",
        scopeType: "entity",
        entityId: h.merchant.entity.id,
        storedAt: new Date(h.clock.now().getTime() - 40 * DAY),
        createdAt: new Date(h.clock.now().getTime() - 40 * DAY),
      }),
      raw = await ocr(row.id),
      controller = new AbortController();
    const original = h.fake.storage.delete.bind(h.fake.storage);
    let observed: AbortSignal | undefined;
    vi.spyOn(h.fake.storage, "delete").mockImplementation(async (input) => {
      observed = input.signal;
      const result = await original(input);
      controller.abort(new Error("lyxtest-lease-lost"));
      return result;
    });
    await expect(sweep(context(controller.signal))).rejects.toThrow("lyxtest-lease-lost");
    expect(observed?.aborted).toBe(true);
    expect(await h.prisma.fileObject.findUnique({ where: { id: row.id } })).toMatchObject({
      status: "deleting",
      deletedAt: null,
    });
    expect(await h.prisma.ocrResult.findUnique({ where: { id: raw.id } })).toMatchObject({
      rawEnc: "fictional-encrypted-raw",
    });
    expect(await latestRun()).toMatchObject({ state: "running", deletedCount: 0 });
  });

  it("归档素材按真实归档日180天/肖像3年释放，I8真实ZIP/cover补偿与I13缓存修复", async () => {
    const ended = new Date(h.clock.now());
    ended.setUTCFullYear(ended.getUTCFullYear() - 3);
    ended.setUTCDate(ended.getUTCDate() - 1);
    const old = new Date(ended.getTime() - DAY);
    const user = await h.make.merchantUser({
      status: "deleted",
      deletedAt: ended,
      phoneEnc: null,
      phoneBidx: null,
      phoneMask: null,
      phoneLast4: null,
      displayName: null,
      createdAt: old,
    });
    const proof = await file({
      category: "account_proof",
      bucket: "secure",
      storedAt: old,
      createdAt: old,
      firstLinkedAt: old,
    });
    const decider = await h.make.staff({ createdAt: old });
    const approval = await h.prisma.approvalRequest.create({
      data: {
        id: uuidv7(),
        kind: "account_change",
        category: "approval",
        subjectType: "merchant_user",
        subjectId: user.id,
        requestNo: "ZH2026010500001",
        status: "approved",
        summarySnapshot: { title: "虚构已决定证明" },
        submitActorType: "staff",
        submitActorId: h.staff.id,
        submitClient: "admin",
        requesterStaffId: h.staff.id,
        submittedAt: old,
        decidedAt: old,
        decidedByStaffId: decider.id,
        dedupeKey: uuidv7(),
        createdAt: old,
        updatedAt: old,
      },
    });
    const request = await h.prisma.accountChangeRequest.create({
      data: {
        id: uuidv7(),
        approvalRequestId: approval.id,
        kind: "phone_rebind",
        merchantUserId: user.id,
        newPhoneMask: "138****1234",
        proofFileIds: [proof.id],
        reasonCode: "TEST",
        reasonText: "虚构历史核实证明",
        appliedAt: old,
        resultSnapshot: {},
        createdAt: old,
        updatedAt: old,
      },
    });
    await h.prisma.fileRef.create({
      data: {
        id: uuidv7(),
        fileId: proof.id,
        refType: "account_change_request",
        refId: request.id,
        role: "proof",
        state: "live",
        createdAt: old,
        updatedAt: old,
      },
    });
    const own = await h.make.merchant({ verified: true });
    const main = await file({
      category: "store_asset",
      bucket: "asset",
      scopeType: "store",
      entityId: own.entity.id,
      storeId: own.store.id,
    });
    const portrait = await file({
      category: "portrait_auth",
      bucket: "secure",
      scopeType: "store",
      entityId: own.entity.id,
      storeId: own.store.id,
    });
    const item = await asset(main.id, own, [portrait.id]);
    for (const [row, role] of [
      [main, "main"],
      [portrait, "portrait_auth"],
    ] as const)
      await h.tx.run((tx) =>
        h.media.link(tx, {
          fileId: row.id,
          entityId: own.entity.id,
          storeId: own.store.id,
          refType: "store_asset",
          refId: item.id,
          role,
        }),
      );
    const archivedAt = new Date(h.clock.now().getTime() - DAY);
    await h.prisma.store.update({
      where: { id: own.store.id },
      data: {
        lifecycle: "archived",
        archivedAt,
        archiveReason: "by_owner",
        archiveActorType: "merchant",
        archiveActorId: own.user.id,
        archiveClient: "weapp",
        updatedAt: h.clock.now(),
      },
    });
    const source = await file({
      category: "final_episode",
      bucket: "media",
      ext: "mp4",
      status: "deleted",
      deletedAt: h.clock.now(),
    });
    const cover = await file({ category: "video_cover", bucket: "pub" });
    await h.prisma.mediaInfo.create({
      data: {
        fileId: source.id,
        kind: "video",
        coverFileId: cover.id,
        rotation: 0,
        probeVersion: 1,
        raw: {},
        probedAt: h.clock.now(),
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await h.tx.run((tx) =>
      h.media.link(tx, {
        fileId: cover.id,
        entityId: null,
        storeId: null,
        refType: "media_info",
        refId: source.id,
        role: "cover",
      }),
    );
    const zip = await file({
      category: "package_zip",
      bucket: "media",
      status: "deleted",
      deletedAt: h.clock.now(),
      ext: "zip",
    });
    const bundle = await h.prisma.zipBundle.create({
      data: {
        id: uuidv7(),
        ownerType: "delivery_release",
        ownerId: uuidv7(),
        zipState: "ready",
        zipFileId: zip.id,
        zipGen: 2,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const orphan = await file({ purgeAfter: null });
    expect(
      (await h.tx.run((tx) => findI13Violations(tx, {}, h.clock.now()))).some(
        (violation) =>
          violation.subject && "id" in violation.subject && violation.subject.id === orphan.id,
      ),
    ).toBe(true);
    await sweep();
    expect(await h.prisma.fileRef.findFirst({ where: { fileId: proof.id } })).toMatchObject({
      state: "released",
      keepUntil: new Date(h.clock.now().getTime() + 7 * DAY),
    });
    expect(
      await h.prisma.accountChangeRequest.findUnique({ where: { id: request.id } }),
    ).toMatchObject({ proofFileIds: [proof.id], resultSnapshot: {} });
    expect(await h.prisma.fileRef.findFirst({ where: { fileId: main.id } })).toMatchObject({
      state: "released",
      keepUntil: new Date(archivedAt.getTime() + 180 * DAY),
    });
    const portraitEnd = new Date(archivedAt);
    portraitEnd.setUTCFullYear(portraitEnd.getUTCFullYear() + 3);
    expect(await h.prisma.fileRef.findFirst({ where: { fileId: portrait.id } })).toMatchObject({
      state: "released",
      keepUntil: portraitEnd,
    });
    const violations = await h.tx.run((tx) => h.media.retention.checkI8(tx, {}, h.clock.now()));
    expect(violations.every((violation) => violation.healed)).toBe(true);
    expect(await h.prisma.zipBundle.findUnique({ where: { id: bundle.id } })).toMatchObject({
      zipState: "none",
      zipGen: 3,
      zipFileId: null,
    });
    expect(await h.prisma.fileRef.findFirst({ where: { fileId: cover.id } })).toMatchObject({
      state: "released",
      keepUntil: new Date(h.clock.now().getTime() + 30 * DAY),
    });
    expect(
      (await h.tx.run((tx) => findI13Violations(tx, {}, h.clock.now()))).some(
        (violation) =>
          violation.subject && "id" in violation.subject && violation.subject.id === orphan.id,
      ),
    ).toBe(false);
  });

  it("到期需求使用同场景真实bizType、当前owner/clerk范围、持久去重与调用方回滚", async () => {
    const own = await n.merchant(),
      clerk = await h.make.merchantUser();
    const member = await h.make.entityMember({
      entityId: own.entity.id,
      merchantUserId: clerk.id,
      role: "clerk",
    });
    await h.make.storeMember({
      entityId: own.entity.id,
      entityMemberId: member.id,
      storeId: own.store.id,
    });
    const due = new Date(`${h.clock.now().toISOString().slice(0, 10)}T00:00:00Z`);
    const demand = await h.prisma.storeAssetDemand.create({
      data: {
        id: uuidv7(),
        entityId: own.entity.id,
        storeId: own.store.id,
        title: "虚构素材到期",
        dueDate: due,
        notifyScope: "owner_only",
        status: "open",
        createdByStaffId: h.staff.id,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await expect(
      h.tx.run(async (tx) => {
        await n.service.remindAssetDemand(tx, demand.id);
        throw new Error("lyxtest-demand-rollback");
      }),
    ).rejects.toThrow("lyxtest-demand-rollback");
    expect(await h.prisma.notification.count({ where: { bizId: demand.id } })).toBe(0);
    await sweep();
    await sweep();
    expect(await h.prisma.notification.findMany({ where: { bizId: demand.id } })).toMatchObject([
      {
        merchantUserId: own.user.id,
        sourceRule: "asset_request.due",
        node: "T-0",
        bizType: "store_asset_demand",
      },
    ]);
    await h.prisma.storeAssetDemand.update({
      where: { id: demand.id },
      data: { notifyScope: "owner_and_clerks", updatedAt: h.clock.now() },
    });
    await sweep();
    expect(await h.prisma.notification.count({ where: { bizId: demand.id } })).toBe(2);
    await h.prisma.notifyScene.update({
      where: { sceneKey: "m.asset_feedback" },
      data: { sceneEnabled: true, extEnabled: true, updatedAt: h.clock.now() },
    });
    const clerkNotice = await h.prisma.notification.findFirstOrThrow({
      where: { bizId: demand.id, merchantUserId: clerk.id },
    });
    const clerkDelivery = await h.prisma.notificationDelivery.findFirstOrThrow({
      where: { notificationId: clerkNotice.id, channel: "wx_subscribe" },
    });
    await h.prisma.storeAssetDemand.update({
      where: { id: demand.id },
      data: { notifyScope: "owner_only", updatedAt: h.clock.now() },
    });
    n.clock.advance(120_000);
    await n.service.deliver({ deliveryId: clerkDelivery.id });
    expect(
      await h.prisma.notificationDelivery.findUnique({ where: { id: clerkDelivery.id } }),
    ).toMatchObject({ status: "cancelled", reason: "guard_invalid" });
    const adoptedFile = await file({
      category: "store_asset",
      bucket: "asset",
      scopeType: "store",
      entityId: own.entity.id,
      storeId: own.store.id,
    });
    const adopted = await asset(adoptedFile.id, own);
    await h.prisma.storeAsset.update({
      where: { id: adopted.id },
      data: { adoptedCount: 1, updatedAt: h.clock.now() },
    });
    await n.config.params.get("notify.window.start");
    await n.config.params.get("notify.window.end");
    await h.tx.run((tx) =>
      n.service.onEvent(tx, {
        id: uuidv7(),
        type: "asset.adopted",
        payload: {
          v: 1,
          storeAssetId: adopted.id,
          storeId: own.store.id,
          usedByType: "order_item",
          usedById: uuidv7(),
          uploaderUserId: own.user.id,
        },
      }),
    );
    const notice = await h.prisma.notification.findFirstOrThrow({ where: { bizId: adopted.id } });
    expect(notice).toMatchObject({
      notifySceneKey: "m.asset_feedback",
      bizType: "store_asset",
      merchantUserId: own.user.id,
    });
    expect(
      await h.prisma.merchantMessage.findFirst({ where: { notificationId: notice.id } }),
    ).toMatchObject({
      link: { route: "asset.detail", params: { storeAssetId: adopted.id, storeId: own.store.id } },
    });
    // 同scene的当前投递守卫应选asset reader，不得误读demand而取消旧素材通知。
    const delivery = await h.prisma.notificationDelivery.findFirst({
      where: { notificationId: notice.id, channel: "wx_subscribe" },
    });
    expect(delivery).not.toBeNull();
    n.clock.advance(120_000);
    await n.service.deliver({ deliveryId: delivery!.id });
    expect(
      await h.prisma.notificationDelivery.findUnique({ where: { id: delivery!.id } }),
    ).toMatchObject({ status: "skipped", reason: "unconfigured" });
    await h.prisma.storeAssetDemand.update({
      where: { id: demand.id },
      data: { status: "done", closedAt: h.clock.now(), updatedAt: h.clock.now() },
    });
    await sweep();
    expect(await h.prisma.notification.count({ where: { bizId: demand.id } })).toBe(2);
  });
});
