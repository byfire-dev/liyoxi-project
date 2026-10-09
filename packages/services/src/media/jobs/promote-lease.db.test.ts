import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEvents } from "../../events/index.js";
import { createIdentityContext, createTxRunner, uuidv7 } from "../../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  useSeededDatabase,
} from "../../testing/index.js";
import { createMedia } from "../index.js";
import type { MediaActor } from "../index.js";

const db = useSeededDatabase("services");
const clock = createClock();
const fake = createFakeProviders({ clock });
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let media: ReturnType<typeof createMedia>;
let secondWorker: ReturnType<typeof createMedia>;
let actor: MediaActor;
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

beforeAll(async () => {
  prisma = await db.prisma();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const assembly = assembleForTest({ entry: "worker" });
  const make = createFactories({ db: prisma, clock });
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
  const options = {
    tx,
    clock,
    assembly,
    events: createEvents({ assembly, clock, tx }),
    storage: fake.storage,
    pollMs: 0,
  };
  media = createMedia(options);
  secondWorker = createMedia(options);
});
afterAll(async () => {
  await Promise.all([media.jobs.shutdown(), secondWorker.jobs.shutdown()]);
});

async function pending() {
  const file = (
    await media.register(actor, {
      category: "profile_image",
      files: [{ fileName: "lease.png", sizeBytes: String(bytes.length), clientToken: uuidv7() }],
    })
  ).items[0]!;
  fake.storage.put({ bucket: "asset", key: file.key }, bytes, "image/png");
  await media.complete(actor, file.fileId);
  const job = await prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.fileId}` },
  });
  return { file, job };
}

describe("W3-03 promote 正式租约", () => {
  it("真实 claim 的五分钟租约覆盖四分钟硬超时", async () => {
    const { job } = await pending();
    fake.storage.delayNext("copy", 1000);
    const call = media.promote({ jobId: job.id });
    try {
      await vi.waitFor(() => expect(fake.storage.pendingCalls()).toBe(1));
      const claimed = await prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(claimed.state).toBe("running");
      expect(claimed.attemptNo).toBe(1);
      expect(claimed.nextRunAt.getTime() - clock.now().getTime()).toBe(5 * 60_000);
    } finally {
      clock.advance(1000);
      fake.storage.tick();
      await call;
    }
    expect(fake.storage.pendingCalls()).toBe(0);
  });

  it("31秒后第二个worker不能重领仍在正常执行的任务", async () => {
    const { job, file } = await pending();
    const before = fake.storage.callsOf("copy").length;
    fake.storage.delayNext("copy", 90_000);
    const first = media.promote({ jobId: job.id });
    try {
      await vi.waitFor(() => expect(fake.storage.pendingCalls()).toBe(1));
      clock.advance(31_000);
      await secondWorker.promote({ jobId: job.id });
      const current = await prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(current).toMatchObject({ state: "running", attemptNo: 1 });
      expect(fake.storage.callsOf("copy").length - before).toBe(1);
    } finally {
      clock.advance(59_000);
      fake.storage.tick();
      await first;
    }
    expect(fake.storage.pendingCalls()).toBe(0);
    expect(await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } })).toMatchObject(
      {
        status: "stored",
      },
    );
  });
});
