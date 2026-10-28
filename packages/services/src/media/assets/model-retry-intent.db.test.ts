import { createHash } from "node:crypto";
import { createPrismaClient } from "@liyoxi/db";
import type { MediaJob, PrismaClient } from "@liyoxi/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useSeededDatabase, useTestRedis } from "../../testing/index.js";
import { createIdempotencyContext, createTxRunner, uuidv7 } from "../../kernel/index.js";
import { createMediaJobAdmin } from "../jobs/admin.js";
import type { MediaJobActor } from "../jobs/admin.js";
import { AssetJobInputSchema } from "./pipeline.js";
import { createAssetDocStrategy } from "./doc.js";
import {
  modelWorld,
  signal,
  structuredOutput,
  json,
  SLOW,
} from "./__fixtures__/model-admission.js";
import type { ModelWorld } from "./__fixtures__/model-admission.js";

const db = useSeededDatabase("services", { max: 1, label: "retryintent" }),
  redis = useTestRedis();
let client: Awaited<ReturnType<typeof redis.raw>>, other: PrismaClient, h: ModelWorld;
beforeAll(async () => {
  client = await redis.raw();
  await db.prisma();
  other = createPrismaClient({ connectionString: await db.url(), max: 1 });
}, SLOW);
beforeEach(async () => {
  h = await modelWorld(await db.prisma(), client, redis.prefix);
}, SLOW);
afterEach(async () => {
  try {
    await h?.close();
  } finally {
    vi.restoreAllMocks();
  }
}, SLOW);
afterAll(async () => {
  await other?.$disconnect();
}, SLOW);

const row = (id: string) => h.prisma.mediaJob.findUniqueOrThrow({ where: { id } });
const inputOf = (job: MediaJob) => AssetJobInputSchema.parse(job.input);
async function fail(job: MediaJob) {
  await h.refresh();
  return h.prisma.mediaJob.update({
    where: { id: job.id },
    data: { state: "failed", leaseOwner: null, finishedAt: h.clock.now(), isRetryable: true },
  });
}
function admin(prisma = h.prisma) {
  return createMediaJobAdmin({
    tx: prisma === h.prisma ? h.tx : createTxRunner({ prisma, appEnv: "test" }),
    clock: h.clock,
    jobs: h.media.jobs,
  });
}
function retry(id: string, key = uuidv7(), target = admin()) {
  if (!h.admin.staff) throw new Error("缺少真实后台员工上下文");
  const actor: MediaJobActor = {
    identity: h.admin.identity,
    staff: { ...h.admin.staff, stepUpAt: h.clock.now() },
    meta: { requestId: uuidv7(), ip: null, userAgent: null, authMethod: null, sessionId: null },
  };
  const body = { note: "隔离fixture人工重试" };
  return target.retry(actor, id, body, {
    idem: createIdempotencyContext({
      mode: "required",
      scope: "admin.mediaJob.retry",
      actor: actor.identity.actor,
      key,
      request: { method: "POST", pathParams: { mediaJobId: id }, body },
    }),
  });
}
async function spent() {
  return Object.entries(await h.snapshot())
    .filter(([key]) => key.startsWith("g:"))
    .reduce((total, [, value]) => total + Number(value), 0);
}

describe("持久人工retry意图", { timeout: 30_000 }, () => {
  it("两真实客户端三轮竞争各只有一个代次；幂等重放不再改输入或审计", async () => {
    const facts = await h.readyText(),
      original = inputOf(facts.job),
      ids = new Set<string>(),
      second = admin(other);
    for (let round = 0; round < 3; round++) {
      await fail(await row(facts.job.id));
      const keys = [uuidv7(), uuidv7()];
      const attempts = await Promise.allSettled([
        retry(facts.job.id, keys[0]!),
        retry(facts.job.id, keys[1]!, second),
      ]);
      expect(attempts.filter((one) => one.status === "fulfilled")).toHaveLength(1);
      const failed = attempts.find((one) => one.status === "rejected");
      expect(failed).toMatchObject({ reason: { error: "STATE_NOT_ALLOWED" } });
      const winner = attempts.findIndex((one) => one.status === "fulfilled"),
        value = attempts[winner]!;
      if (value.status !== "fulfilled") throw new Error("没有人工重试胜者");
      const fresh = await row(facts.job.id),
        input = inputOf(fresh);
      expect(fresh).toMatchObject({ id: facts.job.id, state: "queued", attemptNo: 0 });
      expect(fresh.dedupeKey).toBe(facts.job.dedupeKey);
      expect(input.runId).toBe(original.runId);
      expect(input.modelIntentId).toEqual(expect.any(String));
      ids.add(input.modelIntentId!);
      expect(await retry(facts.job.id, keys[winner]!)).toEqual(value.value);
      expect((await row(facts.job.id)).input).toEqual(fresh.input);
      expect(
        await h.prisma.auditLog.count({
          where: { targetId: facts.job.id, action: "media.job.retry" },
        }),
      ).toBe(round + 1);
    }
    expect(ids.size).toBe(3);
    expect(h.budget.reserve).not.toHaveBeenCalled();
  });

  it("人工retry的新vision意图独立收费；旧token保留且原文件日计数不重复", async () =>
    h.withControlledModelTime(async () => {
      const facts = await h.readyImage();
      expect(structuredOutput(await h.visionStrategy().execute(facts.job, signal())).status).toBe(
        "ok",
      );
      await fail(facts.job);
      await retry(facts.job.id);
      const claimed = await h.claim(await row(facts.job.id)),
        input = inputOf(claimed);
      expect(structuredOutput(await h.visionStrategy().execute(claimed, signal())).status).toBe(
        "ok",
      );
      expect(await h.visionStrategy().execute(claimed, signal())).toEqual({ state: "canceled" });
      expect(h.vision).toHaveBeenCalledTimes(2);
      expect(h.budget.reserve).toHaveBeenCalledTimes(3);
      expect(await h.budget.reserve.mock.results[0]!.value).toEqual({
        status: "reserved",
        units: 3,
        newFiles: 1,
      });
      expect(await h.budget.reserve.mock.results[1]!.value).toEqual({
        status: "reserved",
        units: 3,
        newFiles: 0,
      });
      expect(await h.budget.reserve.mock.results[2]!.value).toEqual({
        status: "denied",
        reason: "duplicate",
      });
      expect(h.budget.readPermit).toHaveBeenCalledTimes(5);
      for (const index of [0, 2]) {
        const p1 = h.budget.readPermit.mock.calls[index]![1],
          p2 = h.budget.readPermit.mock.calls[index + 1]![1];
        expect(p1.admitUntilMs - p1.readAtMs).toBe(250);
        expect(p2.admitUntilMs).toBe(p1.admitUntilMs);
        expect(p2.readAtMs).toBeGreaterThanOrEqual(p1.readAtMs);
        expect(p2.readAtMs).toBeLessThan(p1.admitUntilMs);
      }
      const permits = h.budget.reserve.mock.calls.map(([permit]) => permit);
      expect(permits[0]).toMatchObject({ jobId: facts.job.id, attemptNo: 1 });
      expect(Object.hasOwn(permits[0]!, "modelIntentId")).toBe(false);
      expect(permits[1]).toMatchObject({
        jobId: facts.job.id,
        modelIntentId: input.modelIntentId,
        attemptNo: 1,
      });
      const all = await h.snapshot();
      expect(all[`t:${facts.job.id}:1:vision`]).toBe(String(facts.job.deadlineAt.getTime()));
      expect(all[`t:${input.modelIntentId}:1:vision`]).toBe(String(claimed.deadlineAt.getTime()));
      expect(Object.keys(all).filter((key) => key.startsWith("t:"))).toHaveLength(2);
      expect(Object.keys(all).filter((key) => key.startsWith("f:"))).toHaveLength(1);
      expect(await spent()).toBe(6);
    }));

  it("P1后仅持久输入代次改变即取消；真实runner的旧在途结果不能写洞察", async () =>
    h.withControlledModelTime(async () => {
      const first = await h.readyText(),
        reserve = h.budget.reserve.getMockImplementation()!;
      h.budget.reserve.mockImplementationOnce(async (permit, abort) => {
        const result = await reserve(permit, abort);
        await h.prisma.mediaJob.update({
          where: { id: first.job.id },
          data: { input: json({ ...inputOf(first.job), modelIntentId: uuidv7() }) },
        });
        return result;
      });
      expect(await h.digestStrategy().execute(first.job, signal())).toEqual({ state: "canceled" });
      expect(h.budget.readPermit).toHaveBeenCalledTimes(1);
      expect(h.digest).not.toHaveBeenCalled();
      expect(await spent()).toBe(3);

      const late = await h.readyText("另一个受控在途摘要");
      await h.prisma.mediaJob.update({
        where: { id: late.job.id },
        data: { state: "queued", attemptNo: 0, leaseOwner: null, nextRunAt: h.clock.now() },
      });
      const summarize = h.digest.getMockImplementation()!;
      h.digest.mockImplementationOnce(async (input) => {
        const old = await row(late.job.id);
        await h.prisma.mediaJob.update({
          where: { id: late.job.id },
          data: { input: json({ ...inputOf(old), modelIntentId: uuidv7() }) },
        });
        return summarize(input);
      });
      await h.media.jobs.run({ jobId: late.job.id });
      expect((await row(late.job.id)).state).toBe("canceled");
      expect(h.digest).toHaveBeenCalledTimes(1);
      expect(
        await h.prisma.storeAssetInsight.count({
          where: { storeAssetId: late.assetId, kind: "digest" },
        }),
      ).toBe(0);
      expect(await spent()).toBe(6);
    }));

  it("新ASR意图已有TaskId只查询；doc_extract不占模型槽，冷账本仍不初始化", async () => {
    const audio = await h.readyAudio();
    await fail(audio.job);
    await retry(audio.job.id);
    const submitted = await h.prisma.mediaJob.update({
      where: { id: audio.job.id },
      data: {
        state: "submitted",
        attemptNo: 1,
        leaseOwner: `query:${uuidv7()}`,
        externalJobId: "1234567",
        nextRunAt: new Date(h.clock.now().getTime() + 120000),
      },
    });
    h.fake.asr.tasks.set("1234567", {
      taskId: "1234567",
      requestId: "controlled-query",
      state: "waiting",
    });
    h.caps.dailyCallCap = 0;
    await client.del(h.key);
    expect(await h.asrStrategy().poll(submitted, signal())).toEqual({ state: "pending" });
    expect(h.fake.asr.callsOf("query")).toHaveLength(1);
    expect(h.fake.asr.callsOf("submit")).toHaveLength(0);

    const bytes = Buffer.from("公开虚构文档"),
      key = `test/${uuidv7()}.txt`,
      etag = h.fake.storage.put({ bucket: "asset", key }, bytes, "text/plain");
    // 合法历史stored元数据，只验证doc无模型预算；不声称真实隔离解析已运行。
    const file = await h.make.fileObject({
      category: "store_asset",
      bucket: "asset",
      scopeType: "store",
      entityId: h.merchant.entity.id,
      storeId: h.merchant.store.id,
      uploadActorType: "merchant",
      uploadActorId: h.merchant.user.id,
      uploadClient: "weapp",
      objectKey: key,
      ext: "txt",
      declaredSize: BigInt(bytes.length),
      sizeBytes: BigInt(bytes.length),
      mime: "text/plain",
      declaredMime: "text/plain",
      etag,
      crc64: "12345",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const asset = await h.media.assets.create(h.owner, { type: "document", fileIds: [file.id] }),
      doc = await h.prisma.mediaJob.findFirstOrThrow({
        where: { parentId: asset.storeAssetId, kind: "doc_extract" },
      });
    await fail(doc);
    await retry(doc.id);
    const claimed = await h.claim(await row(doc.id));
    expect(inputOf(claimed).modelIntentId).toEqual(expect.any(String));
    const handler = h.media.jobs.handlers.get("doc_extract")!;
    expect(
      structuredOutput(
        await createAssetDocStrategy(h.deps(), handler.current).execute(claimed, signal(), null),
      ),
    ).toMatchObject({ status: "skipped", reason: "document_extractor_unconfigured" });
    expect(h.budget.readPermit).not.toHaveBeenCalled();
    expect(h.budget.reserve).not.toHaveBeenCalled();
    expect(h.evalCall).not.toHaveBeenCalled();
    expect(await client.exists(h.key)).toBe(0);

    h.caps.dailyCallCap = 10000;
    const cold = await h.readyText("冷账本不能自动恢复");
    expect(structuredOutput(await h.digestStrategy().execute(cold.job, signal()))).toMatchObject({
      status: "skipped",
      reason: "budget_unavailable",
    });
    expect(h.digest).not.toHaveBeenCalled();
    expect(await client.exists(h.key)).toBe(0);
  });
});
