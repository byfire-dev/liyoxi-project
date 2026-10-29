import { describe, expect, it, vi } from "vitest";
import { createIdentityContext, isInTransaction, uuidv7 } from "../../kernel/index.js";
import { useSeededDatabase } from "../../testing/index.js";
import { batchDraft, batchHarness, MP4_HEADER } from "./batch-test.fixture.js";

const db = useSeededDatabase("services", { label: "batchpost" });
async function setup(local = true) {
  const h = await batchHarness(await db.prisma());
  h.fake.storage.capabilities.sts = false;
  if (local) Object.defineProperty(h.fake.storage, "status", { value: "local" });
  return h;
}
async function uploading(h: Awaited<ReturnType<typeof setup>>) {
  const batch = await h.create();
  await h.media.uploadBatches.start(h.actor, batch.uploadBatchId, {});
  return batch;
}

describe("本地原片批次逐文件 POST 凭据", { timeout: 60_000 }, () => {
  it("创建和读取不签发策略，pending 文件按真实存储能力登记 POST", async () => {
    const h = await setup(),
      batch = await h.create();
    const file = await h.prisma.fileObject.findUniqueOrThrow({
      where: { id: batch.items[0]!.fileId },
    });
    expect(file).toMatchObject({ uploadMode: "post", status: "pending" });
    expect(batch.bucket).toBe(h.fake.storage.uploadLocation!.buckets.media);
    const read = await h.media.uploadBatches.get(h.actor, batch.uploadBatchId);
    expect(JSON.stringify(read)).not.toMatch(/policy|signature|tmpSecret|sessionToken/);
    expect(h.fake.storage.callsOf("presignPost")).toHaveLength(0);
    expect(h.fake.storage.callsOf("issueSts")).toHaveLength(0);
    expect(await h.prisma.mediaCheck.count({ where: { fileId: file.id } })).toBe(0);
  });

  it("事务外按持久化 key、MIME、精确大小签600秒，并沿正式完成入口确认对象", async () => {
    const h = await setup(),
      batch = await uploading(h),
      file = await h.prisma.fileObject.findUniqueOrThrow({
        where: { id: batch.items[0]!.fileId },
      });
    const original = h.fake.storage.presignPost.bind(h.fake.storage);
    const sign = vi.spyOn(h.fake.storage, "presignPost").mockImplementation(async (input) => {
      expect(isInTransaction()).toBe(false);
      return original(input);
    });
    try {
      const credentials = await h.media.uploadBatches.refreshCredentials(
        h.actor,
        batch.uploadBatchId,
        {},
      );
      expect(credentials).toMatchObject({
        mode: "post",
        bucket: h.fake.storage.uploadLocation!.buckets.media,
        region: h.fake.storage.uploadLocation!.region,
        prefix: `incoming/b${batch.uploadBatchId}/`,
        fileParallel: 3,
        expiresAt: new Date(h.clock.now().getTime() + 600_000).toISOString(),
        posts: [{ fileId: file.id, key: file.incomingKey }],
      });
      expect(credentials).not.toHaveProperty("sts");
      expect(credentials).not.toHaveProperty("chunkSize");
      expect(credentials).not.toHaveProperty("chunkParallel");
      expect(sign).toHaveBeenCalledExactlyOnceWith({
        bucket: file.incomingBucket,
        key: file.incomingKey,
        mime: file.declaredMime,
        maxBytes: Number(file.declaredSize),
        expiresSec: 600,
      });
      if (credentials.mode !== "post") throw new Error("expected POST credentials");
      const post = credentials.posts[0]!;
      expect(
        h.fake.storage.upload(
          { ...post.post, key: post.key, expiresAt: new Date(post.expiresAt) },
          MP4_HEADER,
        ),
      ).toBe(204);
      expect(
        (await h.media.uploadBatches.complete(h.actor, batch.items[0]!.uploadBatchItemId, {}))
          .fileStatus,
      ).toBe("promoting");
      expect(await h.prisma.mediaCheck.count({ where: { fileId: file.id } })).toBe(0);
      expect(h.fake.storage.callsOf("issueSts")).toHaveLength(0);
    } finally {
      sign.mockRestore();
    }
  });

  it("只为仍有效的 pending 条目发凭据，不包含跳过、被替换或已确认文件", async () => {
    const h = await setup(),
      batch = await h.create([
        batchDraft("第1集.mp4"),
        batchDraft("第2集.mp4"),
        batchDraft("第3集.mp4"),
      ]);
    await h.media.uploadBatches.start(h.actor, batch.uploadBatchId, {});
    await h.media.uploadBatches.update(h.actor, batch.items[1]!.uploadBatchItemId, { skip: true });
    const replaced = await h.media.uploadBatches.update(
      h.actor,
      batch.items[0]!.uploadBatchItemId,
      {
        replacementFile: batchDraft("重传第1集.mp4"),
      },
    );
    const completed = await h.prisma.fileObject.findUniqueOrThrow({
      where: { id: batch.items[2]!.fileId },
    });
    h.fake.storage.put({ bucket: "media", key: completed.incomingKey! }, MP4_HEADER, "video/mp4");
    await h.media.uploadBatches.complete(h.actor, batch.items[2]!.uploadBatchItemId, {});
    const credentials = await h.media.uploadBatches.refreshCredentials(
      h.actor,
      batch.uploadBatchId,
      {},
    );
    if (credentials.mode !== "post") throw new Error("expected POST credentials");
    expect(credentials.posts.map((post) => post.fileId)).toEqual([
      replaced.items.find((item) => item.state === "pending" && item.episodeNo === 1)!.fileId,
    ]);
    expect(h.fake.storage.callsOf("presignPost")).toHaveLength(1);
  });

  it("非本人、未开始、伪造凭据参数和过期批次在外呼前拒绝", async () => {
    const h = await setup(),
      batch = await h.create();
    await expect(
      h.media.uploadBatches.refreshCredentials(h.actor, batch.uploadBatchId, {}),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await h.media.uploadBatches.start(h.actor, batch.uploadBatchId, {});
    const id = uuidv7(),
      other = {
        ...h.actor,
        identity: createIdentityContext({ actor: { type: "staff", id, client: "admin" } }),
        staff: { ...h.actor.staff!, staff: { ...h.actor.staff!.staff, id } },
      };
    await expect(
      h.media.uploadBatches.refreshCredentials(other, batch.uploadBatchId, {}),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    await expect(
      h.media.uploadBatches.refreshCredentials(h.actor, batch.uploadBatchId, {
        key: "incoming/forged",
      }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    h.clock.advance(73 * 60 * 60_000);
    await expect(
      h.media.uploadBatches.refreshCredentials(h.actor, batch.uploadBatchId, {}),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(h.fake.storage.callsOf("presignPost")).toHaveLength(0);
  });

  it("签发中被正式替换的文件不返回旧策略", async () => {
    const h = await setup(),
      batch = await uploading(h),
      item = batch.items[0]!,
      original = h.fake.storage.presignPost.bind(h.fake.storage);
    const sign = vi.spyOn(h.fake.storage, "presignPost").mockImplementationOnce(async (input) => {
      const result = await original(input);
      await h.media.uploadBatches.update(h.actor, item.uploadBatchItemId, {
        replacementFile: batchDraft("新第1集.mp4"),
      });
      return result;
    });
    try {
      await expect(
        h.media.uploadBatches.refreshCredentials(h.actor, batch.uploadBatchId, {}),
      ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
      expect(
        (await h.prisma.fileObject.findUniqueOrThrow({ where: { id: item.fileId } })).status,
      ).toBe("expired");
    } finally {
      sign.mockRestore();
    }
  });

  it("签发中目标归档后重新鉴权，不返回已签策略", async () => {
    const h = await setup(),
      batch = await uploading(h),
      original = h.fake.storage.presignPost.bind(h.fake.storage);
    const sign = vi.spyOn(h.fake.storage, "presignPost").mockImplementationOnce(async (input) => {
      const result = await original(input);
      const now = h.clock.now();
      await h.prisma.drama.update({
        where: { id: h.drama.id },
        data: {
          status: "delisted",
          delistedAt: now,
          delistReasonCode: "ops_strategy",
          archivedAt: now,
          statusChangedAt: now,
          updatedAt: now,
        },
      });
      return result;
    });
    try {
      await expect(
        h.media.uploadBatches.refreshCredentials(h.actor, batch.uploadBatchId, {}),
      ).rejects.toMatchObject({ error: "DRAMA_ARCHIVED" });
    } finally {
      sign.mockRestore();
    }
  });

  it("签发中对象已沿正式入口完成确认，不返回仍可覆盖该对象的策略", async () => {
    const h = await setup(),
      batch = await uploading(h),
      item = batch.items[0]!,
      original = h.fake.storage.presignPost.bind(h.fake.storage);
    const sign = vi.spyOn(h.fake.storage, "presignPost").mockImplementationOnce(async (input) => {
      const result = await original(input);
      h.fake.storage.put({ bucket: input.bucket, key: input.key }, MP4_HEADER, input.mime);
      await h.media.uploadBatches.complete(h.actor, item.uploadBatchItemId, {});
      return result;
    });
    try {
      await expect(
        h.media.uploadBatches.refreshCredentials(h.actor, batch.uploadBatchId, {}),
      ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
      expect(
        (await h.prisma.fileObject.findUniqueOrThrow({ where: { id: item.fileId } })).status,
      ).toBe("promoting");
    } finally {
      sign.mockRestore();
    }
  });

  it("签名已过期或提供方失败都不返回凭据，也不降级为STS", async () => {
    const h = await setup(),
      batch = await uploading(h),
      original = h.fake.storage.presignPost.bind(h.fake.storage);
    h.fake.storage.failNext("presignPost", { reason: "unavailable" });
    await expect(
      h.media.uploadBatches.refreshCredentials(h.actor, batch.uploadBatchId, {}),
    ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    const sign = vi.spyOn(h.fake.storage, "presignPost").mockImplementationOnce(async (input) => {
      const result = await original(input);
      h.clock.advance(600_000);
      return result;
    });
    try {
      await expect(
        h.media.uploadBatches.refreshCredentials(h.actor, batch.uploadBatchId, {}),
      ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
      expect(h.fake.storage.callsOf("issueSts")).toHaveLength(0);
    } finally {
      sign.mockRestore();
    }
  });

  it("非local且无STS能力时拒绝POST，不能把生产配置错误伪装为本地", async () => {
    const h = await setup(false),
      batch = await uploading(h);
    await expect(
      h.media.uploadBatches.refreshCredentials(h.actor, batch.uploadBatchId, {}),
    ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    expect(h.fake.storage.callsOf("presignPost")).toHaveLength(0);
    expect(h.fake.storage.callsOf("issueSts")).toHaveLength(0);
  });

  it("原COS能力仍登记multipart并签发30分钟STS，保留原分块参数", async () => {
    const h = await batchHarness(await db.prisma()),
      batch = await uploading(h);
    expect(
      (await h.prisma.fileObject.findUniqueOrThrow({ where: { id: batch.items[0]!.fileId } }))
        .uploadMode,
    ).toBe("multipart");
    const credentials = await h.media.uploadBatches.refreshCredentials(
      h.actor,
      batch.uploadBatchId,
      {},
    );
    expect(credentials).toMatchObject({
      sts: { expiredTime: new Date(h.clock.now().getTime() + 1_800_000).toISOString() },
      chunkSize: 8 * 1024 * 1024,
      fileParallel: 3,
      chunkParallel: 4,
    });
    expect(h.fake.storage.callsOf("presignPost")).toHaveLength(0);
    expect(h.fake.storage.callsOf("issueSts")).toHaveLength(1);
  });
});
