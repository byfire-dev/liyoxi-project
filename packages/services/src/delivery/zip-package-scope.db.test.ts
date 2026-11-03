import { createPrismaClient } from "@liyoxi/db";
import type { Prisma } from "@liyoxi/db";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createZipPackageFixture, useSeededDatabase } from "../testing/index.js";
import { createTxRunner } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { assignPublisher } from "./publisher-assignment.js";
import { createDeliveryZipPackages } from "./zip-package.js";

const db = useSeededDatabase("services");
let h: ReturnType<typeof createZipPackageFixture>;
let f: Awaited<ReturnType<ReturnType<typeof h.releaseSteps>["push"]>>;
let steps: ReturnType<typeof h.releaseSteps>;
let first: Awaited<ReturnType<typeof h.staff>>;
let next: Awaited<ReturnType<typeof h.staff>>;
const title = "城市/夜色:故事\\终章?";
beforeAll(async () => {
  h = createZipPackageFixture(await db.prisma());
  steps = h.releaseSteps();
});
beforeAll(async () => {
  // Supply a legal title when the historical order input is inserted. Its immutable
  // snapshot then flows unchanged through the actual production/QC/push writers.
  const original = h.make.orderItem;
  const make = vi.spyOn(h.make, "orderItem").mockImplementation((input) =>
    original({
      ...input,
      dramaSnapshot: { ...(input?.dramaSnapshot as Prisma.InputJsonObject), title },
    }),
  );
  try {
    await steps.prepare();
  } finally {
    make.mockRestore();
  }
});
beforeAll(() => steps.sampleFile());
beforeAll(() => steps.confirmSample());
beforeAll(() => steps.finalEpisode(2));
beforeAll(async () => {
  f = await steps.push();
});
beforeAll(async () => {
  first = await h.staff("publisher");
  next = await h.staff("publisher");
  await h.tx.run((tx) =>
    assignPublisher(tx, {
      ticketId: f.id,
      publisherId: first.row.id,
      staff: f.qc.staff,
      ctx: f.qc.ctx,
      now: h.clock.now(),
    }),
  );
});
afterAll(() => h?.close());

const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};
const facts = async () => ({
  bundle: await h.prisma.zipBundle.findUniqueOrThrow({
    where: {
      ownerType_ownerId: { ownerType: "delivery_release", ownerId: f.release.deliveryReleaseId },
    },
  }),
  jobs: await h.prisma.mediaJob.findMany({
    where: { kind: "zip_package" },
    orderBy: { id: "asc" },
  }),
  refs: await h.prisma.fileRef.findMany({
    where: { refType: "zip_bundle" },
    orderBy: { id: "asc" },
  }),
  audits: await h.prisma.auditLog.count({ where: { targetId: f.release.deliveryReleaseId } }),
});

it("合法特殊字符剧名的真实推送保留manifest，完整ZIP使用安全且不重名的成员", async () => {
  const release = await h.prisma.deliveryRelease.findUniqueOrThrow({
    where: { id: f.release.deliveryReleaseId },
  });
  expect(release.state).toBe("pushed");
  expect(release.manifestSnapshot).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ episodeNo: 1, name: `${title}_第01集.mp4` }),
      expect.objectContaining({ episodeNo: 2, name: `${title}_第02集.mp4` }),
    ]),
  );
  const input = await h.input(release.id);
  expect(input.items).toHaveLength(2);
  expect(new Set(input.items.map((entry) => entry.name)).size).toBe(2);
  for (const entry of input.items) expect(entry.name).not.toMatch(/[\\/:*?"<>|]/u);
  const before = await facts();
  const job = before.jobs[0]!;
  await h.zipMedia.jobs.run({ jobId: job.id });
  const submitted = await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
  expect(submitted.state).toBe("submitted");
  h.clock.set(submitted.nextRunAt);
  await h.zipMedia.jobs.run({ jobId: job.id });
  expect((await facts()).bundle.zipState).toBe("ready");
  expect(
    (await h.prisma.deliveryRelease.findUniqueOrThrow({ where: { id: release.id } }))
      .manifestSnapshot,
  ).toEqual(release.manifestSnapshot);
});

it("真实两连接等锁时改派先提交，旧发布员pack返回404且缓存任务引用审计零写", async () => {
  const before = await facts();
  const connectionString = await db.url();
  const writerClient = createPrismaClient({ connectionString, max: 1 });
  const readerClient = createPrismaClient({ connectionString, max: 1 });
  const writer = createTxRunner({ prisma: writerClient, appEnv: "test" });
  const reader = createTxRunner({ prisma: readerClient, appEnv: "test" });
  const applied = gate(),
    releaseWriter = gate(),
    readerEntered = gate();
  let writerPid = 0,
    readerPid = 0;
  const writing = writer.run(async (tx) => {
    writerPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0]!
      .pid;
    await assignPublisher(tx, {
      ticketId: f.id,
      publisherId: next.row.id,
      staff: f.qc.staff,
      ctx: f.qc.ctx,
      now: h.clock.now(),
    });
    applied.open();
    await releaseWriter.wait;
  });
  const writerSettled = Promise.allSettled([writing]);
  let readSettled = Promise.resolve<PromiseSettledResult<unknown>[]>([]);
  try {
    await Promise.race([
      applied.wait,
      writing.then(() => {
        throw new Error("改派未经过真实锁屏障");
      }),
    ]);
    const readTx: TxRunner = {
      run: (fn, options) =>
        reader.run(async (tx) => {
          readerPid = (
            await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`
          )[0]!.pid;
          readerEntered.open();
          return fn(tx);
        }, options),
    };
    const reading = createDeliveryZipPackages({ ...h.deps, media: h.zipMedia, tx: readTx }).pack(
      first.ctx,
      first.staff,
      f.release.deliveryReleaseId,
    );
    readSettled = Promise.allSettled([reading]);
    await readerEntered.wait;
    expect(readerPid).not.toBe(writerPid);
    await expect
      .poll(async () => {
        const [row] = await h.prisma.$queryRaw<{ waiting: boolean }[]>`
        SELECT ${writerPid}::int=ANY(pg_blocking_pids(${readerPid}::int)) AS waiting`;
        return row?.waiting;
      })
      .toBe(true);
    releaseWriter.open();
    await writing;
    await expect(reading).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(await facts()).toEqual(before);
  } finally {
    releaseWriter.open();
    await writerSettled;
    await readSettled;
    await Promise.all([writerClient.$disconnect(), readerClient.$disconnect()]);
  }
});
