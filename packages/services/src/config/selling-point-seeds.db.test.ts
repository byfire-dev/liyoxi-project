import { StoreSellingPointExtSchema } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { beforeEach, expect, it } from "vitest";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import { createClock, useTestDatabase, useTestRedis } from "../testing/index.js";
import { createConfig } from "./index.js";
import { seed } from "./seed.js";
import { STORE_SELLING_POINT_SEEDS } from "./seed-data.js";
import { seedMissingSellingPoints } from "./selling-point-seeds.js";

const db = useTestDatabase("services");
const redis = useTestRedis();
const clock = createClock();
const typeKey = "store_selling_point";
beforeEach(async () => {
  await db.reset();
}, 60_000);

async function setup(patch: Partial<Prisma.DictTypeUncheckedCreateInput> = {}) {
  const prisma = await db.prisma();
  await prisma.dictType.create({
    data: {
      typeKey,
      name: "门店核心卖点",
      structure: "flat",
      maxDepth: 1,
      codePrefix: "SP",
      codeWidth: 2,
      nextCodeNo: 1,
      isMerchantVisible: true,
      canCreate: true,
      disablePolicy: "free",
      createdAt: clock.now(),
      updatedAt: clock.now(),
      ...patch,
    },
  });
  return { prisma, tx: createTxRunner({ prisma, appEnv: "test" }) };
}

it("新库标准种子提供四个全品类中性候选与下一个顺序号，重放不改任何项", async () => {
  const prisma = await db.prisma();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  await tx.run((handle) => seed.run(handle, { now: clock.now() }));
  const config = createConfig({ db: prisma, clock, redis: null });
  const [view] = await config.dicts.listForMerchant([typeKey]);
  expect(view!.items.map((row) => row.name)).toEqual([
    "品质服务",
    "环境舒适",
    "位置便利",
    "性价比高",
  ]);
  expect(view!.items.every((row) => row.isSelectable)).toBe(true);
  for (const row of view!.items)
    expect(StoreSellingPointExtSchema.parse(row.ext)).toEqual({ categoryCodes: [] });
  const type = await prisma.dictType.findUniqueOrThrow({ where: { typeKey } });
  const items = await prisma.dictItem.findMany({
    where: { dictTypeKey: typeKey },
    orderBy: { code: "asc" },
  });
  expect(type).toMatchObject({ nextCodeNo: 5, versionNo: 1 });
  const report = await tx.run((handle) => seed.run(handle, { now: clock.now() }));
  expect(report.every((table) => table.inserted === 0)).toBe(true);
  expect(await prisma.dictType.findUniqueOrThrow({ where: { typeKey } })).toEqual(type);
  expect(
    await prisma.dictItem.findMany({ where: { dictTypeKey: typeKey }, orderBy: { code: "asc" } }),
  ).toEqual(items);
});

it("标准种子补齐既有未运营空类型，结果合并在原dict_item报告且推进版本/顺序号", async () => {
  const { prisma, tx } = await setup();
  const report = await tx.run((handle) => seed.run(handle, { now: clock.now() }));
  expect(report.filter((table) => table.table === "dict_item")).toHaveLength(1);
  expect(await prisma.dictItem.count({ where: { dictTypeKey: typeKey } })).toBe(4);
  expect(await prisma.dictType.findUniqueOrThrow({ where: { typeKey } })).toMatchObject({
    nextCodeNo: 5,
    versionNo: 2,
  });
  const again = await tx.run((handle) => seedMissingSellingPoints(handle, clock.now()));
  expect(again).toMatchObject({ inserted: 0, existing: 4 });
  expect(await prisma.dictType.findUniqueOrThrow({ where: { typeKey } })).toMatchObject({
    nextCodeNo: 5,
    versionNo: 2,
  });
});

it.each([true, false])(
  "非空类型（已有选项enabled=%s）不追加或覆盖运营/停用设置",
  async (isEnabled) => {
    const { prisma, tx } = await setup();
    await prisma.dictItem.create({
      data: {
        id: uuidv7(),
        ...STORE_SELLING_POINT_SEEDS[0]!,
        ext: { categoryCodes: ["C02"], operatorNote: "保留" },
        name: "运营已编辑候选",
        isEnabled,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    const type = await prisma.dictType.findUniqueOrThrow({ where: { typeKey } });
    const items = await prisma.dictItem.findMany({ where: { dictTypeKey: typeKey } });
    await tx.run((handle) => seed.run(handle, { now: clock.now() }));
    expect(await prisma.dictType.findUniqueOrThrow({ where: { typeKey } })).toEqual(type);
    expect(await prisma.dictItem.findMany({ where: { dictTypeKey: typeKey } })).toEqual(items);
  },
);

it.each([{ nextCodeNo: 9 }, { versionNo: 2 }, { codePrefix: "NEW" }, { codeWidth: 3 }])(
  "空类型有历史或编码规则变更%j时保留，不重用已发码或恢复运营清空",
  async (patch) => {
    const { prisma, tx } = await setup(patch);
    const type = await prisma.dictType.findUniqueOrThrow({ where: { typeKey } });
    expect((await tx.run((handle) => seedMissingSellingPoints(handle, clock.now()))).inserted).toBe(
      0,
    );
    expect(await prisma.dictType.findUniqueOrThrow({ where: { typeKey } })).toEqual(type);
    expect(await prisma.dictItem.count({ where: { dictTypeKey: typeKey } })).toBe(0);
  },
);

it("并发空类型修补只插一批，提交并bump后另一缓存实例能读到候选", async () => {
  const { prisma, tx } = await setup();
  const client = await redis.client();
  const config = createConfig({ db: prisma, clock, redis: client });
  const other = createConfig({ db: prisma, clock, redis: client });
  expect((await other.dicts.listForMerchant([typeKey]))[0]?.items).toEqual([]);
  const reports = await Promise.all(
    [1, 2].map(() => tx.run((handle) => seedMissingSellingPoints(handle, clock.now()))),
  );
  expect(reports.map((report) => report.inserted).sort()).toEqual([0, 4]);
  expect(await prisma.dictItem.count({ where: { dictTypeKey: typeKey } })).toBe(4);
  expect(await prisma.dictType.findUniqueOrThrow({ where: { typeKey } })).toMatchObject({
    nextCodeNo: 5,
    versionNo: 2,
  });
  await config.cache.bump("dict");
  clock.advance(5_001);
  expect((await other.dicts.listForMerchant([typeKey]))[0]?.items).toHaveLength(4);
});
