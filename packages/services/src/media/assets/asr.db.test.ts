import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaJob } from "@liyoxi/db";
import {
  assertNotInTransaction,
  createIdentityContext,
  lockRows,
  uuidv7,
} from "../../kernel/index.js";
import {
  connectTestDatabase,
  createMediaAssetsHarness,
  useSeededDatabase,
} from "../../testing/index.js";
import { failed, ok } from "../../providers/types.js";
import type { AsrTaskStatus } from "../../providers/types.js";
import type { MediaActor } from "../index.js";
import { fileCategoryGuardPort, fileRefTypePort } from "../index.js";
import { advanceAsset, AssetJobInputSchema } from "./pipeline.js";

// 真实登记/上传/素材/任务/洞察表；仅对象存储和模型 IO 使用公开虚构替身。
const database = useSeededDatabase("services");
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
let sequence = 1;
const recognition = {
  text: "招牌牛肉面。汤底每天现熬。",
  durationSec: 2.38,
  segments: [
    { text: "招牌牛肉面。", startMs: 20, endMs: 900 },
    { text: "汤底每天现熬。", startMs: 940, endMs: 2380 },
  ],
};
const transcript = {
  text: recognition.text,
  durationSec: recognition.durationSec,
  segments: [
    { text: "招牌牛肉面。", fromMs: 20, toMs: 900 },
    { text: "汤底每天现熬。", fromMs: 940, toMs: 2380 },
  ],
};

beforeAll(async () => {
  h = await createMediaAssetsHarness(await database.prisma());
}, 120_000);
beforeEach(() => {
  h.fake.asr.resetCalls();
  h.fake.storage.resetCalls();
  h.permitControlledModel(true);
});
afterEach(() => {
  h.permitControlledModel(false);
  vi.restoreAllMocks();
});
afterAll(async () => {
  await h?.close();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function wav(seed = sequence++) {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  bytes.writeUInt16LE(seed, 44);
  bytes.writeUInt16LE(seed + 1, 46);
  return bytes;
}

// ECMA-182 元数据来自实际上传字节，不手改已存储文件的指纹来制造缓存命中。
function crc64(bytes: Uint8Array) {
  let crc = 0n;
  const mask = (1n << 64n) - 1n;
  for (const byte of bytes) {
    crc ^= BigInt(byte) << 56n;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc & (1n << 63n) ? (crc << 1n) ^ 0x42f0e1eba9ea3693n : crc << 1n) & mask;
  }
  return crc.toString();
}

async function stored(actor = h.owner, bytes: Uint8Array = wav()) {
  const original = h.fake.storage.head;
  const head = vi.spyOn(h.fake.storage, "head").mockImplementation(async (input) => {
    const result = await original(input);
    const object = h.fake.storage.objects.get(`${input.bucket}/${input.key}`);
    return result.ok && result.value.exists && object
      ? ok({ ...result.value, crc64: crc64(object.body) })
      : result;
  });
  try {
    const item = (
      await h.media.register(actor, {
        category: "store_asset",
        files: [
          { fileName: "menu.wav", sizeBytes: String(bytes.byteLength), clientToken: uuidv7() },
        ],
      })
    ).items[0]!;
    h.fake.storage.put({ bucket: "asset", key: item.key }, bytes, "audio/wav");
    await h.media.complete(actor, item.fileId);
    const promote = await h.prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${item.fileId}` },
    });
    await h.media.jobs.run({ jobId: promote.id });
    const file = await h.prisma.fileObject.findUniqueOrThrow({ where: { id: item.fileId } });
    expect(file).toMatchObject({
      status: "stored",
      ext: "wav",
      crc64: crc64(bytes),
      sizeBytes: BigInt(bytes.byteLength),
    });
    return file;
  } finally {
    head.mockRestore();
  }
}

async function ready(actor = h.owner, bytes?: Uint8Array) {
  const file = await stored(actor, bytes);
  const asset = await h.media.assets.create(actor, { type: "audio", fileIds: [file.id] });
  const probe = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentType: "store_asset", parentId: asset.storeAssetId, kind: "probe" },
  });
  await h.media.jobs.run({ jobId: probe.id });
  const job = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentType: "store_asset", parentId: asset.storeAssetId, kind: "asr" },
  });
  expect(job).toMatchObject({ state: "queued", mode: "remote", attemptNo: 0 });
  expect(job.deadlineAt.getTime() - job.createdAt.getTime()).toBe(1_800_000);
  return { assetId: asset.storeAssetId, file, job };
}
type Ready = Awaited<ReturnType<typeof ready>>;

async function row(id: string) {
  return h.prisma.mediaJob.findUniqueOrThrow({ where: { id } });
}
async function insights(assetId: string) {
  return h.prisma.storeAssetInsight.findMany({
    where: { storeAssetId: assetId, kind: "transcript" },
  });
}
async function due(jobId: string) {
  const job = await row(jobId);
  h.clock.advance(Math.max(0, job.nextRunAt.getTime() - h.clock.now().getTime()));
  await h.media.jobs.run({ jobId });
  return row(jobId);
}
async function submitted(facts: Ready) {
  await h.media.jobs.run({ jobId: facts.job.id });
  const job = await row(facts.job.id);
  expect(job).toMatchObject({ state: "submitted", attemptNo: 1, leaseOwner: null });
  expect(job.externalJobId).toMatch(/^\d+$/);
  expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
  expect(h.fake.asr.callsOf("transcribe")).toHaveLength(0);
  return job;
}
function succeeded(taskId: string): AsrTaskStatus {
  return {
    taskId,
    requestId: "public-query-request",
    state: "succeeded",
    ...structuredClone(recognition),
  };
}
async function complete(facts: Ready) {
  const job = await submitted(facts);
  h.fake.asr.tasks.set(job.externalJobId!, succeeded(job.externalJobId!));
  expect(await due(job.id)).toMatchObject({
    state: "succeeded",
    externalJobId: job.externalJobId,
    attemptNo: 1,
  });
  const result = await insights(facts.assetId);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    status: "ok",
    mediaJobId: job.id,
    fileId: facts.file.id,
    promptVersion: 1,
    content: transcript,
  });
  return result[0]!;
}
function safeJob(job: MediaJob) {
  const persisted = JSON.stringify({
    input: job.input,
    output: job.output,
    code: job.errorCode,
    message: job.errorMessage,
  });
  expect(persisted).not.toContain("https://fake-storage.invalid");
  expect(persisted).not.toContain("vendor-sensitive-error");
}
async function holdQuery(facts: Ready) {
  const job = await submitted(facts);
  const held = gate();
  let entered = false;
  const query = vi.spyOn(h.fake.asr, "query").mockImplementation(async (input) => {
    assertNotInTransaction("asr query");
    entered = true;
    await held.promise;
    return ok(succeeded(input.taskId));
  });
  h.clock.advance(job.nextRunAt.getTime() - h.clock.now().getTime());
  const running = h.media.jobs.run({ jobId: job.id });
  void running.catch(() => undefined);
  try {
    await vi.waitFor(
      () => {
        expect(entered).toBe(true);
      },
      { timeout: 2000 },
    );
  } catch (error) {
    held.release();
    await running;
    throw error;
  }
  return { job, query, release: held.release, running };
}

describe("素材异步 ASR：真实任务受理与回查", () => {
  it("submit一次→TaskId持久化→waiting/doing→真实全文、分句和秒时长落洞察", async () => {
    const facts = await ready();
    const submit = h.fake.asr.submit,
      query = h.fake.asr.query;
    vi.spyOn(h.fake.asr, "submit").mockImplementation((input) => {
      assertNotInTransaction("asr submit");
      expect(input.signal).toBeInstanceOf(AbortSignal);
      return submit(input);
    });
    vi.spyOn(h.fake.asr, "query").mockImplementation((input) => {
      assertNotInTransaction("asr query");
      expect(input.signal).toBeInstanceOf(AbortSignal);
      return query(input);
    });
    const accepted = await submitted(facts);
    expect(accepted.nextRunAt.getTime() - h.clock.now().getTime()).toBe(5000);
    expect(await insights(facts.assetId)).toEqual([]);
    const signed = h.fake.storage.callsOf("presignGet").at(-1)!.input;
    expect(signed).toMatchObject({ bucket: "asset", key: facts.file.objectKey, expiresSec: 7200 });
    const waiting = await due(accepted.id);
    expect(waiting).toMatchObject({
      state: "submitted",
      attemptNo: 1,
      externalJobId: accepted.externalJobId,
    });
    h.fake.asr.tasks.set(accepted.externalJobId!, {
      taskId: accepted.externalJobId!,
      requestId: "public-doing",
      state: "doing",
    });
    expect(await due(accepted.id)).toMatchObject({ state: "submitted", attemptNo: 1 });
    expect(await insights(facts.assetId)).toEqual([]);
    h.fake.asr.tasks.set(accepted.externalJobId!, succeeded(accepted.externalJobId!));
    const finished = await due(accepted.id);
    expect(finished).toMatchObject({
      state: "succeeded",
      attemptNo: 1,
      externalJobId: accepted.externalJobId,
    });
    expect(await insights(facts.assetId)).toEqual([
      expect.objectContaining({ status: "ok", content: transcript, mediaJobId: accepted.id }),
    ]);
    expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
    expect(h.fake.asr.callsOf("query")).toHaveLength(3);
    await Promise.all([
      h.media.jobs.run({ jobId: accepted.id }),
      h.media.jobs.run({ jobId: accepted.id }),
    ]);
    expect(await row(accepted.id)).toEqual(finished);
    expect(await insights(facts.assetId)).toHaveLength(1);
    h.permitControlledModel(false);
    await h.drain(facts.assetId);
    const view = await h.media.assets.get(h.owner, facts.assetId);
    expect(view).toMatchObject({
      transcript: { text: transcript.text, segments: transcript.segments },
    });
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: facts.assetId, eventType: "asset.processed" },
      }),
    ).toBe(1);
    const events = await h.prisma.outboxEvent.findMany({ where: { aggregateId: facts.assetId } });
    const persistedEvents = JSON.stringify(events, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(persistedEvents).not.toContain(transcript.text);
    expect(persistedEvents).not.toContain("https://fake-storage.invalid");
    safeJob(finished);
  });

  it("默认缺预算仍skipped/partial，无签名、提交或查询", async () => {
    h.permitControlledModel(false);
    const facts = await ready();
    await h.media.jobs.run({ jobId: facts.job.id });
    expect(await insights(facts.assetId)).toEqual([
      expect.objectContaining({ status: "skipped", content: { reason: "budget_unconfigured" } }),
    ]);
    expect(h.fake.asr.calls).toEqual([]);
    expect(h.fake.storage.callsOf("presignGet")).toEqual([]);
    await h.drain(facts.assetId);
    expect(
      await h.prisma.storeAsset.findUniqueOrThrow({ where: { id: facts.assetId } }),
    ).toMatchObject({ processingState: "processed", isInsightPartial: true });
  });

  it("同job双入口只提交一次，不把同步transcribe当异步能力", async () => {
    const facts = await ready();
    await Promise.all([
      h.media.jobs.run({ jobId: facts.job.id }),
      h.media.jobs.run({ jobId: facts.job.id }),
    ]);
    expect(await row(facts.job.id)).toMatchObject({ state: "submitted", attemptNo: 1 });
    expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
    expect(h.fake.asr.callsOf("transcribe")).toEqual([]);
  });

  it("受理unknown保守失败，后续run不会自动重提或编造TaskId", async () => {
    const facts = await ready();
    h.fake.asr.failNext("submit", { reason: "unavailable", message: "vendor-sensitive-error" });
    await h.media.jobs.run({ jobId: facts.job.id });
    const stopped = await row(facts.job.id);
    expect(stopped).toMatchObject({
      state: "failed",
      attemptNo: 1,
      externalJobId: null,
      errorCode: "ASR_SUBMISSION_UNKNOWN",
    });
    safeJob(stopped);
    h.clock.advance(180_000);
    await h.media.jobs.run({ jobId: stopped.id });
    expect(await row(stopped.id)).toEqual(stopped);
    expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
    expect(h.fake.asr.callsOf("query")).toEqual([]);
    expect(await insights(facts.assetId)).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("明确not_accepted终态拒绝，后续run不重提且不持久化供应商正文", async () => {
    const facts = await ready();
    const submit = vi.spyOn(h.fake.asr, "submit").mockResolvedValue({
      ...failed("rejected", "vendor-sensitive-error"),
      acceptance: "not_accepted",
      code: "provider_rejected",
    });
    await h.media.jobs.run({ jobId: facts.job.id });
    const stopped = await row(facts.job.id);
    expect(stopped).toMatchObject({
      state: "failed",
      attemptNo: 1,
      externalJobId: null,
      errorCode: "ASR_SUBMISSION_REJECTED",
    });
    h.clock.advance(180_000);
    await h.media.jobs.run({ jobId: stopped.id });
    expect(await row(stopped.id)).toEqual(stopped);
    expect(submit).toHaveBeenCalledOnce();
    expect(h.fake.asr.callsOf("query")).toEqual([]);
    expect(await insights(facts.assetId)).toEqual([expect.objectContaining({ status: "failed" })]);
    safeJob(stopped);
  });

  it("崩溃遗留submitting且无TaskId只恢复失败，不能据空号证明未受理", async () => {
    const facts = await ready();
    await h.prisma.mediaJob.update({
      where: { id: facts.job.id },
      data: {
        state: "submitting",
        attemptNo: 1,
        leaseOwner: "crashed-owner",
        externalJobId: null,
        nextRunAt: h.clock.now(),
      },
    });
    await h.media.jobs.run({ jobId: facts.job.id });
    const stopped = await row(facts.job.id);
    expect(stopped).toMatchObject({
      state: "failed",
      attemptNo: 1,
      externalJobId: null,
      errorCode: "ASR_SUBMISSION_UNKNOWN",
    });
    expect(h.fake.asr.calls).toEqual([]);
    safeJob(stopped);
  });

  it("submitting已有TaskId时恢复只查原任务，不提交新任务", async () => {
    const facts = await ready();
    const accepted = await submitted(facts);
    h.fake.asr.resetCalls();
    h.fake.asr.tasks.set(accepted.externalJobId!, succeeded(accepted.externalJobId!));
    await h.prisma.mediaJob.update({
      where: { id: accepted.id },
      data: { state: "submitting", leaseOwner: "crashed-owner", nextRunAt: h.clock.now() },
    });
    await h.media.jobs.run({ jobId: accepted.id });
    expect(await row(accepted.id)).toMatchObject({
      state: "succeeded",
      attemptNo: 1,
      externalJobId: accepted.externalJobId,
    });
    expect(h.fake.asr.callsOf("submit")).toEqual([]);
    expect(h.fake.asr.callsOf("query")).toHaveLength(1);
    expect(await insights(facts.assetId)).toEqual([
      expect.objectContaining({ content: transcript }),
    ]);
  });

  it("submitted缺TaskId受控失败，无submit/query与成功洞察", async () => {
    const facts = await ready();
    await h.prisma.mediaJob.update({
      where: { id: facts.job.id },
      data: { state: "submitted", attemptNo: 1, externalJobId: null, nextRunAt: h.clock.now() },
    });
    await h.media.jobs.run({ jobId: facts.job.id });
    expect(await row(facts.job.id)).toMatchObject({
      state: "failed",
      externalJobId: null,
      errorCode: "ASR_SUBMISSION_UNKNOWN",
    });
    expect(h.fake.asr.calls).toEqual([]);
    expect((await insights(facts.assetId)).every((insight) => insight.status !== "ok")).toBe(true);
  });

  it("查询transport失败只等待原TaskId，下一次回查成功不增加attempt或submit", async () => {
    const facts = await ready();
    const accepted = await submitted(facts);
    h.fake.asr.failNext("query", { reason: "unavailable", message: "vendor-sensitive-error" });
    const pending = await due(accepted.id);
    expect(pending).toMatchObject({
      state: "submitted",
      attemptNo: 1,
      externalJobId: accepted.externalJobId,
    });
    expect(await insights(facts.assetId)).toEqual([]);
    h.fake.asr.tasks.set(accepted.externalJobId!, succeeded(accepted.externalJobId!));
    expect(await due(accepted.id)).toMatchObject({ state: "succeeded", attemptNo: 1 });
    expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
    safeJob(await row(accepted.id));
  });

  it("query抛错保持pending和原TaskId，原deadline终止后重复run零追加submit", async () => {
    const facts = await ready();
    const accepted = await submitted(facts);
    const query = vi
      .spyOn(h.fake.asr, "query")
      .mockRejectedValue(new Error("vendor-sensitive-error"));
    const pending = await due(accepted.id);
    expect(pending).toMatchObject({
      state: "submitted",
      attemptNo: 1,
      externalJobId: accepted.externalJobId,
      deadlineAt: accepted.deadlineAt,
    });
    expect(pending.nextRunAt.getTime()).toBeGreaterThan(h.clock.now().getTime());
    expect(await insights(facts.assetId)).toEqual([]);
    h.clock.advance(accepted.deadlineAt.getTime() - h.clock.now().getTime() + 1);
    await h.media.jobs.run({ jobId: accepted.id });
    const stopped = await row(accepted.id);
    expect(stopped).toMatchObject({
      state: "failed",
      errorCode: "MEDIA_JOB_EXHAUSTED",
      attemptNo: 1,
      externalJobId: accepted.externalJobId,
    });
    await Promise.all([
      h.media.jobs.run({ jobId: stopped.id }),
      h.media.jobs.run({ jobId: stopped.id }),
    ]);
    expect(await row(stopped.id)).toEqual(stopped);
    expect(query).toHaveBeenCalledOnce();
    expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
    expect(await insights(facts.assetId)).toEqual([expect.objectContaining({ status: "failed" })]);
    safeJob(stopped);
  });

  it("供应商任务failed如实降级，不补空逐字稿和空分句成功", async () => {
    const facts = await ready();
    const accepted = await submitted(facts);
    h.fake.asr.tasks.set(accepted.externalJobId!, {
      taskId: accepted.externalJobId!,
      requestId: "public-failed",
      state: "failed",
      code: "recognition_failed",
    });
    expect(await due(accepted.id)).toMatchObject({
      state: "failed",
      attemptNo: 1,
      errorCode: "ASR_RECOGNITION_FAILED",
    });
    expect(await insights(facts.assetId)).toEqual([expect.objectContaining({ status: "failed" })]);
    h.permitControlledModel(false);
    await h.drain(facts.assetId);
    expect(
      await h.prisma.storeAsset.findUniqueOrThrow({ where: { id: facts.assetId } }),
    ).toMatchObject({ processingState: "processed", isInsightPartial: true });
  });

  it.each([
    { label: "错TaskId", patch: { taskId: "99999999" } },
    { label: "非十进制TaskId", patch: { taskId: "abc" } },
    { label: "uint64溢出TaskId", patch: { taskId: "18446744073709551616" } },
    { label: "缺全文", patch: { text: "" } },
    { label: "缺实际时长", patch: { durationSec: 0 } },
    { label: "缺分句", patch: { segments: [] } },
  ])("回查$label不得写成功洞察", async ({ patch }) => {
    const facts = await ready();
    const accepted = await submitted(facts);
    vi.spyOn(h.fake.asr, "query").mockResolvedValue(
      ok({ ...succeeded(accepted.externalJobId!), ...patch }),
    );
    expect(await due(accepted.id)).toMatchObject({
      state: "failed",
      errorCode: "ASR_RESULT_INVALID",
    });
    expect(await insights(facts.assetId)).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
  });
});

describe("素材异步 ASR：归属、晚结果与缓存", () => {
  it.each(["subject", "dedupe", "marker"] as const)(
    "错误%s归属拒领，任务不变且零IO/洞察",
    async (field) => {
      const facts = await ready();
      const input = AssetJobInputSchema.parse(facts.job.input);
      const data =
        field === "subject"
          ? { subjectId: uuidv7() }
          : field === "dedupe"
            ? { dedupeKey: `foreign:${uuidv7()}` }
            : { input: { ...input, assetMarker: "wrong" } };
      const before = await h.prisma.mediaJob.update({ where: { id: facts.job.id }, data });
      await h.media.jobs.run({ jobId: before.id });
      expect(await row(before.id)).toEqual(before);
      expect(h.fake.asr.calls).toEqual([]);
      expect(await insights(facts.assetId)).toEqual([]);
    },
  );

  it.each(["etag", "crc64", "sizeBytes"] as const)(
    "在途查询后%s失配，晚结果不落洞察",
    async (field) => {
      const facts = await ready();
      const held = await holdQuery(facts);
      try {
        const data =
          field === "etag"
            ? { etag: '"new-fingerprint"' }
            : field === "crc64"
              ? { crc64: "1" }
              : { sizeBytes: facts.file.sizeBytes! + 1n };
        await h.prisma.fileObject.update({ where: { id: facts.file.id }, data });
      } finally {
        held.release();
        await held.running;
      }
      expect(await row(held.job.id)).toMatchObject({ state: "canceled", attemptNo: 1 });
      expect(await insights(facts.assetId)).toEqual([]);
      expect(held.query).toHaveBeenCalledOnce();
      expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
    },
  );

  it("关联真实外主体文件且任务指纹完全匹配时拒领，零ASR调用或洞察", async () => {
    const facts = await ready();
    const assetBefore = await h.prisma.storeAsset.findUniqueOrThrow({
      where: { id: facts.assetId },
    });
    const merchant = await h.make.merchant({ verified: true });
    const actor: MediaActor = {
      identity: createIdentityContext({
        actor: { type: "merchant", id: merchant.user.id, client: "weapp", role: "owner" },
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
      }),
      merchant: { entityId: merchant.entity.id, storeId: merchant.store.id, standing: "owner" },
    };
    const foreign = await stored(actor);
    expect(foreign.entityId).not.toBe(assetBefore.entityId);
    expect(foreign.storeId).not.toBe(assetBefore.storeId);
    await h.prisma.storeAssetFile.update({
      where: { storeAssetId_position: { storeAssetId: facts.assetId, position: 1 } },
      data: { fileId: foreign.id },
    });
    const input = AssetJobInputSchema.parse(facts.job.input);
    const before = await h.prisma.mediaJob.update({
      where: { id: facts.job.id },
      data: {
        subjectId: foreign.id,
        input: {
          ...input,
          fileId: foreign.id,
          etag: foreign.etag,
          crc64: foreign.crc64,
          sizeBytes: foreign.sizeBytes!.toString(),
        },
        dedupeKey: `asset:${facts.assetId}:${input.runId}:asr:${foreign.id}:v${input.promptVersion}`,
      },
    });
    h.fake.storage.resetCalls();
    await h.media.jobs.run({ jobId: before.id });
    // This canonical asset job is owned, but current scope rejects it before any claim/IO.
    expect(await row(before.id)).toEqual({
      ...before,
      state: "canceled",
      finishedAt: h.clock.now(),
      updatedAt: h.clock.now(),
    });
    expect(h.fake.asr.calls).toEqual([]);
    expect(h.fake.storage.callsOf("presignGet")).toEqual([]);
    expect(await insights(facts.assetId)).toEqual([]);
    expect(await h.prisma.fileObject.findUniqueOrThrow({ where: { id: foreign.id } })).toEqual(
      foreign,
    );
    expect(await h.prisma.storeAsset.findUniqueOrThrow({ where: { id: facts.assetId } })).toEqual(
      assetBefore,
    );
  });

  it.each(["delete", "block"] as const)("查询在途父素材%s后晚结果不覆盖赢家", async (change) => {
    const facts = await ready();
    const held = await holdQuery(facts);
    let winner;
    let eventsBefore;
    try {
      if (change === "delete")
        await h.media.assets.remove(h.admin, facts.assetId, { reasonText: "在途撤销" });
      else
        await h.tx.run(async (tx) => {
          await lockRows(tx, "store_asset", [facts.assetId]);
          await tx.storeAsset.update({
            where: { id: facts.assetId },
            data: { moderationState: "block" },
          });
          // A block winner is settled by the existing domain plan, never by a fabricated state.
          await advanceAsset(
            tx,
            {
              tx: h.tx,
              clock: h.clock,
              events: h.events,
              assembly: h.assembly,
              storage: h.fake.storage,
              assets: h.assets,
              refTypes: h.assembly.portEntries(fileRefTypePort),
              guards: h.assembly.portEntries(fileCategoryGuardPort),
            },
            facts.assetId,
          );
        });
      winner = await h.prisma.storeAsset.findUniqueOrThrow({ where: { id: facts.assetId } });
      eventsBefore = await h.prisma.outboxEvent.findMany({
        where: { aggregateId: facts.assetId },
        orderBy: { id: "asc" },
      });
      expect(eventsBefore.filter((event) => event.eventType === "asset.processed")).toHaveLength(
        change === "block" ? 1 : 0,
      );
    } finally {
      held.release();
      await held.running;
    }
    expect(await row(held.job.id)).toMatchObject({ state: "canceled" });
    expect(await insights(facts.assetId)).toEqual([]);
    expect(await h.prisma.storeAsset.findUniqueOrThrow({ where: { id: facts.assetId } })).toEqual(
      winner,
    );
    expect(
      await h.prisma.outboxEvent.findMany({
        where: { aggregateId: facts.assetId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(eventsBefore);
  });

  it.each(["run", "prompt"] as const)("新%s代次存在时旧回查结果0采纳", async (change) => {
    const facts = await ready();
    const held = await holdQuery(facts);
    try {
      const input = AssetJobInputSchema.parse(held.job.input);
      const fresh = {
        ...input,
        ...(change === "run" ? { runId: uuidv7() } : { promptVersion: 2 }),
      };
      // 模拟已提交的新代次事实；旧在途输入不变，最新run/prompt从独立新行取得。
      await h.prisma.mediaJob.create({
        data: {
          id: uuidv7(),
          kind: "asr",
          provider: facts.job.provider,
          mode: "remote",
          parentType: "store_asset",
          parentId: facts.assetId,
          subjectType: "file_object",
          subjectId: facts.file.id,
          input: fresh,
          state: "queued",
          nextRunAt: h.clock.now(),
          deadlineAt: facts.job.deadlineAt,
          dedupeKey: `asset:${facts.assetId}:${fresh.runId}:asr:${facts.file.id}:v${fresh.promptVersion}`,
          createdAt: new Date(h.clock.now().getTime() + 1),
          updatedAt: h.clock.now(),
        },
      });
    } finally {
      held.release();
      await held.running;
    }
    expect(await row(held.job.id)).toMatchObject({ state: "canceled" });
    expect(await insights(facts.assetId)).toEqual([]);
    expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
  });

  it("查询期间租约赢家变化，旧owner不写任务整行或洞察", async () => {
    const facts = await ready();
    const held = await holdQuery(facts);
    let winner: MediaJob;
    try {
      winner = await h.prisma.mediaJob.update({
        where: { id: held.job.id },
        data: {
          leaseOwner: "new-real-owner",
          nextRunAt: new Date(h.clock.now().getTime() + 120_000),
        },
      });
    } finally {
      held.release();
      await held.running;
    }
    expect(await row(held.job.id)).toEqual(winner!);
    expect(await insights(facts.assetId)).toEqual([]);
  });

  it("claim先等真实父锁，取得前不查询；放锁后只有一份洞察", async () => {
    const facts = await ready();
    const accepted = await submitted(facts);
    h.fake.asr.tasks.set(accepted.externalJobId!, succeeded(accepted.externalJobId!));
    h.clock.advance(accepted.nextRunAt.getTime() - h.clock.now().getTime());
    const locked = gate(),
      unlock = gate();
    const observer = await connectTestDatabase(database.name, { role: null });
    let blockerPid: number;
    const parent = h.tx.run(async (tx) => {
      await lockRows(tx, "store_asset", [facts.assetId]);
      const session = await tx.$queryRaw<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid()::int AS pid`;
      blockerPid = session[0]!.pid;
      locked.release();
      await unlock.promise;
    });
    let running: Promise<void> | undefined;
    try {
      await Promise.race([
        locked.promise,
        parent.then(() => {
          throw new Error("父锁会话提前退出");
        }),
      ]);
      running = h.media.jobs.run({ jobId: accepted.id });
      await vi.waitFor(
        async () => {
          // Only the observer uses the owner role to see real app sessions' lock details.
          const blocked = await observer.query<{ count: string }>(
            `
          SELECT count(*)::bigint AS count FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%store_asset%' AND $1=ANY(pg_blocking_pids(pid))
        `,
            [blockerPid!],
          );
          expect(Number(blocked.rows[0]!.count)).toBeGreaterThan(0);
        },
        { timeout: 3000 },
      );
      expect(h.fake.asr.callsOf("query")).toEqual([]);
      expect(await insights(facts.assetId)).toEqual([]);
    } finally {
      unlock.release();
      try {
        await parent;
        await running;
      } finally {
        await observer.end();
      }
    }
    expect(await row(accepted.id)).toMatchObject({ state: "succeeded" });
    expect(h.fake.asr.callsOf("query")).toHaveLength(1);
    expect(await insights(facts.assetId)).toHaveLength(1);
  });

  it("同主体相同实际字节/指纹/prompt复制transcript并保留来源，零新增付费IO", async () => {
    const bytes = wav();
    const original = await ready(h.owner, bytes);
    const source = await complete(original);
    h.fake.asr.resetCalls();
    const copy = await ready(h.owner, bytes);
    await h.media.jobs.run({ jobId: copy.job.id });
    expect(await insights(copy.assetId)).toEqual([
      expect.objectContaining({
        status: "ok",
        content: transcript,
        reusedFromStoreAssetInsightId: source.id,
      }),
    ]);
    expect(h.fake.asr.calls).toEqual([]);
  });

  it("旧同步ok缓存缺时长且空分句时重新submit，不复制为异步成功", async () => {
    const bytes = wav();
    const original = await ready(h.owner, bytes);
    const source = await complete(original);
    const historical = await h.prisma.storeAssetInsight.update({
      where: { id: source.id },
      data: { content: { text: transcript.text, segments: [] } },
    });
    h.fake.asr.resetCalls();
    const copy = await ready(h.owner, bytes);
    await submitted(copy);
    expect(await insights(copy.assetId)).toEqual([]);
    expect(
      await h.prisma.storeAssetInsight.findUniqueOrThrow({ where: { id: source.id } }),
    ).toEqual(historical);
    expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
    expect(h.fake.asr.callsOf("query")).toEqual([]);
  });

  it("跨主体相同字节不复用transcript，各自提交独立任务", async () => {
    const bytes = wav();
    const original = await ready(h.owner, bytes);
    await complete(original);
    h.fake.asr.resetCalls();
    const merchant = await h.make.merchant({ verified: true });
    const actor: MediaActor = {
      identity: createIdentityContext({
        actor: { type: "merchant", id: merchant.user.id, client: "weapp", role: "owner" },
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
      }),
      merchant: { entityId: merchant.entity.id, storeId: merchant.store.id, standing: "owner" },
    };
    const foreign = await ready(actor, bytes);
    await submitted(foreign);
    expect(await insights(foreign.assetId)).toEqual([]);
    expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
  });

  it("不同prompt的同主体旧洞察保留，不跨版本复用", async () => {
    const bytes = wav();
    const original = await ready(h.owner, bytes);
    const source = await complete(original);
    const historical = await h.prisma.storeAssetInsight.update({
      where: { id: source.id },
      data: { promptVersion: 2 },
    });
    h.fake.asr.resetCalls();
    const next = await ready(h.owner, bytes);
    await submitted(next);
    expect(await insights(next.assetId)).toEqual([]);
    expect(
      await h.prisma.storeAssetInsight.findUniqueOrThrow({ where: { id: source.id } }),
    ).toEqual(historical);
    expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
  });

  it("原30分钟deadline后不查询或重提，终态失败保留partial", async () => {
    const facts = await ready();
    const accepted = await submitted(facts);
    h.clock.advance(accepted.deadlineAt.getTime() - h.clock.now().getTime() + 1);
    await h.media.jobs.run({ jobId: accepted.id });
    expect(await row(accepted.id)).toMatchObject({
      state: "failed",
      errorCode: "MEDIA_JOB_EXHAUSTED",
      attemptNo: 1,
    });
    expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
    expect(h.fake.asr.callsOf("query")).toEqual([]);
    expect(await insights(facts.assetId)).toEqual([expect.objectContaining({ status: "failed" })]);
  });
});
