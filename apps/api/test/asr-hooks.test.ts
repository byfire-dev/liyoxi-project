import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSeed, security, uuidv7 } from "@liyoxi/services";
import { createMediaAssetsHarness } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { asrHookHandlers } from "../src/routes/hooks/asr.js";
import { webhookRateLimit } from "../src/http/webhook.js";

const handle = useTestApi();
const key = "public-fake-asr-api-callback-key-with-32-bytes";
const operationId = "hooks.asr.mediaJob.wake";
let app: TestApi, unconfigured: TestApi;
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
let db: Awaited<ReturnType<typeof handle.db.prisma>>;
let sequence = 1;
beforeAll(async () => {
  unconfigured = await handle.start();
  db = await handle.db.prisma();
  await runSeed({ tx: unconfigured.runtime.tx, clock: unconfigured.clock });
  h = await createMediaAssetsHarness(db);
  h.permitControlledModel(true);
  app = await handle.start({
    webhookSources: [
      security.createAsrWebhookSource({
        key,
        configured: () => h.fake.asr.configured,
        wake: (tx, input) => h.media.wakeAsrJob(tx, input),
      }),
    ],
  });
  app.clock.set(h.clock.now());
}, 180_000);
afterAll(async () => {
  h?.permitControlledModel(false);
  await h?.close();
});

function request(
  id: string,
  body = "requestId=4000048858",
  options: {
    api?: TestApi;
    signature?: string;
    contentType?: string;
  } = {},
) {
  const signature = options.signature ?? createHmac("sha256", key).update(id).digest("base64url");
  return (options.api ?? app).request(`/api/v1/hooks/asr/media-jobs/${id}?sig=${signature}`, {
    method: "POST",
    body,
    headers: { "Content-Type": options.contentType ?? "application/x-www-form-urlencoded" },
  });
}
function wav() {
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
  bytes.writeUInt16LE(sequence++, 44);
  bytes.writeUInt16LE(sequence, 46);
  return bytes;
}
async function submitted() {
  h.fake.asr.resetCalls();
  const bytes = wav();
  const registered = (
    await h.media.register(h.owner, {
      category: "store_asset",
      files: [
        { fileName: "api-callback.wav", sizeBytes: String(bytes.length), clientToken: uuidv7() },
      ],
    })
  ).items[0]!;
  h.fake.storage.put({ bucket: "asset", key: registered.key }, bytes, "audio/wav");
  await h.media.complete(h.owner, registered.fileId);
  const promote = await db.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${registered.fileId}` },
  });
  await h.media.jobs.run({ jobId: promote.id });
  expect(await db.fileObject.findUniqueOrThrow({ where: { id: registered.fileId } })).toMatchObject(
    {
      status: "stored",
      ext: "wav",
      sizeBytes: BigInt(bytes.length),
    },
  );
  const asset = await h.media.assets.create(h.owner, {
    type: "audio",
    fileIds: [registered.fileId],
  });
  const probe = await db.mediaJob.findFirstOrThrow({
    where: { parentType: "store_asset", parentId: asset.storeAssetId, kind: "probe" },
  });
  await h.media.jobs.run({ jobId: probe.id });
  const queued = await db.mediaJob.findFirstOrThrow({
    where: { parentType: "store_asset", parentId: asset.storeAssetId, kind: "asr" },
  });
  await h.media.jobs.run({ jobId: queued.id });
  const job = await db.mediaJob.findUniqueOrThrow({ where: { id: queued.id } });
  expect(job).toMatchObject({ state: "submitted", provider: h.fake.asr.status, attemptNo: 1 });
  expect(job.externalJobId).toMatch(/^(0|[1-9][0-9]*)$/);
  expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
  expect(h.fake.asr.callsOf("query")).toHaveLength(0);
  h.clock.advance(1);
  app.clock.set(h.clock.now());
  return { job, assetId: asset.storeAssetId, fileId: registered.fileId };
}
const receipts = (id: string) =>
  db.webhookEvent.findMany({
    where: { provider: "asr", eventId: { startsWith: `${id}:` } },
    orderBy: { id: "asc" },
  });
const serialize = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );

describe(operationId + "真实API/DB/Redis组合", () => {
  it("真实受控受理→form验签只wake→原query保存不同文本；去重允许无害Redis唤醒", async () => {
    // Same DB, two real assemblies: fixture-only model admission and fake external ASR;
    // API receive/transaction/Redis remain real. This is not a configured production cloud chain.
    const facts = await submitted();
    const callbackText = "fictional-callback-text-never-trusted";
    const body =
      `requestId=${facts.job.externalJobId}&code=999&text=${callbackText}` +
      "&audioUrl=https%3A%2F%2Fprivate.invalid%2Fa";
    const response = await request(facts.job.id, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: 0, message: "success" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const woke = await db.mediaJob.findUniqueOrThrow({ where: { id: facts.job.id } });
    expect(woke).toEqual({ ...facts.job, nextRunAt: h.clock.now(), updatedAt: h.clock.now() });
    expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
    expect(h.fake.asr.callsOf("query")).toHaveLength(0);
    expect(
      await db.storeAssetInsight.count({
        where: { storeAssetId: facts.assetId, kind: "transcript" },
      }),
    ).toBe(0);
    const inbox = await receipts(facts.job.id);
    expect(inbox).toEqual([
      expect.objectContaining({
        provider: "asr",
        eventId: `${facts.job.id}:${facts.job.externalJobId}`,
        mode: "inline",
        processState: "processed",
        payload: null,
        keyVersion: null,
        payloadPurgeAt: null,
        payloadDigest: new Uint8Array(createHash("sha256").update(body).digest()),
      }),
    ]);
    const redis = await handle.redis.raw();
    const queueJobKey = `${handle.redis.prefix}bull:media_job:media-${facts.job.id}`;
    expect(await redis.hget(queueJobKey, "data")).toBe(JSON.stringify({ jobId: facts.job.id }));
    expect(await redis.lrange(`${handle.redis.prefix}bull:media_job:wait`, 0, -1)).toContain(
      `media-${facts.job.id}`,
    );
    expect((await request(facts.job.id, body)).status).toBe(200);
    expect(await receipts(facts.job.id)).toEqual(inbox);
    expect(await db.mediaJob.findUniqueOrThrow({ where: { id: facts.job.id } })).toEqual(woke);
    h.fake.asr.tasks.set(facts.job.externalJobId!, {
      taskId: facts.job.externalJobId!,
      requestId: "public-api-query-request",
      state: "succeeded",
      text: "真实回查的不同文字",
      durationSec: 1.2,
      segments: [{ text: "真实回查的不同文字", startMs: 10, endMs: 1200 }],
    });
    await h.media.jobs.run({ jobId: facts.job.id });
    expect(await db.mediaJob.findUniqueOrThrow({ where: { id: facts.job.id } })).toMatchObject({
      state: "succeeded",
      externalJobId: facts.job.externalJobId,
      attemptNo: 1,
    });
    expect(
      await db.storeAssetInsight.findMany({
        where: { storeAssetId: facts.assetId, kind: "transcript" },
      }),
    ).toEqual([
      expect.objectContaining({
        mediaJobId: facts.job.id,
        fileId: facts.fileId,
        status: "ok",
        content: {
          text: "真实回查的不同文字",
          durationSec: 1.2,
          segments: [{ text: "真实回查的不同文字", fromMs: 10, toMs: 1200 }],
        },
      }),
    ]);
    expect(h.fake.asr.callsOf("submit")).toHaveLength(1);
    expect(h.fake.asr.callsOf("query")).toHaveLength(1);
    expect(
      serialize({
        jobs: await db.mediaJob.findMany({
          where: { parentType: "store_asset", parentId: facts.assetId },
        }),
        inbox,
        logs: app.logs,
      }),
    ).not.toContain(callbackText);
    expect(serialize({ inbox, logs: app.logs })).not.toContain("private.invalid");
  });

  it("默认无source或独立回调key未配均404，不放开API默认模型预算", async () => {
    const id = uuidv7();
    const absent = await request(id, "requestId=1", { api: unconfigured });
    expect(absent.status).toBe(404);
    expect(await absent.text()).toBe("failure");
    const missingKey = await handle.start({
      webhookSources: [
        security.createAsrWebhookSource({
          configured: () => h.fake.asr.configured,
          wake: (tx, input) => h.media.wakeAsrJob(tx, input),
        }),
      ],
    });
    const disabled = await request(id, "requestId=1", { api: missingKey });
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual({ code: 1, message: "failure" });
    expect(await receipts(id)).toEqual([]);
  });

  it("独立HMAC错误401；原JSON与重复解码字段400且零收件", async () => {
    const id = uuidv7();
    const invalid = await request(id, "requestId=1", { signature: "A".repeat(43) });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ code: 1, message: "failure" });
    for (const body of ["requestId=1&%72equestId=1", "requestId=18446744073709551616"]) {
      const response = await request(id, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: 1, message: "failure" });
    }
    expect(
      (await request(id, '{"requestId":"1"}', { contentType: "application/json" })).status,
    ).toBe(400);
    expect(await receipts(id)).toEqual([]);
  });

  it("不存在的真实owner记ignored，ACK成功仅产生无害既有队列提醒", async () => {
    const id = uuidv7();
    const response = await request(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: 0, message: "success" });
    expect(await receipts(id)).toEqual([
      expect.objectContaining({
        processState: "ignored",
        payload: null,
        eventId: `${id}:4000048858`,
      }),
    ]);
    expect(await db.mediaJob.findUnique({ where: { id } })).toBeNull();
    const redis = await handle.redis.raw();
    expect(await redis.hget(`${handle.redis.prefix}bull:media_job:media-${id}`, "data")).toBe(
      JSON.stringify({ jobId: id }),
    );
  });

  it("坏UUID和坏sig在typed参数校验前按来源返回401", async () => {
    for (const id of ["not-a-uuid", uuidv7()]) {
      const response = await request(id, "requestId=1", {
        ...(id === "not-a-uuid" ? {} : { signature: "short" }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code: 1, message: "failure" });
    }
  });

  it("公共1MiB上界返回413且零收件；不复制CI小上限", async () => {
    const id = uuidv7();
    const response = await request(id, "requestId=1&text=" + "a".repeat(1_048_576));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: 1, message: "failure" });
    expect(await receipts(id)).toEqual([]);
  });

  it("真实hooks.ip限频保留429和Retry-After，坏签名也计数", async () => {
    const limited = await handle.start({
      handlers: asrHookHandlers,
      middlewares: [
        {
          slot: "rateLimit",
          groups: ["hooks"],
          factory: webhookRateLimit({
            quotas: { "hooks.ip": [{ by: "ip", limit: 2, windowSec: 60 }] },
          }),
        },
      ],
      webhookSources: [
        security.createAsrWebhookSource({
          key,
          configured: () => h.fake.asr.configured,
          wake: (tx, input) => h.media.wakeAsrJob(tx, input),
        }),
      ],
    });
    const id = uuidv7();
    for (let attempt = 0; attempt < 2; attempt++)
      expect((await request(id, "requestId=1", { api: limited, signature: "short" })).status).toBe(
        401,
      );
    const response = await request(id, "requestId=1", { api: limited });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ code: 1, message: "failure" });
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await receipts(id)).toEqual([]);
  });

  it("真实owner写入后的处理故障整事务回滚，500不发队列或回显原错", async () => {
    const facts = await submitted();
    const failing = await handle.start({
      webhookSources: [
        security.createAsrWebhookSource({
          key,
          configured: () => h.fake.asr.configured,
          wake: async (tx, input) => {
            expect(await h.media.wakeAsrJob(tx, input)).toBe("processed");
            throw new Error("fictional-private-owner-after-write");
          },
        }),
      ],
    });
    const response = await request(facts.job.id, `requestId=${facts.job.externalJobId}`, {
      api: failing,
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: 1, message: "failure" });
    expect(await db.mediaJob.findUniqueOrThrow({ where: { id: facts.job.id } })).toEqual(facts.job);
    expect(await receipts(facts.job.id)).toEqual([]);
    const redis = await handle.redis.raw();
    expect(await redis.exists(`${handle.redis.prefix}bull:media_job:media-${facts.job.id}`)).toBe(
      0,
    );
    expect(serialize(failing.logs)).not.toContain("fictional-private-owner-after-write");
  });
});
