import { RegionExtSchema } from "@liyoxi/contract";
import { beforeEach, expect, it } from "vitest";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import { createClock, useSeededDatabase, useTestRedis } from "../testing/index.js";
import { createConfig } from "./index.js";
import { localRegionSeeds, LOCAL_REGION_SOURCE, seedLocalRegions } from "./local-regions.js";

const db = useSeededDatabase("services");
const redis = useTestRedis();
const clock = createClock();
beforeEach(async () => {
  await db.reset();
}, 60_000);

it("2024来源完整且三级父子链有效；只补明确的中间分组，不伪造区县", () => {
  const rows = localRegionSeeds();
  expect(rows).toHaveLength(LOCAL_REGION_SOURCE.officialCount + 9);
  expect(new Set(rows.map((row) => row.code)).size).toBe(rows.length);
  expect([1, 2, 3].map((level) => rows.filter((row) => row.ext.level === level).length)).toEqual([
    34, 342, 2846,
  ]);
  const byCode = new Map(rows.map((row) => [row.code, row]));
  for (const row of rows) {
    expect(row.code).toMatch(/^\d{6}$/);
    expect(row.name.length).toBeGreaterThan(0);
    const ext = RegionExtSchema.parse(row.ext);
    if (row.parentCode !== null) {
      const parent = byCode.get(row.parentCode)!;
      expect(parent).toBeDefined();
      expect(parent.ext.level).toBe(ext.level - 1);
      if (ext.opened) expect(parent.ext.opened).toBe(true);
    } else expect(ext.level).toBe(1);
  }
  expect(rows.filter((row) => !row.ext.opened).map((row) => row.code)).toEqual([
    "441900",
    "442000",
    "460400",
    "620200",
    "710000",
    "810000",
    "820000",
  ]);
  expect(byCode.get("500236")?.parentCode).toBe("500200");
  expect(byCode.get("419001")?.parentCode).toBe("419000");
  expect(localRegionSeeds("510000")).toHaveLength(205);
  expect(() => localRegionSeeds("510100")).toThrow(/省份编码/);
});

it("空地区库补出可选省市区，重复导入零新增且版本不变", async () => {
  const prisma = await db.prisma();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const config = createConfig({ db: prisma, clock, redis: null });
  expect((await config.dicts.listForMerchant(["region"]))[0]?.items).toEqual([]);
  expect(
    (await tx.run((handle) => seedLocalRegions(handle, "test", clock.now(), "510000"))).inserted,
  ).toBe(205);
  config.cache.invalidate("dict");
  const [region] = await config.dicts.listForMerchant(["region"]);
  expect(region?.items.find((row) => row.code === "510000")).toMatchObject({
    name: "四川省",
    parentCode: null,
    isSelectable: true,
  });
  expect(region?.items.find((row) => row.code === "510100")).toMatchObject({
    name: "成都市",
    parentCode: "510000",
    isSelectable: true,
  });
  expect(region?.items.find((row) => row.code === "510104")).toMatchObject({
    name: "锦江区",
    parentCode: "510100",
    isSelectable: true,
  });
  const version = region!.versionNo;
  expect(
    await tx.run((handle) => seedLocalRegions(handle, "test", clock.now(), "510000")),
  ).toMatchObject({ inserted: 0, existing: 205 });
  expect(
    (await prisma.dictType.findUniqueOrThrow({ where: { typeKey: "region" } })).versionNo,
  ).toBe(version);
});

it("保留已有名称、关闭/停用配置；新增下级不越过未开通的祖先", async () => {
  const prisma = await db.prisma();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  await prisma.dictItem.create({
    data: {
      id: uuidv7(),
      dictTypeKey: "region",
      code: "510000",
      name: "原名称",
      parentCode: null,
      isEnabled: false,
      ext: { level: 1, functionalZone: false, opened: false },
      position: 0,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  });
  expect(
    (await tx.run((handle) => seedLocalRegions(handle, "test", clock.now(), "510000"))).inserted,
  ).toBe(204);
  expect(
    await prisma.dictItem.findUniqueOrThrow({
      where: { dictTypeKey_code: { dictTypeKey: "region", code: "510000" } },
    }),
  ).toMatchObject({ name: "原名称", isEnabled: false, ext: { opened: false } });
  const config = createConfig({ db: prisma, clock, redis: null });
  expect((await config.dicts.listForMerchant(["region"]))[0]?.items).toEqual([]);
});

it("已有层级冲突整批拒绝；stg/prod 不能调用调试导入", async () => {
  const prisma = await db.prisma();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  await prisma.dictItem.create({
    data: {
      id: uuidv7(),
      dictTypeKey: "region",
      code: "510000",
      name: "错误层级",
      parentCode: null,
      ext: { level: 2, functionalZone: false, opened: true },
      position: 0,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  });
  await expect(
    tx.run((handle) => seedLocalRegions(handle, "test", clock.now(), "510000")),
  ).rejects.toThrow(/层级或父码/);
  expect(await prisma.dictItem.count({ where: { dictTypeKey: "region" } })).toBe(1);
  for (const env of ["stg", "prod"] as const)
    await expect(tx.run((handle) => seedLocalRegions(handle, env, clock.now()))).rejects.toThrow(
      /仅允许/,
    );
});

it("并发同一快照只插一次；提交并bump后另一缓存实例能读到地区", async () => {
  const prisma = await db.prisma();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const client = await redis.client();
  const config = createConfig({ db: prisma, clock, redis: client });
  const other = createConfig({ db: prisma, clock, redis: client });
  expect((await other.dicts.listForMerchant(["region"]))[0]?.items).toEqual([]);
  const results = await Promise.all(
    [1, 2].map(() => tx.run((handle) => seedLocalRegions(handle, "test", clock.now(), "510000"))),
  );
  expect(results.map((result) => result.inserted).sort((a, b) => a - b)).toEqual([0, 205]);
  await config.cache.bump("dict");
  clock.advance(5_001);
  expect((await other.dicts.listForMerchant(["region"]))[0]?.items).toHaveLength(205);
});
