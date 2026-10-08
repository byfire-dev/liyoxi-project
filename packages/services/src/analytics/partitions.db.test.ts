import { createHash } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import type { PrismaClient } from "@liyoxi/db";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createProviderHarness,
  useSeededDatabase,
} from "../testing/index.js";
import { createAnalyticsPartitions } from "./partitions.js";
import { createAnalyticsJobs } from "./jobs.js";
import { analyticsPartitionName, analyticsRetention } from "./partition-month.js";
import { ANALYTICS_ARCHIVE_CHUNK_BYTES, ANALYTICS_ARCHIVE_PAGE_ROWS } from "./partition-archive.js";

const db = useSeededDatabase("services", { label: "apartitions" });
const MONTH = "2007-01";
let prisma: PrismaClient;
let clock: ReturnType<typeof createClock>;
let h: ReturnType<typeof createProviderHarness>;
let tx: ReturnType<typeof createTxRunner>;
let service: ReturnType<typeof createAnalyticsPartitions>;
beforeEach(async () => {
  await db.reset();
  prisma = await db.prisma();
  clock = createClock(new Date("2010-10-20T00:00:00+08:00"));
  tx = createTxRunner({ prisma, appEnv: "test" });
  h = createProviderHarness({ clock });
  service = createAnalyticsPartitions({
    tx,
    clock,
    appEnv: "test",
    storage: () => h.providers.storage,
  });
}, 120_000);
async function ensure(month = MONTH) {
  await tx.run((t) =>
    t.$queryRawUnsafe(
      "SELECT public.lyx_14_analytics_event_ensure_partition($1::date)",
      `${month}-01`,
    ),
  );
}
async function insert(month = MONTH, microseconds = "000001", props = "{}") {
  const id = uuidv7();
  await prisma.$executeRawUnsafe(
    `INSERT INTO public.analytics_event
    (occurred_at,id,event_id,name,source,actor_type,received_at,props,scene,city_code,category_code,client_platform,client_version)
    VALUES ($1::timestamptz,$2::uuid,$3,'archive_fixture','direct','system',$4::timestamptz,$5::jsonb,1001,'310100','fictional_category','fictional_platform','fictional_version')`,
    `${month}-02T03:04:05.${microseconds}Z`,
    id,
    `fictional-${id}`,
    `${month}-03T03:04:05.123456Z`,
    props,
  );
  return id;
}
async function rows(month = MONTH) {
  return prisma.$queryRawUnsafe<Array<{ body: string }>>(
    `SELECT row_to_json(e)::text AS body FROM public.analytics_event e
    WHERE occurred_at >= $1::timestamptz AND occurred_at < $1::timestamptz + interval '1 month' ORDER BY occurred_at,id`,
    `${month}-01T00:00:00+08:00`,
  );
}
const run = (signal?: AbortSignal) =>
  service.maintain({
    scheduledFor: new Date("1900-01-01"),
    runTx: (fn) => tx.run(fn),
    ...(signal ? { signal } : {}),
  });
const objects = () => h.providers.storage.objects;
it("保留期先按北京时间月历回退，月末零点不跨错到下一月", async () => {
  for (const [at, boundary] of [
    ["2010-03-31T00:00:00+08:00", "2008-02"],
    ["2011-03-31T00:00:00+08:00", "2009-02"],
  ] as const)
    expect(await tx.run((handle) => analyticsRetention(handle, new Date(at)))).toEqual({
      months: 25,
      boundary,
    });
});
function archiveBodies(month = MONTH) {
  const manifests = [...objects()].filter(
    ([key]) =>
      key.startsWith(`secure/analytics/archive/${month}/`) && key.endsWith(".manifest.json"),
  );
  expect(manifests).toHaveLength(1);
  const root = JSON.parse(Buffer.from(manifests[0]![1].body).toString()) as {
    rows: string;
    chunks: number;
    lastIndex: { key: string; sha256: string } | null;
  };
  const chunks: string[][] = [];
  let link = root.lastIndex;
  while (link) {
    const indexBody = objects().get(`secure/${link.key}`)!.body;
    expect(createHash("sha256").update(indexBody).digest("hex")).toBe(link.sha256);
    const index = JSON.parse(Buffer.from(indexBody).toString()) as {
      previous: typeof link;
      data: { key: string; sha256: string; size: number };
      rows: number;
    };
    const data = objects().get(`secure/${index.data.key}`)!.body;
    expect(data.byteLength).toBe(index.data.size);
    expect(data.byteLength).toBeLessThanOrEqual(ANALYTICS_ARCHIVE_CHUNK_BYTES);
    expect(createHash("sha256").update(data).digest("hex")).toBe(index.data.sha256);
    const lines = Buffer.from(data).toString().trimEnd().split("\n");
    expect(lines).toHaveLength(index.rows);
    chunks.unshift(lines);
    link = index.previous;
  }
  expect(chunks).toHaveLength(root.chunks);
  const lines = chunks.flat();
  expect(String(lines.length)).toBe(root.rows);
  return { root, lines };
}
it("真正整月全部21列归档：微秒二元游标越过128行页界，最后manifest确认后才退役", async () => {
  await ensure();
  for (let n = 0; n <= ANALYTICS_ARCHIVE_PAGE_ROWS; n++)
    await insert(
      MONTH,
      String(n + 1).padStart(6, "0"),
      JSON.stringify({ nested: { fictional: n }, arr: [1, 2] }),
    );
  const before = await rows();
  expect(await run()).toEqual({ built: 4, archived: 1, archivedRows: String(before.length) });
  const archive = archiveBodies();
  expect(archive.lines).toEqual(before.map((row) => row.body));
  for (const line of archive.lines) expect(Object.keys(JSON.parse(line))).toHaveLength(21);
  expect(await rows()).toEqual([]);
  const relation = await prisma.$queryRawUnsafe<Array<{ name: string | null }>>(
    "SELECT to_regclass($1)::text AS name",
    `public.${analyticsPartitionName(MONTH)}`,
  );
  expect(relation[0]?.name).toBeNull();
  expect(
    await prisma.auditLog.findFirst({ where: { action: "analytics.partition.archive" } }),
  ).toMatchObject({ targetType: "analytics_event", targetKey: MONTH });
  h.callNames().forEach((name, n, names) => {
    if (name === "storage.putObject") expect(names[n + 1]).toBe("storage.head");
  });
  expect(await run()).toEqual({ built: 4, archived: 0, archivedRows: "0" });
}, 120_000);
it("块和索引链内存有界，不截断超单块的整月数据", async () => {
  await ensure();
  for (let n = 0; n < 20; n++)
    await insert(
      MONTH,
      String(n + 1).padStart(6, "0"),
      JSON.stringify({ fictional: "x".repeat(60_000) }),
    );
  const before = await rows();
  await run();
  const archive = archiveBodies();
  expect(archive.root.chunks).toBe(2);
  expect(archive.lines).toEqual(before.map((row) => row.body));
}, 120_000);
it("候选读取后另一归档者已经退役，旧候选不能重建空月或再记一次退役", async () => {
  await ensure();
  await insert();
  let resume!: () => void,
    ready!: () => void,
    calls = 0;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const selected = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const delayed = service.maintain({
    scheduledFor: clock.now(),
    runTx: async (fn) => {
      if (++calls === 6) {
        ready();
        await held;
      }
      return tx.run(fn);
    },
  });
  try {
    await Promise.race([
      selected,
      delayed.then(() => {
        throw new Error("归档者未读候选却结束");
      }),
    ]);
    expect(await run()).toMatchObject({ archived: 1, archivedRows: "1" });
    resume();
    expect(await delayed).toMatchObject({ archived: 0, archivedRows: "0" });
    expect(await prisma.auditLog.count({ where: { action: "analytics.partition.archive" } })).toBe(
      1,
    );
    expect(archiveBodies().lines).toHaveLength(1);
    const relation = await prisma.$queryRawUnsafe<Array<{ name: string | null }>>(
      "SELECT to_regclass($1)::text AS name",
      `public.${analyticsPartitionName(MONTH)}`,
    );
    expect(relation[0]?.name).toBeNull();
  } finally {
    resume();
    await Promise.allSettled([delayed]);
  }
}, 120_000);
it("两个并发归档者先真实完成同内容不可覆盖归档，锁内只有一次退役和审计", async () => {
  await ensure();
  await insert();
  let release!: () => void,
    both!: () => void,
    entered = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    both = resolve;
  });
  const put = h.providers.storage.putObject.bind(h.providers.storage);
  h.providers.storage.putObject = async (input) => {
    const result = await put(input);
    if (input.key.endsWith(".manifest.json")) {
      entered++;
      if (entered === 2) both();
      await held;
    }
    return result;
  };
  const tasks = [run(), run()];
  const all = Promise.all(tasks);
  try {
    await Promise.race([
      started,
      all.then(() => {
        throw new Error("两个归档者未到屏障却结束");
      }),
    ]);
    release();
    const results = await all;
    expect(results.map((value) => value.archived).sort()).toEqual([0, 1]);
    expect(await prisma.auditLog.count({ where: { action: "analytics.partition.archive" } })).toBe(
      1,
    );
    expect(archiveBodies().lines).toHaveLength(1);
    expect(await rows()).toEqual([]);
  } finally {
    release();
    await Promise.allSettled(tasks);
  }
}, 120_000);
it.each(["put", "head", "late", "oversize", "cancel"] as const)(
  "归档%s失败或取消保留分区完整行与无退役审计",
  async (kind) => {
    await ensure();
    await insert(
      MONTH,
      "000002",
      kind === "oversize" ? JSON.stringify({ fictional: "x".repeat(66_000) }) : "{}",
    );
    const controller = new AbortController(),
      put = h.providers.storage.putObject.bind(h.providers.storage);
    if (kind === "put") h.providers.storage.failNext("putObject");
    if (kind === "head") h.providers.storage.failNext("head");
    h.providers.storage.putObject = async (input) => {
      const result = await put(input);
      if (input.key.endsWith(".manifest.json") && kind === "late") await insert(MONTH, "000001");
      if (kind === "cancel") controller.abort();
      return result;
    };
    await expect(run(controller.signal)).rejects.toBeDefined();
    if (kind === "oversize") h.assertNoCalls();
    else expect(h.calls("storage.putObject").length).toBeGreaterThan(0);
    if (kind === "head") expect(h.calls("storage.head")).toHaveLength(1);
    if (kind === "cancel") expect(controller.signal.aborted).toBe(true);
    const after = await rows();
    expect(after).toHaveLength(kind === "late" ? 2 : 1);
    const relation = await prisma.$queryRawUnsafe<Array<{ name: string | null }>>(
      "SELECT to_regclass($1)::text AS name",
      `public.${analyticsPartitionName(MONTH)}`,
    );
    expect(relation[0]?.name).toBe(analyticsPartitionName(MONTH));
    expect(await prisma.auditLog.count({ where: { action: "analytics.partition.archive" } })).toBe(
      0,
    );
  },
  120_000,
);
it("保留期fresh检查阻止外呼期间扩大保留期后删除；当前及未来3月真实预建", async () => {
  await ensure();
  await insert();
  const put = h.providers.storage.putObject.bind(h.providers.storage);
  h.providers.storage.putObject = async (input) => {
    const result = await put(input);
    if (input.key.endsWith(".manifest.json"))
      await prisma.paramValue.create({
        data: {
          id: uuidv7(),
          key: "analytics.retention_months",
          value: 60,
          effectiveAt: clock.now(),
          createdByStaffId: uuidv7(),
          createdAt: clock.now(),
        },
      });
    return result;
  };
  await expect(run()).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  expect(await rows()).toHaveLength(1);
  const names = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT relname AS name FROM pg_class WHERE relname=ANY($1::text[]) ORDER BY relname",
    ["2010-10", "2010-11", "2010-12", "2011-01"].map(analyticsPartitionName),
  );
  expect(names).toHaveLength(4);
}, 120_000);
it("受限CLI同TX授权/月份/环境与真实DEFAULT搬移及重放审计", async () => {
  const make = createFactories({ db: prisma, clock });
  const admin = await make.staff({ staffRoleKey: "super_admin" });
  const denied = await make.staff({ staffRoleKey: "content_ops" });
  const month = "2010-06",
    input = { month, staffId: admin.id, appEnv: "test" as const, note: "核实后搬移测试月数据" };
  const id = await insert(month);
  const before = await rows(month);
  await expect(service.repartition({ ...input, staffId: denied.id })).rejects.toMatchObject({
    error: "PERMISSION_DENIED",
  });
  for (const patch of [
    { month: "2000-01" },
    { month: "2011-02" },
    { month: "2010-13" },
    { appEnv: "local" as const },
  ])
    await expect(service.repartition({ ...input, ...patch })).rejects.toMatchObject({
      error: "VALIDATION_FAILED",
    });
  expect(await service.repartition(input)).toEqual({ month, moved: "1" });
  expect(await service.repartition(input)).toEqual({ month, moved: "0" });
  expect(await rows(month)).toEqual(before);
  expect(await prisma.analyticsEvent.findMany({ where: { id } })).toHaveLength(1);
  expect(
    await prisma.auditLog.count({
      where: {
        action: "analytics.partition.repartition",
        targetKey: month,
        actorId: admin.id,
        client: "cli",
      },
    }),
  ).toBe(2);
}, 120_000);
it("owned scope关闭等待已进入的真实PUT，再拒绝退役；另一scope仍可运行", async () => {
  await ensure();
  await insert();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const put = h.providers.storage.putObject.bind(h.providers.storage);
  h.providers.storage.putObject = async (input) => {
    entered();
    await held;
    return put(input);
  };
  const base = assembleForTest({ entry: "worker" });
  const deps = { tx, clock, appEnv: "test" as const, storage: () => h.providers.storage };
  const first = createAnalyticsJobs(base, deps),
    second = createAnalyticsJobs(base, deps);
  const task = first.assembly
    .recurringJob("analytics.partitions")!
    .run({ scheduledFor: clock.now(), runTx: (fn) => tx.run(fn) });
  const result = task.then(
    () => "resolved",
    () => "cancelled",
  );
  try {
    await Promise.race([
      started,
      task.then(() => {
        throw new Error("尚未进入PUT任务却已结束");
      }),
    ]);
    let closed = false;
    const close = first.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    expect(await result).toBe("cancelled");
    await close;
    expect(await rows()).toHaveLength(1);
    await expect(
      first.assembly
        .recurringJob("analytics.partitions")!
        .run({ scheduledFor: clock.now(), runTx: (fn) => tx.run(fn) }),
    ).rejects.toThrow("已经关闭");
    await expect(
      second.assembly
        .recurringJob("analytics.dedup_purge")!
        .run({ scheduledFor: clock.now(), runTx: (fn) => tx.run(fn) }),
    ).resolves.toEqual({ deleted: 0, batches: 1 });
  } finally {
    release();
    await Promise.all([first.close(), second.close()]);
    await result;
  }
}, 120_000);
