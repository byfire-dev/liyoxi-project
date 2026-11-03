import { createPrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installZipPackageFixture, useSeededDatabase } from "../testing/index.js";
import { createMedia } from "../media/index.js";
import { readReleaseZipInput } from "./zip-package.js";
import { createIdempotencyContext, createTxRunner, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { createPublishLists } from "./publish-list-service.js";
import { prefillPublishList } from "./publish-list.js";
import { ticketOf } from "./repo.js";
import { findDeliveryViolations } from "./invariants.js";
import { m5Harness, released } from "./__fixtures__/m5.js";
import type { M5Harness } from "./__fixtures__/m5.js";

const db = useSeededDatabase("services", { max: 2 });
let h: M5Harness;
let pushed: Awaited<ReturnType<typeof released>>;
let protocol: ReturnType<typeof installZipPackageFixture>;
let zipMedia: ReturnType<typeof createMedia>;
beforeAll(async () => {
  h = m5Harness(await db.prisma());
  protocol = installZipPackageFixture(h.fake);
  zipMedia = createMedia({
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    events: h.events,
    storage: protocol.storage,
    zipProvider: h.fake.media,
  });
  h.media.ensureZip = zipMedia.ensureZip;
  pushed = await released(h);
}, 120_000);
afterAll(async () => {
  await zipMedia?.jobs.shutdown();
  protocol?.close();
  await h?.close();
});
const service = () => createPublishLists(h.deps);
const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
};
type ReadPort = "admin" | "merchant" | "portal";
const readPushed = (lists: ReturnType<typeof service>, port: ReadPort) =>
  port === "admin"
    ? lists.get(pushed.qc.staff, pushed.id)
    : port === "merchant"
      ? lists.merchantGet(pushed.o.viewer, pushed.item.id)
      : lists.portalGet(
          { entityId: pushed.o.entity.id, storeId: pushed.o.store.id },
          pushed.item.id,
        );
const contentOf = (view: Awaited<ReturnType<typeof readPushed>>) => ({
  ...view,
  cover: view.cover ? { fileId: view.cover.fileId } : null,
});
async function editing(episodeCount = 3) {
  const poster = await h.make.fileObject();
  const o = await h.order(true, 1, poster.id, episodeCount),
    a = await h.staff();
  const t = await h.prisma.deliveryTicket.findUniqueOrThrow({
    where: { orderItemId: o.items[0]!.id },
  });
  // Historical delivering input isolates content editing; the pushed fixture above exercises the real producer.
  await h.prisma.deliveryTicket.update({ where: { id: t.id }, data: { step: "delivering" } });
  await h.tx.run(async (tx) => prefillPublishList(tx, h.deps, await ticketOf(tx, t.id)));
  const input = {
    lockVersion: 0,
    collectionName: "发布合集",
    coverFileId: poster.id,
    titleTemplate: "{剧名} 第{集数}集 {看点}",
    topics: ["#悬疑"],
    intro: "发布简介",
    episodes: [],
  };
  return { o, a, t, input };
}
const snapshot = async (id: string) => ({
  list: await h.prisma.publishList.findUnique({ where: { deliveryTicketId: id } }),
  rows: await h.prisma.publishListEpisode.findMany({
    where: { deliveryTicketId: id },
    orderBy: { episodeNo: "asc" },
  }),
  events: await h.prisma.outboxEvent.count({
    where: {
      eventType: "publish_list.updated",
      payload: { path: ["deliveryTicketId"], equals: id },
    },
  }),
});

describe("M6发布清单真实内容事务", () => {
  it.each(
    (["admin", "merchant", "portal"] as const).flatMap((port) =>
      (["replace", "import"] as const).map((write) => ({ port, write })),
    ),
  )("$port 读写并发 $write 保持清单头、逐集行和发布文本同版本", async ({ port, write }) => {
    const current = await service().get(pushed.qc.staff, pushed.id);
    const body = {
      lockVersion: current.lockVersion,
      collectionName: "并发读取合集",
      coverFileId: current.cover?.fileId ?? null,
      titleTemplate: current.titleTemplate,
      topics: ["并发读取"],
      intro: "旧版合集简介",
      episodes: [
        { episodeNo: 1, title: "旧版标题", highlight: null, topics: null, intro: "旧版逐集简介" },
      ],
    };
    const baseline = await service().replace(pushed.qc.ctx, pushed.qc.staff, pushed.id, body);
    const before = contentOf(await readPushed(service(), port));
    const connectionString = await db.url(),
      readerClient = createPrismaClient({ connectionString, max: 1 }),
      writerClient = createPrismaClient({ connectionString, max: 1 }),
      reader = createTxRunner({ prisma: readerClient, appEnv: "test" }),
      writer = createTxRunner({ prisma: writerClient, appEnv: "test" }),
      paused = gate(),
      resume = gate(),
      writerEntered = gate();
    let readerPid = 0,
      writerPid = 0;
    const readerTx: TxRunner = {
      run: (fn, options) =>
        reader.run(async (tx) => {
          readerPid = (
            await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`
          )[0]!.pid;
          const pause = async <T>(result: T) => {
            paused.open();
            await resume.wait;
            return result;
          };
          // Keep Prisma's relation methods and the original Tx identity; only delay consumption.
          const pauseQuery = <T extends PromiseLike<unknown>>(query: T): T =>
            new Proxy(query, {
              get(target, key) {
                if (key === "then")
                  return (
                    resolve?: (value: Awaited<T>) => unknown,
                    reject?: (error: unknown) => unknown,
                  ) => Promise.resolve(target).then(pause).then(resolve, reject);
                return Reflect.get(target, key, target);
              },
            });
          const header = tx.publishList.findUnique,
            release = tx.deliveryRelease.findFirst;
          // Pause at the former mixed-version boundary, after the real SQL has read its value.
          const spy =
            port === "admin"
              ? vi
                  .spyOn(tx.publishList, "findUnique")
                  .mockImplementationOnce((args) => pauseQuery(header(args)))
              : vi
                  .spyOn(tx.deliveryRelease, "findFirst")
                  .mockImplementationOnce((args) => pauseQuery(release(args)));
          try {
            return await fn(tx);
          } finally {
            spy.mockRestore();
          }
        }, options),
    };
    const writerTx: TxRunner = {
      run: (fn, options) =>
        writer.run(async (tx) => {
          writerPid = (
            await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`
          )[0]!.pid;
          writerEntered.open();
          return fn(tx);
        }, options),
    };
    const reading = readPushed(createPublishLists({ ...h.deps, tx: readerTx }), port);
    const readSettled = Promise.allSettled([reading]);
    try {
      await Promise.race([
        paused.wait,
        reading.then(() => {
          throw new Error("清单读取未经过受控查询屏障");
        }),
      ]);
      const lists = createPublishLists({ ...h.deps, tx: writerTx });
      const writing =
        write === "replace"
          ? lists.replace(pushed.qc.ctx, pushed.qc.staff, pushed.id, {
              ...body,
              lockVersion: baseline.lockVersion,
              intro: "新版合集简介",
              episodes: [
                {
                  episodeNo: 1,
                  title: "新版标题",
                  highlight: null,
                  topics: null,
                  intro: "新版逐集简介",
                },
              ],
            })
          : lists.import(pushed.qc.ctx, pushed.qc.staff, pushed.id, {
              lockVersion: baseline.lockVersion,
              format: "csv",
              content: "集号,标题,简介\n1,新版标题,新版逐集简介",
            });
      const writeSettled = Promise.allSettled([writing]);
      try {
        await writerEntered.wait;
        expect(readerPid).not.toBe(writerPid);
        // Observe the actual lock dependency, never infer a race from elapsed time.
        await expect
          .poll(async () => {
            const [row] = await h.prisma.$queryRaw<
              { waiting: boolean }[]
            >`SELECT ${readerPid}::int=ANY(pg_blocking_pids(${writerPid}::int)) AS waiting`;
            return row?.waiting;
          })
          .toBe(true);
        resume.open();
        expect(contentOf(await reading)).toEqual(before);
        await writing;
        const after = await snapshot(pushed.id);
        const fresh = await readPushed(service(), port);
        expect(fresh.episodes[0]).toMatchObject({ title: "新版标题", intro: "新版逐集简介" });
        expect(fresh.intro).toBe(write === "replace" ? "新版合集简介" : "旧版合集简介");
        if ("lockVersion" in fresh) expect(fresh.lockVersion).toBe(baseline.lockVersion + 1);
        else {
          expect(fresh.text).toContain("新版标题");
          expect(fresh.text).toContain("新版逐集简介");
          expect(fresh.text).not.toContain("旧版标题");
        }
        expect(await snapshot(pushed.id)).toEqual(after);
      } finally {
        resume.open();
        await writeSettled;
      }
    } finally {
      resume.open();
      await readSettled;
      await Promise.all([readerClient.$disconnect(), writerClient.$disconnect()]);
    }
  });

  it("预填N行且重进保留已保存内容；未进入交付的GET零写404", async () => {
    const f = await editing();
    expect((await snapshot(f.t.id)).rows).toHaveLength(3);
    await service().replace(f.a.ctx, f.a.staff, f.t.id, f.input);
    const before = await snapshot(f.t.id);
    await h.tx.run(async (tx) => prefillPublishList(tx, h.deps, await ticketOf(tx, f.t.id)));
    expect(await snapshot(f.t.id)).toEqual(before);
    const early = await h.order(true),
      t = await h.prisma.deliveryTicket.findUniqueOrThrow({
        where: { orderItemId: early.items[0]!.id },
      });
    await expect(service().get(f.a.staff, t.id)).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(await h.prisma.publishList.count({ where: { deliveryTicketId: t.id } })).toBe(0);
  });
  it("并行保存只有一个版本胜出；同键重放不重复事件且脱敏封面", async () => {
    const f = await editing();
    const calls = await Promise.allSettled(
      ["甲", "乙"].map((intro) =>
        service().replace(f.a.ctx, f.a.staff, f.t.id, { ...f.input, intro }),
      ),
    );
    expect(calls.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(calls.find((r) => r.status === "rejected")).toMatchObject({
      reason: { error: "VERSION_CONFLICT", details: { lockVersion: 1 } },
    });
    expect((await snapshot(f.t.id)).events).toBe(1);
    const key = uuidv7(),
      body = { ...f.input, lockVersion: 1 };
    const context = () =>
      createIdempotencyContext({
        mode: "required",
        scope: "admin.deliveryTicket.publishList.replace",
        actor: f.a.ctx.actor,
        key,
        request: { method: "PUT", body },
        redact: ["cover.url", "cover.expiresAt"],
      });
    await service().replace(f.a.ctx, f.a.staff, f.t.id, body, { idem: context() });
    const idem = context(),
      replay = await service().replace(f.a.ctx, f.a.staff, f.t.id, body, { idem });
    expect(replay.replayed).toBe(true);
    expect(replay.cover).toMatchObject({ url: null, expiresAt: null });
    expect((await snapshot(f.t.id)).events).toBe(2);
  });
  it("整表导入行错零写；只更新出现列与集号，遗漏覆盖保留", async () => {
    const f = await editing();
    const before = await snapshot(f.t.id);
    await expect(
      service().import(f.a.ctx, f.a.staff, f.t.id, {
        lockVersion: 0,
        format: "csv",
        content: "集号,标题\n1,正确\n4,越界",
      }),
    ).rejects.toMatchObject({ error: "PUBLISH_LIST_IMPORT_INVALID" });
    expect(await snapshot(f.t.id)).toEqual(before);
    const saved = await service().replace(f.a.ctx, f.a.staff, f.t.id, {
      ...f.input,
      episodes: [
        { episodeNo: 1, title: "保留标题", highlight: "看点", topics: ["追剧"], intro: "逐集简介" },
        { episodeNo: 2, title: "第二集", highlight: null, topics: null, intro: null },
      ],
    });
    const imported = await service().import(f.a.ctx, f.a.staff, f.t.id, {
      lockVersion: saved.lockVersion,
      format: "tsv",
      content: "集号\t看点\n1\t",
    });
    expect(imported.updatedEpisodeNos).toEqual([1]);
    expect(imported.publishList.episodes[0]).toMatchObject({
      title: "保留标题",
      highlight: null,
      topics: ["追剧"],
      intro: "逐集简介",
    });
    expect(imported.publishList.episodes[1]?.title).toBe("第二集");
    const replaced = await service().replace(f.a.ctx, f.a.staff, f.t.id, {
      ...f.input,
      lockVersion: imported.publishList.lockVersion,
    });
    expect(replaced.episodes.every((r) => r.title === null && r.highlight === null)).toBe(true);
  });
  it("整部集数越界与错误封面拒绝，内容事务全部回滚", async () => {
    const f = await editing(),
      before = await snapshot(f.t.id);
    await expect(
      service().replace(f.a.ctx, f.a.staff, f.t.id, {
        ...f.input,
        episodes: [{ episodeNo: 4, title: null, highlight: null, topics: null, intro: null }],
      }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    const wrong = await h.make.fileObject({ category: "evidence" });
    await expect(
      service().replace(f.a.ctx, f.a.staff, f.t.id, { ...f.input, coverFileId: wrong.id }),
    ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
    expect(await snapshot(f.t.id)).toEqual(before);
  });
  it("真实推包后修订更新text并只失效ZIP，现行视频引用与下载授权保留", async () => {
    const view = await service().get(pushed.qc.staff, pushed.id);
    const refs = await h.prisma.fileRef.findMany({
      where: { refType: "delivery_release", refId: pushed.release.deliveryReleaseId },
    });
    expect(refs.length).toBeGreaterThan(0);
    // Use the actual cache producer: release push now owns prequeueing its bundle.
    let zip = await h.tx.run(async (tx) =>
      zipMedia.ensureZip(
        tx,
        await readReleaseZipInput(tx, zipMedia, pushed.release.deliveryReleaseId, h.clock.now()),
      ),
    );
    const job = await h.prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `zip:${zip.zipBundleId}:${zip.zipGen}` },
    });
    await zipMedia.jobs.run({ jobId: job.id });
    const submitted = await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(submitted.state).toBe("submitted");
    h.clock.set(submitted.nextRunAt);
    await zipMedia.jobs.run({ jobId: job.id });
    zip = await h.tx.run(async (tx) =>
      zipMedia.ensureZip(
        tx,
        await readReleaseZipInput(tx, zipMedia, pushed.release.deliveryReleaseId, h.clock.now()),
        { peek: true },
      ),
    );
    expect(zip.zipState).toBe("ready");
    const grants = await h.prisma.downloadGrant.findMany({
      where: { orderItemId: pushed.item.id },
    });
    const saved = await service().replace(pushed.qc.ctx, pushed.qc.staff, pushed.id, {
      lockVersion: view.lockVersion,
      collectionName: view.collectionName,
      coverFileId: view.cover?.fileId ?? null,
      titleTemplate: view.titleTemplate,
      topics: view.topics,
      intro: "修订后的真实发布简介",
      episodes: [],
    });
    expect(saved.lockVersion).toBe(view.lockVersion + 1);
    expect(await h.prisma.zipBundle.findUnique({ where: { id: zip.zipBundleId! } })).toMatchObject({
      zipState: "none",
      zipGen: zip.zipGen! + 1,
      zipFileId: null,
    });
    expect(
      await h.prisma.fileRef.findMany({
        where: { refType: "delivery_release", refId: pushed.release.deliveryReleaseId },
      }),
    ).toEqual(refs);
    expect(
      await h.prisma.downloadGrant.findMany({ where: { orderItemId: pushed.item.id } }),
    ).toEqual(grants);
    const merchant = await service().merchantGet(pushed.o.viewer, pushed.item.id);
    expect(merchant.text).toContain("修订后的真实发布简介");
    expect(
      await service().portalGet(
        { entityId: pushed.o.entity.id, storeId: pushed.o.store.id },
        pushed.item.id,
      ),
    ).toMatchObject({ text: merchant.text });
    await expect(
      service().portalGet({ entityId: pushed.o.entity.id, storeId: uuidv7() }, pushed.item.id),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
  });
  it("暂停与首次回填永久锁定；已有changedInReleaseNo不被清空", async () => {
    const f = await editing();
    await h.prisma.publishListEpisode.update({
      where: { deliveryTicketId_episodeNo: { deliveryTicketId: f.t.id, episodeNo: 1 } },
      data: { changedInReleaseNo: 2 },
    });
    expect(
      (await service().replace(f.a.ctx, f.a.staff, f.t.id, f.input)).episodes[0]
        ?.changedInReleaseNo,
    ).toBe(2);
    await h.prisma.deliveryTicket.update({
      where: { id: f.t.id },
      data: { pauseCount: 1, pausedAt: h.clock.now() },
    });
    await expect(
      service().replace(f.a.ctx, f.a.staff, f.t.id, { ...f.input, lockVersion: 1 }),
    ).rejects.toMatchObject({ error: "TICKET_ON_HOLD" });
    await h.prisma.deliveryTicket.update({
      where: { id: f.t.id },
      data: { pauseCount: 0, pausedAt: null },
    });
    await h.prisma.deliveryTicket.update({
      where: { id: f.t.id },
      data: { linksSubmittedAt: h.clock.now() },
    });
    await expect(
      service().replace(f.a.ctx, f.a.staff, f.t.id, { ...f.input, lockVersion: 1 }),
    ).rejects.toMatchObject({ error: "PUBLISH_LIST_LOCKED" });
    expect(await service().get(f.a.staff, f.t.id)).toMatchObject({
      isEditable: false,
      lockReason: "links_submitted",
    });
  });
  it("I16报告真实缺头和越界行，不自愈或静默忽略", async () => {
    const f = await editing(1);
    expect(await h.tx.run((tx) => findDeliveryViolations(tx, "I16"))).toEqual([]);
    await h.prisma.publishList.delete({ where: { deliveryTicketId: f.t.id } });
    await h.prisma.publishListEpisode.create({
      data: {
        deliveryTicketId: f.t.id,
        episodeNo: 2,
        topics: [],
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const found = (await h.tx.run((tx) => findDeliveryViolations(tx, "I16"))).filter(
      (r) => r.subject && "id" in r.subject && r.subject.id.startsWith(f.t.id),
    );
    expect(found).toHaveLength(2);
    expect(found[1]?.detail).toMatchObject({
      missingPublishList: true,
      episodeNo: 2,
      episodeCount: 1,
    });
    expect(await h.prisma.publishList.count({ where: { deliveryTicketId: f.t.id } })).toBe(0);
  });
});
