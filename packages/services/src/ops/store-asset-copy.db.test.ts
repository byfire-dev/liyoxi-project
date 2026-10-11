import { createPrismaClient } from "@liyoxi/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStoreAssetCopyOwner, findI11Violations } from "../media/index.js";
import type { StoreAssetCopyPlan } from "../media/index.js";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import {
  connectTestDatabase,
  createMediaAssetsHarness,
  snapshotTables,
  assertSnapshotsEqual,
  useSeededDatabase,
} from "../testing/index.js";

const db = useSeededDatabase("services", { label: "brandassets", max: 1 });
const SLOW = 60_000;
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
beforeEach(async () => {
  h = await createMediaAssetsHarness(await db.prisma());
}, 120_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.close();
}, SLOW);
const owner = (media = h.media) =>
  createStoreAssetCopyOwner({
    clock: h.clock,
    media,
    sla: h.assets.sla,
    timers: h.timers,
    readStore: h.assets.readStore,
  });
async function world() {
  const target = await h.make.store({ entityId: h.merchant.entity.id });
  const input = {
    entityId: h.merchant.entity.id,
    sourceStoreId: h.merchant.store.id,
    targetStoreId: target.id,
  };
  return { target, input };
}
type World = Awaited<ReturnType<typeof world>>;
async function source(brand = true, files: string[] = []) {
  const view = await h.media.assets.create(h.owner, {
    type: files.length ? "image" : "text",
    ...(files.length ? { fileIds: files } : { textBody: "公开品牌故事正文" }),
    contentTagCodes: brand ? ["brand_story"] : [],
    note: "公开原始说明",
  });
  return h.prisma.storeAsset.findUniqueOrThrow({ where: { id: view.storeAssetId } });
}
const run = (w: World, one = owner()) =>
  h.tx.run(async (tx) => one.apply(tx, await one.prepare(tx, w.input)));
const copies = (w: World) =>
  h.prisma.storeAsset.findMany({
    where: { storeId: w.target.id },
    orderBy: { sourceStoreAssetId: "asc" },
  });
const sourceRows = (id: string) =>
  h.prisma.storeAsset.findUniqueOrThrow({
    where: { id },
    include: { storeAssetFiles: true, storeAssetTags: true, storeAssetInsights: true },
  });
const TABLES = [
  "store_asset",
  "store_asset_file",
  "store_asset_tag",
  "store_asset_insight",
  "file_ref",
  "file_object",
  "timer",
  "media_job",
  "outbox_event",
];
async function bounded<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("品牌复制测试栅栏超时")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function block(
  observer: Awaited<ReturnType<typeof connectTestDatabase>>,
  pids: () => [number, number],
) {
  await bounded(
    (async () => {
      for (;;) {
        const [waiter, holder] = pids();
        if (waiter && holder) {
          expect(waiter).not.toBe(holder);
          const row = await observer.query<{ blocked: boolean }>(
            "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
            [waiter, holder],
          );
          if (row.rows[0]?.blocked) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })(),
  );
}
async function race(
  w: World,
  hold: (client: Awaited<ReturnType<typeof connectTestDatabase>>) => Promise<void>,
) {
  const holder = await connectTestDatabase(db.name),
    observer = await connectTestDatabase(db.name, { role: null });
  let pending: Promise<void> | undefined;
  try {
    await holder.query("BEGIN");
    const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows[0]!.pid;
    await hold(holder);
    let waiterPid = 0;
    const one = owner();
    pending = h.tx.run(async (tx) => {
      waiterPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      await one.apply(tx, await one.prepare(tx, w.input));
    });
    const settled = Promise.allSettled([pending]);
    await bounded(
      (async () => {
        for (;;) {
          if (waiterPid) {
            expect(waiterPid).not.toBe(holderPid);
            const row = await observer.query<{ blocked: boolean }>(
              "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
              [waiterPid, holderPid],
            );
            if (row.rows[0]?.blocked) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })(),
    );
    await holder.query("COMMIT");
    return (await settled)[0]!;
  } finally {
    await holder.query("ROLLBACK");
    if (pending) await Promise.allSettled([pending]);
    await holder.end();
    await observer.end();
  }
}

describe("品牌素材owner：真实callerTx引用与精确映射", { timeout: SLOW }, () => {
  it("真实上传文件和肖像材料只加引用；完整字段、标签、旧洞察及来源不变", async () => {
    const w = await world(),
      file = await h.stored(),
      portrait = await h.stored(h.owner, "portrait_auth");
    const original = await source(true, [file.id]);
    // 明确的合法历史复核/洞察事实；不声称 Provider 已产出旧格式内容。
    await h.prisma.storeAsset.update({
      where: { id: original.id },
      data: {
        title: "人工品牌标题",
        processingState: "processed",
        reviewState: "reviewed",
        usability: "ready",
        reviewedByStaffId: h.staff.id,
        reviewedAt: h.clock.now(),
        portraitAuthFileIds: [portrait.id],
        portraitAuthorizedAt: h.clock.now(),
        moderationState: "pass",
        searchText: "公开检索快照",
        isInsightPartial: true,
        adoptedCount: 0,
      },
    });
    await h.prisma.storeAssetTag.create({
      data: {
        id: uuidv7(),
        storeAssetId: original.id,
        dimension: "timeliness",
        tagCode: "public_history",
        source: "reviewer",
        isConfirmed: true,
        validStartDate: new Date("2026-10-01"),
        validEndDate: new Date("2026-10-30"),
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    for (const status of ["ok", "failed", "skipped"])
      await h.prisma.storeAssetInsight.create({
        data: {
          id: uuidv7(),
          storeAssetId: original.id,
          fileId: status === "ok" ? file.id : null,
          kind: status === "ok" ? "vision" : status === "failed" ? "digest" : "structured_items",
          promptVersion: 1,
          provider: "fake",
          model: "public-legacy",
          status,
          content: { legacy: status },
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
    const before = await sourceRows(original.id),
      jobs = await h.prisma.mediaJob.count(),
      events = await h.prisma.outboxEvent.count();
    const oldTimers = await h.prisma.timer.findMany({ where: { subjectId: original.id } });
    h.fake.llm.calls.length = 0;
    const providerCalls = [
      h.fake.storage.calls.length,
      h.fake.media.calls.length,
      h.fake.asr.calls.length,
      h.fake.llm.calls.length,
    ];
    const stored = vi.spyOn(h.fake.storage, "copy");
    await run(w);
    const [copy] = await copies(w);
    expect(copy).toMatchObject({
      ...original,
      id: expect.any(String),
      storeId: w.target.id,
      sourceStoreAssetId: original.id,
      title: "人工品牌标题",
      reviewState: "reviewed",
      usability: "ready",
      processingState: "processed",
      moderationState: "pass",
      portraitAuthFileIds: [portrait.id],
      isInsightPartial: true,
      adoptedCount: 0,
      storeAssetDemandId: null,
      lockVersion: 0,
      dueAt: null,
      slaSnapshot: null,
      idempotencyKey: `copy:${original.id}`,
      deletedAt: null,
      searchText: "公开检索快照",
      reviewedByStaffId: h.staff.id,
      reviewedAt: before.reviewedAt,
      portraitAuthorizedAt: before.portraitAuthorizedAt,
    });
    expect(copy!.id).not.toBe(original.id);
    const copied = await sourceRows(copy!.id);
    expect(copied.storeAssetFiles.map((row) => [row.position, row.fileId])).toEqual([[1, file.id]]);
    expect(
      copied.storeAssetTags.map(
        ({ id: _id, storeAssetId: _a, createdAt: _c, updatedAt: _u, ...facts }) => facts,
      ),
    ).toEqual(
      expect.arrayContaining(
        before.storeAssetTags.map(
          ({ id: _id, storeAssetId: _a, createdAt: _c, updatedAt: _u, ...facts }) => facts,
        ),
      ),
    );
    expect(copied.storeAssetTags).toHaveLength(before.storeAssetTags.length);
    for (const row of copied.storeAssetInsights) {
      const old = before.storeAssetInsights.find(
        (item) => item.id === row.reusedFromStoreAssetInsightId,
      )!;
      expect(row).toMatchObject({
        fileId: old.fileId,
        kind: old.kind,
        status: old.status,
        content: old.content,
        provider: old.provider,
        model: old.model,
        promptVersion: old.promptVersion,
        mediaJobId: null,
      });
      expect(row.id).not.toBe(old.id);
    }
    expect(copied.storeAssetInsights).toHaveLength(3);
    expect(
      await h.prisma.fileRef.findMany({ where: { refId: copy!.id }, orderBy: { role: "asc" } }),
    ).toEqual([
      expect.objectContaining({ fileId: file.id, role: "main", releasedAt: null }),
      expect.objectContaining({ fileId: portrait.id, role: "portrait_auth", releasedAt: null }),
    ]);
    expect(await sourceRows(original.id)).toEqual(before);
    expect(await h.prisma.timer.findMany({ where: { subjectId: original.id } })).toEqual(oldTimers);
    expect(await h.prisma.timer.count({ where: { subjectId: copy!.id } })).toBe(0);
    expect(await h.prisma.mediaJob.count()).toBe(jobs);
    expect(await h.prisma.outboxEvent.count()).toBe(events);
    expect(stored).not.toHaveBeenCalled();
    expect(h.fake.llm.calls).toEqual([]);
    expect([
      h.fake.storage.calls.length,
      h.fake.media.calls.length,
      h.fake.asr.calls.length,
      h.fake.llm.calls.length,
    ]).toEqual(providerCalls);
  });
  it.each(["pending", "processing", "processed"])(
    "不添加%s状态筛选；未复核副本重算真实SLA和timer",
    async (processingState) => {
      const w = await world(),
        original = await source();
      await h.prisma.storeAsset.update({ where: { id: original.id }, data: { processingState } });
      h.clock.advance(60_000);
      await run(w);
      const [row] = await copies(w);
      expect(row).toMatchObject({
        processingState,
        reviewState: "unreviewed",
        createdAt: h.clock.now(),
        lockVersion: 0,
      });
      expect(row!.dueAt!.getTime()).toBeGreaterThan(row!.createdAt.getTime());
      expect(row!.slaSnapshot).toMatchObject({
        policy: "review.store_asset",
        computedAt: h.clock.now().toISOString(),
      });
      expect(await h.prisma.timer.findMany({ where: { subjectId: row!.id } })).toEqual([
        expect.objectContaining({
          kind: "sla.breach",
          dedupeKey: `sla.breach:store_asset:${row!.id}`,
          fireAt: row!.dueAt,
          status: "scheduled",
          storeId: w.target.id,
        }),
      ]);
    },
  );
  it("只复制未删除content/brand_story；usage同名、非品牌和软删不入集合", async () => {
    const w = await world(),
      brand = await source(),
      other = await source(false),
      deleted = await source();
    await h.prisma.storeAssetTag.create({
      data: {
        id: uuidv7(),
        storeAssetId: other.id,
        dimension: "usage",
        tagCode: "brand_story",
        source: "uploader",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await h.prisma.storeAsset.update({
      where: { id: deleted.id },
      data: { deletedAt: h.clock.now() },
    });
    await run(w);
    expect((await copies(w)).map((row) => row.sourceStoreAssetId)).toEqual([brand.id]);
  });
  it("无来源素材是明确空集合，不造任务/洞察/引用", async () => {
    const w = await world(),
      before = await snapshotTables(h.prisma, TABLES);
    await run(w);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
  });
  it.each(["reference_only", "need_reshoot", "need_portrait_auth"])(
    "已复核%s原结论照抄，不加ready筛选或新timer",
    async (usability) => {
      const w = await world(),
        original = await source();
      await h.prisma.storeAsset.update({
        where: { id: original.id },
        data: {
          reviewState: "reviewed",
          usability,
          reviewedByStaffId: h.staff.id,
          reviewedAt: h.clock.now(),
        },
      });
      await run(w);
      const [copy] = await copies(w);
      expect(copy).toMatchObject({
        usability,
        reviewState: "reviewed",
        dueAt: null,
        slaSnapshot: null,
        reviewedByStaffId: h.staff.id,
      });
      expect(await h.prisma.timer.count({ where: { subjectId: copy!.id } })).toBe(0);
    },
  );
  it.each(["foreign", "same", "primary", "archived", "qualified", "missing", "unknown"])(
    "%s真实事实或严格入参拒绝",
    async (kind) => {
      const w = await world();
      await source();
      const raw = { ...w.input };
      if (kind === "foreign") raw.targetStoreId = (await h.make.store()).id;
      if (kind === "same") raw.targetStoreId = raw.sourceStoreId;
      if (kind === "primary") {
        raw.sourceStoreId = (await h.make.store({ entityId: w.input.entityId })).id;
        raw.targetStoreId = h.merchant.store.id;
      }
      if (kind === "archived")
        await h.prisma.store.update({
          where: { id: w.target.id },
          data: {
            lifecycle: "archived",
            archiveReason: "by_owner",
            archivedAt: h.clock.now(),
            archiveActorType: "merchant",
            archiveActorId: h.merchant.user.id,
            archiveClient: "weapp",
          },
        });
      if (kind === "qualified")
        await h.prisma.store.update({
          where: { id: w.target.id },
          data: { qualificationStatus: "verified" },
        });
      if (kind === "missing") raw.sourceStoreId = uuidv7();
      if (kind === "unknown") Object.assign(raw, { authorized: true });
      const before = await snapshotTables(h.prisma, TABLES);
      await expect(h.tx.run((tx) => owner().prepare(tx, raw))).rejects.toMatchObject({
        error: "VALIDATION_FAILED",
      });
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
  );
  it.each(["clone", "factory", "twice", "transaction"])(
    "opaque计划拒绝%s且整笔无副作用",
    async (kind) => {
      const w = await world();
      await source();
      const one = owner();
      let plan!: StoreAssetCopyPlan;
      const before = await snapshotTables(h.prisma, TABLES);
      if (kind === "transaction") {
        await h.tx.run(async (tx) => {
          plan = await one.prepare(tx, w.input);
        });
        await expect(h.tx.run((tx) => one.apply(tx, plan))).rejects.toThrow(TypeError);
      } else
        await expect(
          h.tx.run(async (tx) => {
            plan = await one.prepare(tx, w.input);
            if (kind === "twice") await one.apply(tx, plan);
            await (kind === "factory" ? owner() : one).apply(
              tx,
              kind === "clone" ? { fileIds: plan.fileIds } : plan,
            );
          }),
        ).rejects.toThrow(TypeError);
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
  );
  it("prepare输入与fileIds深快照不可被调用方更换", async () => {
    const w = await world(),
      file = await h.stored();
    await source(true, [file.id]);
    const raw = { ...w.input },
      one = owner();
    await h.tx.run(async (tx) => {
      const plan = await one.prepare(tx, raw);
      raw.targetStoreId = uuidv7();
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.fileIds)).toBe(true);
      expect(() => (plan.fileIds as string[]).push(uuidv7())).toThrow(TypeError);
      await one.apply(tx, plan);
    });
    expect(await copies(w)).toHaveLength(1);
  });
  it("同TX来源快照变化不采用旧计划", async () => {
    const w = await world(),
      original = await source(),
      one = owner();
    await expect(
      h.tx.run(async (tx) => {
        const plan = await one.prepare(tx, w.input);
        await tx.storeAsset.update({ where: { id: original.id }, data: { note: "同事务新说明" } });
        await one.apply(tx, plan);
      }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    expect(await sourceRows(original.id)).toMatchObject({ note: original.note });
    expect(await copies(w)).toEqual([]);
  });
  it.each(["blocked", "deleted", "wrong-category", "foreign"])(
    "真实Media.link拒绝%s，所有新数据回滚",
    async (kind) => {
      const w = await world(),
        file = await h.stored(),
        original = await source(
          true,
          kind === "wrong-category" || kind === "foreign" ? [] : [file.id],
        );
      if (kind === "blocked")
        await h.prisma.fileObject.update({
          where: { id: file.id },
          data: { moderationState: "block" },
        });
      if (kind === "deleted")
        await h.prisma.fileObject.update({
          where: { id: file.id },
          data: { status: "deleted", deletedAt: h.clock.now() },
        });
      if (kind === "wrong-category" || kind === "foreign") {
        const foreign = kind === "foreign" ? await h.make.store() : null;
        const replacement =
          kind === "wrong-category"
            ? await h.stored(h.owner, "portrait_auth")
            : await h.make.fileObject({
                category: "store_asset",
                bucket: "asset",
                scopeType: "store",
                entityId: foreign!.entityId,
                storeId: foreign!.id,
              });
        // 合法外键下的历史错误分类事实，不能借当前上传入口伪造通过。
        await h.prisma.storeAssetFile.create({
          data: {
            storeAssetId: original.id,
            position: 1,
            fileId: replacement.id,
            createdAt: h.clock.now(),
          },
        });
      }
      const before = await snapshotTables(h.prisma, TABLES);
      await expect(run(w)).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
  );
  it.each(["link", "tag", "insight", "timer", "outer"])(
    "%s阶段异常整笔回滚且来源不变",
    async (stage) => {
      const w = await world(),
        a = await h.stored(),
        b = await h.stored(),
        original = await source(true, [a.id, b.id]);
      await h.prisma.storeAssetInsight.create({
        data: {
          id: uuidv7(),
          storeAssetId: original.id,
          kind: "digest",
          promptVersion: 1,
          status: "failed",
          content: { reason: "public_history" },
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
      const before = await snapshotTables(h.prisma, TABLES),
        fail = new Error("公开回滚栅栏");
      if (stage === "link") {
        const real = h.media.link;
        vi.spyOn(h.media, "link").mockImplementationOnce(real).mockRejectedValueOnce(fail);
      }
      const one =
        stage === "timer"
          ? createStoreAssetCopyOwner({
              clock: h.clock,
              media: h.media,
              sla: h.assets.sla,
              readStore: h.assets.readStore,
              timers: {
                arm: async () => {
                  throw fail;
                },
              },
            })
          : owner();
      await expect(
        h.tx.run(async (tx) => {
          if (stage === "tag") vi.spyOn(tx.storeAssetTag, "create").mockRejectedValue(fail);
          if (stage === "insight") vi.spyOn(tx.storeAssetInsight, "create").mockRejectedValue(fail);
          await one.apply(tx, await one.prepare(tx, w.input));
          if (stage === "outer") throw fail;
        }),
      ).rejects.toThrow("公开回滚栅栏");
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
  );
  it("同target第二次copy自然键拒绝，不覆盖既有副本", async () => {
    const w = await world();
    await source();
    await run(w);
    const before = await snapshotTables(h.prisma, TABLES);
    await expect(run(w)).rejects.toMatchObject({ code: "P2002" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
  });
  it.each(["add", "remove", "delete", "worker"])(
    "完整370图等待%s赢家后重读，不只锁最初品牌命中行",
    async (change) => {
      const w = await world(),
        original = await source(change !== "add");
      const result = await race(w, async (holder) => {
        await holder.query("SELECT id FROM store_asset WHERE id=$1 FOR UPDATE", [original.id]);
        if (change === "add")
          await holder.query(
            "INSERT INTO store_asset_tag(id,store_asset_id,dimension,tag_code,source,created_at,updated_at) VALUES($1,$2,'content','brand_story','uploader',$3,$3)",
            [uuidv7(), original.id, h.clock.now()],
          );
        if (change === "remove")
          await holder.query("DELETE FROM store_asset_tag WHERE store_asset_id=$1", [original.id]);
        if (change === "delete")
          await holder.query("UPDATE store_asset SET deleted_at=$2 WHERE id=$1", [
            original.id,
            h.clock.now(),
          ]);
        if (change === "worker")
          await holder.query(
            "UPDATE store_asset SET processing_state='processed',title='真实winner' WHERE id=$1",
            [original.id],
          );
      });
      expect(result.status).toBe("fulfilled");
      expect(await copies(w)).toHaveLength(change === "remove" || change === "delete" ? 0 : 1);
      if (change === "worker")
        expect((await copies(w))[0]).toMatchObject({
          title: "真实winner",
          processingState: "processed",
        });
    },
  );
  it("source130阻止真实create幻读，提交后新品牌进入完整集合", async () => {
    const w = await world();
    const side = createPrismaClient({ connectionString: await db.url(), max: 1 }),
      tx = createTxRunner({ prisma: side, appEnv: "test" });
    const observer = await connectTestDatabase(db.name, { role: null }),
      entered = latch(),
      release = latch();
    const due = h.assets.sla.dueAt;
    let holder = 0;
    const spy = vi.spyOn(h.assets.sla, "dueAt").mockImplementationOnce(async (...args) => {
      holder = (await args[0].$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      const result = await due(...args);
      entered.release();
      await bounded(release.promise);
      return result;
    });
    const created = source();
    const createSettled = Promise.allSettled([created]);
    let copied: Promise<void> | undefined,
      waiter = 0;
    try {
      await bounded(
        Promise.race([
          entered.promise,
          created.then(() => {
            throw new Error("真实create未进入栅栏");
          }),
        ]),
      );
      const one = owner();
      copied = tx.run(async (handle) => {
        waiter = (await handle.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!
          .pid;
        await one.apply(handle, await one.prepare(handle, w.input));
      });
      const settled = Promise.allSettled([copied]);
      await block(observer, () => [waiter, holder]);
      release.release();
      const original = await created;
      expect(await settled).toEqual([{ status: "fulfilled", value: undefined }]);
      expect((await copies(w)).map((row) => row.sourceStoreAssetId)).toEqual([original.id]);
    } finally {
      release.release();
      await createSettled;
      if (copied) await Promise.allSettled([copied]);
      spy.mockRestore();
      await side.$disconnect();
      await observer.end();
    }
  });
  it("真实两app事务竞争同target，唯一自然键winner不覆盖来源", async () => {
    const w = await world(),
      original = await source();
    const side = createPrismaClient({ connectionString: await db.url(), max: 1 }),
      tx = createTxRunner({ prisma: side, appEnv: "test" });
    const observer = await connectTestDatabase(db.name, { role: null }),
      entered = latch(),
      release = latch();
    let holder = 0,
      waiter = 0,
      second: Promise<void> | undefined;
    const firstOwner = owner(),
      secondOwner = owner();
    const first = h.tx.run(async (handle) => {
      holder = (await handle.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      const plan = await firstOwner.prepare(handle, w.input);
      entered.release();
      await bounded(release.promise);
      await firstOwner.apply(handle, plan);
    });
    const firstSettled = Promise.allSettled([first]);
    try {
      await bounded(
        Promise.race([
          entered.promise,
          first.then(() => {
            throw new Error("首事务未进入栅栏");
          }),
        ]),
      );
      second = tx.run(async (handle) => {
        waiter = (await handle.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!
          .pid;
        await secondOwner.apply(handle, await secondOwner.prepare(handle, w.input));
      });
      const settled = Promise.allSettled([second]);
      await block(observer, () => [waiter, holder]);
      release.release();
      expect(await firstSettled).toEqual([{ status: "fulfilled", value: undefined }]);
      expect(await settled).toEqual([
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "P2002" }),
        }),
      ]);
      expect((await copies(w)).map((row) => row.sourceStoreAssetId)).toEqual([original.id]);
    } finally {
      release.release();
      await firstSettled;
      if (second) await Promise.allSettled([second]);
      await side.$disconnect();
      await observer.end();
    }
  });
  it("反向素材UUID仍完整sorted370，两个文件共同410使用真实link", async () => {
    const w = await world(),
      a = await h.stored(),
      b = await h.stored();
    const first = await source(true, [b.id]),
      second = await source(true, [a.id]);
    const result = await race(w, async (holder) => {
      await holder.query("SELECT id FROM store_asset WHERE id=$1 FOR UPDATE", [
        [first.id, second.id].sort()[1],
      ]);
    });
    expect(result.status).toBe("fulfilled");
    expect(await copies(w)).toHaveLength(2);
    expect(
      await h.prisma.fileRef.count({
        where: { refId: { in: (await copies(w)).map((row) => row.id) }, releasedAt: null },
      }),
    ).toBe(2);
  });
  it("calendar exclusive先370时复制先等calendar，不形成370→calendar反锁", async () => {
    const w = await world(),
      original = await source();
    const result = await race(w, async (holder) => {
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('config.calendar.import', 0))",
      );
      await holder.query("SELECT id FROM store_asset WHERE id=$1 FOR UPDATE", [original.id]);
    });
    expect(result.status).toBe("fulfilled");
    expect(await copies(w)).toHaveLength(1);
  });
  it("410文件赢家block后真实link拒绝，不信prepare快照", async () => {
    const w = await world(),
      file = await h.stored();
    await source(true, [file.id]);
    const result = await race(w, async (holder) => {
      await holder.query("SELECT id FROM file_object WHERE id=$1 FOR UPDATE", [file.id]);
      await holder.query("UPDATE file_object SET moderation_state='block' WHERE id=$1", [file.id]);
    });
    expect(result).toMatchObject({ status: "rejected", reason: { error: "FILE_NOT_USABLE" } });
    expect(await copies(w)).toEqual([]);
  });
  it.each(["pending", "processing"])(
    "保留%s复制状态，I11真实15分钟后汇合；不是永久零任务",
    async (processingState) => {
      const w = await world(),
        original = await source();
      await h.prisma.storeAsset.update({ where: { id: original.id }, data: { processingState } });
      const llm = h.fake.llm.calls.length;
      await run(w);
      const [copy] = await copies(w);
      expect(await h.prisma.mediaJob.count({ where: { parentId: copy!.id } })).toBe(0);
      h.clock.advance(15 * 60_000 - 1);
      expect(
        await h.tx.run((tx) =>
          findI11Violations(tx, { entityIds: [w.input.entityId] }, h.clock.now(), h.media.jobs),
        ),
      ).toEqual([]);
      h.clock.advance(1);
      const result = await h.tx.run((tx) =>
        findI11Violations(tx, { entityIds: [w.input.entityId] }, h.clock.now(), h.media.jobs),
      );
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subject: { type: "store_asset", id: copy!.id },
            healed: expect.any(Object),
          }),
        ]),
      );
      expect(await h.prisma.mediaJob.count({ where: { parentId: copy!.id } })).toBeGreaterThan(0);
      expect(h.fake.llm.calls).toHaveLength(llm);
    },
  );
});
