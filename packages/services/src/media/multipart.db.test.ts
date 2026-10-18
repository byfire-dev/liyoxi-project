import { beforeAll, describe, expect, it, vi } from "vitest";
import { createEvents } from "../events/index.js";
import { createIdentityContext, createTxRunner, uuidv7 } from "../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  useSeededDatabase,
} from "../testing/index.js";
import { createMedia } from "./index.js";
import type { MediaActor } from "./index.js";

const db = useSeededDatabase("services");
const clock = createClock();
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let media: ReturnType<typeof createMedia>;
let fake: ReturnType<typeof createFakeProviders>;
let actor: MediaActor;
let other: MediaActor;
const registration = (token = uuidv7()) =>
  media.register(actor, {
    category: "profile_video",
    files: [{ fileName: "clip.mp4", sizeBytes: String(40 * 1024 * 1024), clientToken: token }],
  });

beforeAll(async () => {
  prisma = await db.prisma();
  const make = createFactories({ db: prisma, clock });
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const assembly = assembleForTest({ entry: "worker" });
  fake = createFakeProviders({ clock });
  media = createMedia({
    tx,
    clock,
    assembly,
    events: createEvents({ assembly, clock, tx }),
    storage: fake.storage,
    pollMs: 0,
  });
  const user = await make.merchantUser();
  const entity = await make.entity({ createdByUserId: user.id });
  const store = await make.store({ entityId: entity.id });
  actor = {
    identity: createIdentityContext({
      actor: { type: "merchant", id: user.id, client: "weapp", role: "owner" },
      entityId: entity.id,
      storeId: store.id,
    }),
    merchant: { standing: "owner", entityId: entity.id, storeId: store.id },
  };
  const otherUser = await make.merchantUser();
  other = {
    ...actor,
    identity: createIdentityContext({
      actor: { type: "merchant", id: otherUser.id, client: "weapp", role: "owner" },
      entityId: entity.id,
      storeId: store.id,
    }),
  };
});

describe("W3-01 分块短凭据", () => {
  it("首次30分钟STS与8MB/块4，自然重用保留唯一key并消费真实预算", async () => {
    const token = uuidv7();
    const first = (await registration(token)).items[0]!;
    expect(first).toMatchObject({
      mode: "multipart",
      post: null,
      chunkSize: 8 * 1024 * 1024,
      chunkParallel: 4,
      credentialsLeft: 29,
    });
    expect(first.sts).toMatchObject({ startTime: clock.now().toISOString() });
    const second = (await registration(token)).items[0]!;
    expect(second.fileId).toBe(first.fileId);
    expect(second.key).toBe(first.key);
    expect(second.credentialsLeft).toBe(28);
    expect(
      (await prisma.fileObject.findUniqueOrThrow({ where: { id: first.fileId } })).stsIssued,
    ).toBe(2);
  });

  it("两个真实并行续签竞争最后额度，仅一条返回凭据/发起STS", async () => {
    const file = (await registration()).items[0]!;
    await prisma.fileObject.update({ where: { id: file.fileId }, data: { stsIssued: 29 } });
    const before = fake.storage.callsOf("issueSts").length;
    const results = await Promise.allSettled([
      media.refresh(actor, file.fileId),
      media.refresh(actor, file.fileId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { error: "UPLOAD_CREDENTIAL_LIMIT" },
    });
    expect(fake.storage.callsOf("issueSts").length - before).toBe(1);
    expect(
      (await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } })).stsIssued,
    ).toBe(30);
  });

  it("确定拒绝退还预扣，未知结果保留；不写原始凭据", async () => {
    const file = (await registration()).items[0]!;
    fake.storage.failNext("issueSts", { reason: "rejected" });
    await expect(media.refresh(actor, file.fileId)).rejects.toMatchObject({
      error: "PROVIDER_UNAVAILABLE",
    });
    expect(
      (await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } })).stsIssued,
    ).toBe(1);
    fake.storage.failNext("issueSts", { reason: "unavailable" });
    await expect(media.refresh(actor, file.fileId)).rejects.toMatchObject({
      error: "PROVIDER_UNAVAILABLE",
    });
    expect(
      (await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } })).stsIssued,
    ).toBe(2);
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });

  it("非本人、确认中、过期在外呼前拒绝", async () => {
    const file = (await registration()).items[0]!;
    const before = fake.storage.callsOf("issueSts").length;
    await expect(media.refresh(other, file.fileId)).rejects.toMatchObject({ error: "NOT_FOUND" });
    await prisma.fileObject.update({
      where: { id: file.fileId },
      data: { confirmingUntil: new Date(clock.now().getTime() + 30_000) },
    });
    await expect(media.refresh(actor, file.fileId)).rejects.toMatchObject({
      error: "CONFIRM_IN_PROGRESS",
    });
    await prisma.fileObject.update({
      where: { id: file.fileId },
      data: { confirmingUntil: null, uploadExpiresAt: clock.now() },
    });
    await expect(media.refresh(actor, file.fileId)).rejects.toMatchObject({
      error: "UPLOAD_EXPIRED",
    });
    expect(fake.storage.callsOf("issueSts")).toHaveLength(before);
  });

  it("已发STS后取消不返回凭据，中止只本file且没有取消事件", async () => {
    const file = (await registration()).items[0]!;
    fake.storage.delayNext("issueSts", 100);
    const refresh = media.refresh(actor, file.fileId);
    for (let i = 0; i < 100 && fake.storage.pendingCalls() === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.storage.pendingCalls()).toBe(1);
    await media.cancel(actor, file.fileId);
    clock.advance(100);
    fake.storage.tick();
    await expect(refresh).rejects.toMatchObject({ error: "UPLOAD_EXPIRED" });
    expect(fake.storage.callsOf("abortMultipart").at(-1)?.input).toMatchObject({
      bucket: "asset",
      key: file.key,
    });
    expect(
      (await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } })).stsIssued,
    ).toBe(2);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: file.fileId } })).toBe(0);
  });

  it("HEAD服务端CRC保存并参与正式区复制核对，不采客户端成功声明", async () => {
    const original = fake.storage.head.bind(fake.storage);
    let mismatch = true;
    const head = vi.spyOn(fake.storage, "head").mockImplementation(async (input) => {
      const result = await original(input);
      return result.ok && result.value.exists
        ? {
            ...result,
            value: {
              ...result.value,
              crc64: input.key.startsWith("incoming/") || !mismatch ? "123456" : "654321",
            },
          }
        : result;
    });
    try {
      for (const different of [true, false]) {
        mismatch = different;
        const file = (
          await media.register(actor, {
            category: "profile_image",
            files: [{ fileName: "a.png", sizeBytes: "8", clientToken: uuidv7() }],
          })
        ).items[0]!;
        fake.storage.put(
          { bucket: "asset", key: file.key },
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          "image/png",
        );
        await media.complete(actor, file.fileId);
        const job = await prisma.mediaJob.findUniqueOrThrow({
          where: { dedupeKey: `promote:${file.fileId}` },
        });
        await media.promote({ jobId: job.id });
        const row = await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } });
        expect(row.incomingCrc64).toBe("123456");
        expect(row.status).toBe(different ? "rejected" : "stored");
        expect(row.crc64).toBe(different ? null : "123456");
        if (different) expect(row.rejectReason).toBe("copy_verify_failed");
      }
    } finally {
      head.mockRestore();
    }
  });
  it("无STS只保留原post，不假造分块能力", async () => {
    fake.storage.capabilities.sts = false;
    const file = (await registration()).items[0]!;
    expect(file).toMatchObject({ mode: "post", sts: null, chunkSize: null, chunkParallel: null });
    fake.storage.capabilities.sts = true;
  });
});
