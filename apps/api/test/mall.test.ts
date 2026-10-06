import { beforeAll, it, expect } from "vitest";
import { MallConfigSchema } from "@liyoxi/contract";
import { createIdentityContext, runSeed, seedDemoContent, uuidv7 } from "@liyoxi/services";
import { createFactories, createLedgerHarness, openTerm } from "@liyoxi/services/testing";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { merchantServicesOf } from "../src/merchant/services.js";
import { clerkVisibleKeys } from "./clerk/visible-keys.js";
type TestCard = { dramaId: string; listPricePoints: number; discountedPoints: number | null };
type TestData = {
  viewerRole: string;
  items: TestCard[];
  hot: TestCard[];
  new: TestCard[];
  nextCursor: string;
  owner: { discountBp: number; spendablePoints: number };
  listPricePoints: number;
  discountedPoints: number;
  orderability: { orderable: boolean; reason: string | null };
  banners: { homeBannerId: string; jumpKind: string }[];
  filters: { episodeBands: { key: string }[]; priceBands: { key: string }[] };
};
const testApi = useTestApi();
let api: TestApi,
  owner: SignedInMerchant,
  clerk: SignedInMerchant,
  storeId: string,
  entityId: string,
  dramaId: string,
  draftId: string;
beforeAll(async () => {
  api = await testApi.start();
  await seedUserAgreements(testApi, api);
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  owner = await signInAsMerchant(api);
  const created = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  ({ storeId, entityId } = created);
  const db = await testApi.db.prisma(),
    make = createFactories({ db, clock: api.clock });
  clerk = await signInAsMerchant(api);
  const member = await make.entityMember({ entityId, merchantUserId: clerk.merchantUserId });
  await make.storeMember({ entityMemberId: member.id, storeId, addedByMemberId: created.memberId });
  const staff = await make.staff({ staffRoleKey: "content_ops" });
  await seedDemoContent(
    {
      tx: api.runtime.tx,
      clock: api.clock,
      content: api.runtime.content,
      media: api.runtime.media,
      appEnv: "test",
    },
    staff.id,
  );
  await api.runtime.config.cache.bump("dict");
  const previous = await db.siteConfigRevision.findFirstOrThrow({
      where: { configKey: "mall", status: "published" },
    }),
    content = MallConfigSchema.parse(previous.content);
  await db.siteConfigRevision.update({ where: { id: previous.id }, data: { status: "archived" } });
  await db.siteConfigRevision.create({
    data: {
      id: uuidv7(),
      configKey: "mall",
      revNo: 2,
      status: "published",
      publishedAt: api.clock.now(),
      createdAt: api.clock.now(),
      updatedAt: api.clock.now(),
      content: {
        ...content,
        categories: [
          ...content.categories,
          { key: "urban", name: "都市", genreCodes: ["G01"], visible: true, fixed: false },
        ],
        sorts: content.sorts.filter((sort) => sort !== "heat"),
        filters: {
          ...content.filters,
          episodes: true,
          price: true,
          episodeBands: [{ key: "short", label: "50集以内", min: 1, max: 50 }],
          priceBands: [{ key: "low", label: "2500积分以内", min: 0, max: 2500 }],
        },
      },
    },
  });
  await api.runtime.config.cache.bump("site");
  dramaId = (await db.drama.findFirstOrThrow({ where: { heatTier: "S" } })).id;
  draftId = (
    await api.runtime.tx.run((tx) =>
      api.runtime.content.createDraft(
        tx,
        createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
        { title: "未过校验" },
      ),
    )
  ).id;
}, 180000);
async function get(path: string, headers: Record<string, string> = {}) {
  const response = await api.request(`/api/v1${path}`, { headers });
  return { response, body: (await response.json()) as { error?: string; data: TestData } };
}
it("游客、店员、当前店老板与带其他店的老板：观察者和裁剪来自同一请求事实", async () => {
  for (const [headers, role] of [
    [{}, "guest"],
    [clerk.withStore(storeId), "clerk"],
    [owner.withStore(storeId), "owner"],
    [owner.withStore(uuidv7()), "guest"],
  ] as const) {
    const list = await get("/m/dramas", headers);
    expect(list.response.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data.viewerRole).toBe(role);
    expect(list.response.headers.get("cache-control")).toBe("no-store");
    expect(list.body.data.items).toHaveLength(3);
    expect(list.body.data.items[0]!).toHaveProperty("listPricePoints");
    expect(list.body.data.items[0]!).not.toHaveProperty("licenseEndDate");
    expect("discountedPoints" in list.body.data.items[0]!).toBe(role === "owner");
    if (role === "owner") expect(list.body.data.items[0]!.discountedPoints).toBeNull();
    const detail = await get(`/m/dramas/${dramaId}`, headers);
    expect(detail.response.status, JSON.stringify(detail.body)).toBe(200);
    expect("owner" in detail.body.data).toBe(role === "owner");
    expect(detail.response.headers.get("cache-control")).toBe("no-store");
    if (role === "clerk") {
      expect(() => clerkVisibleKeys("m.drama.list", list.body.data)).not.toThrow();
      expect(() => clerkVisibleKeys("m.drama.get", detail.body.data)).not.toThrow();
    }
  }
  const home = await get("/m/home", clerk.withStore(storeId));
  expect(home.response.headers.get("cache-control")).toBe("no-store");
  expect(Object.keys(home.body.data).sort()).toEqual(["banners", "city", "viewerRole"]);
  expect(() => clerkVisibleKeys("m.home.get", home.body.data)).not.toThrow();
  const mallConfig = await get("/m/mall-config");
  expect(() => clerkVisibleKeys("m.mallConfig.get", mallConfig.body.data)).not.toThrow();
});
it("生效周期折后实扣和owner财务读真实账本，无周期null", async () => {
  const db = await testApi.db.prisma(),
    h = createLedgerHarness(db, { clock: api.clock });
  await openTerm(h, { entityId });
  const { response, body } = await get(`/m/dramas/${dramaId}`, owner.withStore(storeId));
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.data.owner.discountBp).toBe(9000);
  expect(body.data.discountedPoints).toBe(body.data.listPricePoints * 0.9);
  expect(body.data.owner.spendablePoints).toBeGreaterThan(0);
});
it("分类/题材/行业/集数档/价格档、排序配置和游标，不重不漏，坏快照回第一页", async () => {
  const config = (await get("/m/mall-config")).body.data;
  for (const [query, count] of [
    ["category=urban", 1],
    ["genreCodes=G01", 1],
    ["industryCodes=C01", 1],
    [`episodeBand=${config.filters.episodeBands[0]!.key}`, 2],
    [`priceBand=${config.filters.priceBands[0]!.key}`, 2],
  ] as const) {
    const result = await get(`/m/dramas?${query}`);
    expect(result.response.status).toBe(200);
    expect(result.body.data.items).toHaveLength(count);
    if (count === 1) expect(result.body.data.items[0]!.dramaId).toBe(dramaId);
    else expect(result.body.data.items.map((row) => row.dramaId)).not.toContain(dramaId);
  }
  for (const query of [
    "sort=bad",
    "sort=heat",
    "episodeBand=missing",
    "priceBand=missing",
    "category=missing",
    "genreCodes=NONE",
  ])
    expect((await get(`/m/dramas?${query}`)).response.status).toBe(400);
  const first = (await get("/m/dramas?sort=price_asc&limit=1")).body.data,
    second = (await get(`/m/dramas?sort=price_asc&limit=1&cursor=${first.nextCursor}`)).body.data,
    third = (await get(`/m/dramas?sort=price_asc&limit=1&cursor=${second.nextCursor}`)).body.data;
  expect(
    new Set([...first.items, ...second.items, ...third.items].map((row) => row.dramaId)).size,
  ).toBe(3);
  expect([
    first.items[0]!.listPricePoints,
    second.items[0]!.listPricePoints,
    third.items[0]!.listPricePoints,
  ]).toEqual(
    [...first.items, ...second.items, ...third.items]
      .map((row) => row.listPricePoints)
      .sort((a, b) => a - b),
  );
  expect(
    (await get("/m/dramas?sort=price_asc&limit=1&cursor=bad")).body.data.items[0]!.dramaId,
  ).toBe(first.items[0]!.dramaId);
});
it("Banner按生效窗口/顺序取5条；失效对象、未知路由与错误参数不下发", async () => {
  const db = await testApi.db.prisma(),
    poster = await db.drama.findUniqueOrThrow({ where: { id: dramaId } }),
    staff = await db.staff.findFirstOrThrow();
  const entries = [
      { jumpKind: "page", jumpTarget: { route: "missing.route", params: {} } },
      { jumpKind: "page", jumpTarget: { route: "wallet.home", params: { storeId } } },
      { jumpKind: "drama", jumpTarget: { dramaId: draftId } },
      { jumpKind: "page", jumpTarget: { route: "order.detail", params: { orderId: dramaId } } },
      { jumpKind: "page", jumpTarget: { route: "wallet.home", params: {} } },
      { jumpKind: "mall", jumpTarget: { categoryKey: "all" } },
      { jumpKind: "drama", jumpTarget: { dramaId } },
      { jumpKind: "none", isEnabled: false },
      { jumpKind: "none", startAt: new Date("2026-01-06T04:00:00Z") },
      { jumpKind: "none", endAt: api.clock.now() },
      ...Array.from({ length: 6 }, () => ({ jumpKind: "none" })),
    ],
    ids = entries.map(() => uuidv7());
  for (const [position, entry] of entries.entries())
    await db.homeBanner.create({
      data: {
        id: ids[position]!,
        title: `Banner${position}`,
        imageFileId: poster.posterFileId!,
        startAt: new Date("2026-01-01T04:00:00Z"),
        position,
        createdByStaffId: staff.id,
        createdAt: api.clock.now(),
        updatedAt: api.clock.now(),
        ...entry,
      },
    });
  const home = await get("/m/home");
  expect(home.response.status, JSON.stringify(home.body)).toBe(200);
  expect(home.body.data.banners.map((row) => row.homeBannerId)).toEqual([
    ids[4],
    ids[5],
    ids[6],
    ids[10],
    ids[11],
  ]);
});
it("草稿不在列表/首页且详情404，停止订购日起消失但详情可取", async () => {
  expect((await get(`/m/dramas/${draftId}`)).response.status).toBe(404);
  const list = (await get("/m/dramas")).body.data;
  expect(list.items.map((row) => row.dramaId)).not.toContain(draftId);
  const home = (await get("/m/home")).body.data;
  expect([...home.hot, ...home.new].map((row) => row.dramaId)).not.toContain(draftId);
  api.clock.set(new Date("2027-10-05T04:00:00Z"));
  expect((await get("/m/dramas")).body.data.items).toEqual([]);
  const detail = await get(`/m/dramas/${dramaId}`);
  expect(detail.response.status).toBe(200);
  expect(detail.body.data.orderability).toEqual({ orderable: false, reason: "stopped" });
});
