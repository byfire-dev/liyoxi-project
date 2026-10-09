import { createCodecDemoMasterPreparer } from "@liyoxi/services/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { HomeBannerMutationSchema, SiteConfigViewSchema, MallConfigSchema } from "@liyoxi/contract";
import type { SiteConfigView, HomeBannerItem } from "@liyoxi/contract";
import {
  runSeed,
  uuidv7,
  createNotices,
  createIdentityContext,
  seedDemoContent,
} from "@liyoxi/services";
import {
  createFactories,
  signInAsStaff,
  snapshotTables,
  installSitePurchasePolicy,
} from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import { merchantServicesOf } from "../src/merchant/services.js";
import type { TestApi } from "../src/testing/index.js";
const handle = useTestApi();
let app: TestApi, admin: SignedInStaff, editor: SignedInStaff, imageId: string, dramaId: string;
const calls = new Set<string>();
async function request(
  operation: string,
  path: string,
  method = "GET",
  json?: unknown,
  key = uuidv7(),
  actor = admin,
) {
  calls.add(operation);
  return app.request(`/api/v1${path}`, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { ...actor.headers, ...(method === "GET" ? {} : { "Idempotency-Key": key }) },
  });
}
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
const path = "/admin/site-configs/mall";
const current = () => request("admin.siteConfig.get", path).then(data<SiteConfigView>);
const makeBanner = (title: string, startOffset = 0, endOffset: number | null = 60000) => ({
  title,
  imageFileId: imageId,
  jumpKind: "none",
  jumpTarget: null,
  startAt: new Date(app.clock.now().getTime() + startOffset).toISOString(),
  endAt: endOffset === null ? null : new Date(app.clock.now().getTime() + endOffset).toISOString(),
});
beforeAll(async () => {
  app = await handle.start();
  await runSeed({ tx: app.runtime.tx, clock: app.clock });
  const db = await handle.db.prisma(),
    make = createFactories({ db, clock: app.clock });
  admin = await signInAsStaff(db, { roleKey: "super_admin" });
  editor = await signInAsStaff(db, { roleKey: "editor" });
  imageId = (await make.fileObject({ category: "banner" })).id;
  const staff = await make.staff({ staffRoleKey: "content_ops" });
  await seedDemoContent(
    {
      tx: app.runtime.tx,
      clock: app.clock,
      content: app.runtime.content,
      prepareMasters: createCodecDemoMasterPreparer({
        appEnv: "test",
        tx: app.runtime.tx,
        clock: app.clock,
        media: app.runtime.media,
        events: app.runtime.events,
      }),
      media: app.runtime.media,
      appEnv: "test",
    },
    staff.id,
  );
  await app.runtime.config.cache.bump("dict");
  dramaId = (await db.drama.findFirstOrThrow({ where: { status: "listed" } })).id;
}, 180000);
describe("W3-11 正式站点11API", { timeout: 120000 }, () => {
  it("草稿版本、发布真实唯一状态与双版本冲突；幂等不二次发布", async () => {
    const original = SiteConfigViewSchema.parse(await current()),
      content = MallConfigSchema.parse(original.published.content);
    const saved = await data<SiteConfigView>(
      await request("admin.siteConfig.draft.replace", `${path}/draft`, "PUT", {
        content: { ...content, hotWords: ["正式热词"] },
        baseRevNo: original.published.revNo,
        lockVersion: null,
      }),
    );
    expect(saved.draft?.lockVersion).toBe(0);
    expect((await app.runtime.config.siteConfig.published("mall"))?.content.hotWords).not.toContain(
      "正式热词",
    );
    const wrong = await request("admin.siteConfig.publish", `${path}/publish`, "POST", {
      lockVersion: 999,
      baseRevNo: original.published.revNo,
    });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ error: "VERSION_CONFLICT" });
    const stale = await request("admin.siteConfig.publish", `${path}/publish`, "POST", {
      lockVersion: 0,
      baseRevNo: original.published.revNo + 1,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "CONFIG_REV_CONFLICT" });
    const key = uuidv7(),
      published = await data<SiteConfigView>(
        await request(
          "admin.siteConfig.publish",
          `${path}/publish`,
          "POST",
          { lockVersion: 0, baseRevNo: original.published.revNo },
          key,
        ),
      );
    expect(published.published.revNo).toBe(original.published.revNo + 1);
    expect(published.draft).toBeNull();
    await data(
      await request(
        "admin.siteConfig.publish",
        `${path}/publish`,
        "POST",
        { lockVersion: 0, baseRevNo: original.published.revNo },
        key,
      ),
    );
    expect((await app.runtime.config.siteConfig.published("mall"))?.content.hotWords).toEqual([
      "正式热词",
    ]);
    const db = await handle.db.prisma();
    expect(
      await db.siteConfigRevision.count({ where: { configKey: "mall", status: "published" } }),
    ).toBe(1);
    expect(
      await db.siteConfigRevision.count({ where: { configKey: "mall", status: "archived" } }),
    ).toBe(1);
    expect(
      (
        await data<{ items: unknown[] }>(
          await request("admin.siteConfig.revision.list", `${path}/revisions`),
        )
      ).items,
    ).toHaveLength(2);
  });
  it("并发首存唯一草稿；当前字典失效引用允许草稿而拒绝发布", async () => {
    const currentView = await current(),
      content = MallConfigSchema.parse(currentView.published.content);
    const input = {
      content: {
        ...content,
        categories: [
          ...content.categories,
          { key: "unknown", name: "无题材", genreCodes: ["unknown"], visible: true, fixed: false },
        ],
      },
      baseRevNo: currentView.published.revNo,
      lockVersion: null,
    };
    const results = await Promise.all([
      request("admin.siteConfig.draft.replace", `${path}/draft`, "PUT", input),
      request("admin.siteConfig.draft.replace", `${path}/draft`, "PUT", input),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const view = await current();
    expect(view.refs.invalidRefs).toContainEqual(
      expect.objectContaining({ reason: "genre_unknown", code: "unknown" }),
    );
    const invalid = await request("admin.siteConfig.publish", `${path}/publish`, "POST", {
      lockVersion: view.draft!.lockVersion,
      baseRevNo: view.published.revNo,
    });
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toMatchObject({ error: "CONFIG_REF_INVALID" });
    const db = await handle.db.prisma();
    expect(
      await db.siteConfigRevision.count({ where: { configKey: "mall", status: "draft" } }),
    ).toBe(1);
  });
  it("Banner图片真link，签名只在首成功，重放null；乐观锁与换图180天", async () => {
    const input = makeBanner("换图"),
      key = uuidv7();
    const first = HomeBannerMutationSchema.parse(
      await data(
        await request("admin.homeBanner.create", "/admin/home-banners", "POST", input, key),
      ),
    );
    expect(first.imageUrl?.url).toBeTruthy();
    expect(first.replayed).toBe(false);
    const replay = HomeBannerMutationSchema.parse(
      await data(
        await request("admin.homeBanner.create", "/admin/home-banners", "POST", input, key),
      ),
    );
    expect(replay.imageUrl).toBeNull();
    expect(replay.replayed).toBe(true);
    const db = await handle.db.prisma(),
      newImage = (
        await createFactories({ db, clock: app.clock }).fileObject({ category: "banner" })
      ).id;
    const updated = await data<HomeBannerItem>(
      await request(
        "admin.homeBanner.update",
        `/admin/home-banners/${first.homeBannerId}`,
        "PATCH",
        { lockVersion: first.lockVersion, imageFileId: newImage },
      ),
    );
    expect(updated.lockVersion).toBe(1);
    const ref = await db.fileRef.findFirstOrThrow({
      where: { refType: "home_banner", refId: first.homeBannerId, fileId: imageId },
    });
    expect(ref.state).toBe("released");
    expect(ref.keepUntil?.getTime()).toBeGreaterThanOrEqual(
      app.clock.now().getTime() + 180 * 86400000,
    );
    expect(
      await db.fileRef.count({
        where: {
          refType: "home_banner",
          refId: first.homeBannerId,
          fileId: newImage,
          state: "live",
        },
      }),
    ).toBe(1);
    const stale = await request(
      "admin.homeBanner.update",
      `/admin/home-banners/${first.homeBannerId}`,
      "PATCH",
      { lockVersion: 0, title: "旧修改" },
    );
    expect(stale.status).toBe(409);
  });
  it("容量包括未来重叠，咨询锁串行两次竞争；端点相接可接受", async () => {
    const start = 120000,
      end = 180000;
    for (let i = 0; i < 4; i++)
      await data(
        await request(
          "admin.homeBanner.create",
          "/admin/home-banners",
          "POST",
          makeBanner(`未来${i}`, start, end),
        ),
      );
    const results = await Promise.all([
      request(
        "admin.homeBanner.create",
        "/admin/home-banners",
        "POST",
        makeBanner("竞争甲", start, end),
      ),
      request(
        "admin.homeBanner.create",
        "/admin/home-banners",
        "POST",
        makeBanner("竞争乙", start, end),
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await results.find((r) => r.status === 409)!.json()).toMatchObject({
      error: "BANNER_LIMIT_EXCEEDED",
    });
    await data(
      await request(
        "admin.homeBanner.create",
        "/admin/home-banners",
        "POST",
        makeBanner("接续", end, end + 60000),
      ),
    );
  });
  it("reorder须含停用未结束行，真实位置不增lockVersion，C50数组重放null", async () => {
    const list = await data<{ items: HomeBannerItem[] }>(
      await request("admin.homeBanner.list", "/admin/home-banners?isEnded=false"),
    );
    const ids = list.items.map((row) => row.homeBannerId).reverse(),
      versions = new Map(list.items.map((row) => [row.homeBannerId, row.lockVersion]));
    const stale = await request(
      "admin.homeBanner.batchReorder",
      "/admin/home-banners/reorder",
      "POST",
      { homeBannerIds: ids.slice(1) },
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "BANNER_ORDER_STALE" });
    const key = uuidv7(),
      body = { homeBannerIds: ids };
    const reordered = await data<{ items: HomeBannerItem[] }>(
      await request(
        "admin.homeBanner.batchReorder",
        "/admin/home-banners/reorder",
        "POST",
        body,
        key,
      ),
    );
    expect(reordered.items.map((row) => row.homeBannerId)).toEqual(ids);
    expect(reordered.items.every((row) => row.lockVersion === versions.get(row.homeBannerId))).toBe(
      true,
    );
    const replay = await data<{ items: HomeBannerItem[]; replayed: boolean }>(
      await request(
        "admin.homeBanner.batchReorder",
        "/admin/home-banners/reorder",
        "POST",
        body,
        key,
      ),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.items.every((row) => row.imageUrl === null)).toBe(true);
    expect(
      (
        await data<{ maxActive: number }>(
          await request("admin.homeBanner.summary", "/admin/home-banners/summary"),
        )
      ).maxActive,
    ).toBe(5);
  });
  it("所有GET零业务写，ops之外的编辑者拒绝；公告读取只读真实记录", async () => {
    const db = await handle.db.prisma(),
      before = await snapshotTables(db, [
        "site_config_revision",
        "home_banner",
        "file_ref",
        "audit_log",
      ]);
    await current();
    await data(await request("admin.homeBanner.list", "/admin/home-banners"));
    await data(await request("admin.homeBanner.summary", "/admin/home-banners/summary"));
    await data(await request("admin.siteNotice.list", "/admin/site-notices"));
    expect(
      await snapshotTables(db, ["site_config_revision", "home_banner", "file_ref", "audit_log"]),
    ).toEqual(before);
    expect(
      (
        await request(
          "admin.homeBanner.create",
          "/admin/home-banners",
          "POST",
          makeBanner("越权"),
          uuidv7(),
          editor,
        )
      ).status,
    ).toBe(403);
    await app.runtime.tx.run((tx) =>
      createNotices({ clock: app.clock, events: app.runtime.events }).announce(
        tx,
        createIdentityContext({ actor: { type: "staff", id: admin.staff.id, client: "admin" } }),
        {
          kind: "billing_param",
          refId: uuidv7(),
          title: "调整",
          summary: "含价格摘要",
          summaryNoPrice: "无价格摘要",
          effectiveAt: new Date(app.clock.now().getTime() + 86400000),
          createdByStaffId: admin.staff.id,
          link: { route: "wallet.home", params: {} },
        },
      ),
    );
    const notices = await data<{ items: { title: string }[] }>(
      await request("admin.siteNotice.list", "/admin/site-notices?displayState=scheduled"),
    );
    expect(notices.items.some((row) => row.title === "调整")).toBe(true);
  });
  it("真实60秒快照跨查询复用，过期游标重置，停订不泄露缓存", async () => {
    const first = await data<{ items: { dramaId: string }[]; nextCursor: string }>(
      await app.request("/api/v1/m/dramas?limit=1"),
    );
    const repeated = await data<{ items: { dramaId: string }[]; nextCursor: string }>(
      await app.request("/api/v1/m/dramas?limit=1"),
    );
    expect(repeated.nextCursor).toBe(first.nextCursor);
    const page2 = await data<{ items: { dramaId: string }[] }>(
      await app.request(`/api/v1/m/dramas?limit=1&cursor=${first.nextCursor}`),
    );
    expect(page2.items[0]!.dramaId).not.toBe(first.items[0]!.dramaId);
    app.clock.advance(60001);
    const reset = await data<{ items: { dramaId: string }[] }>(
      await app.request(`/api/v1/m/dramas?limit=1&cursor=${first.nextCursor}`),
    );
    expect(reset.items[0]!.dramaId).toBe(first.items[0]!.dramaId);
    const getBanners = () =>
      app.request("/api/v1/m/home").then(data<{ banners: { title: string }[] }>);
    expect((await getBanners()).banners.some((row) => row.title.startsWith("未来"))).toBe(false);
    app.clock.advance(60000);
    expect((await getBanners()).banners.some((row) => row.title.startsWith("未来"))).toBe(true);
    app.clock.advance(60000);
    expect((await getBanners()).banners.some((row) => row.title.startsWith("未来"))).toBe(false);
    expect((await getBanners()).banners.some((row) => row.title === "接续")).toBe(true);
    const db = await handle.db.prisma(),
      stopped = first.items[0]!.dramaId;
    // 故障注入：现有内容状态在缓存有效期内变化，下一GET必须用当前可见谓词。
    await db.drama.update({
      where: { id: stopped },
      data: {
        status: "delisted",
        statusChangedAt: app.clock.now(),
        delistedAt: app.clock.now(),
        delistReasonCode: "ops_strategy",
      },
    });
    const fresh = await data<{ items: { dramaId: string }[] }>(
      await app.request("/api/v1/m/dramas"),
    );
    expect(fresh.items.some((row) => row.dramaId === stopped)).toBe(false);
  });
  it("行业品类精确兜底与参数关闭；老板/店员当前关系裁剪", async () => {
    const industry = await app.runtime.config.dicts.list("industry"),
      category = industry.items.find(
        (row) => row.isEnabled && row.isSelectable && row.parentCode && row.name === "饮品",
      );
    expect(category).toBeTruthy();
    const q = encodeURIComponent(category!.name),
      fallback = await data<{ mode: string; fallbackIndustry: { code: string } | null }>(
        await app.request(`/api/v1/m/dramas/search?q=${q}`),
      );
    expect(fallback.mode).toBe("industry_fallback");
    expect(fallback.fallbackIndustry?.code).toBe(category!.parentCode);
    await data(
      await request("admin.paramValue.replace", "/admin/param-values", "PUT", {
        items: [
          {
            key: "catalog.search.industry_fallback",
            value: false,
            expectedRev: null,
            effectiveAt: app.clock.now().toISOString(),
          },
        ],
        reason: "隔离关闭",
      }),
    );
    const off = await data<{ mode: string; items: unknown[] }>(
      await app.request(`/api/v1/m/dramas/search?q=${q}`),
    );
    expect(off.mode).toBe("match");
    expect(off.items).toHaveLength(0);
  });
  it("真实公告mode读取当前设备策略，旧M1协议link按真实版本归一、错ref/撤回不入首页", async () => {
    await seedUserAgreements(handle, app);
    const db = await handle.db.prisma(),
      owner = await signInAsMerchant(app),
      scope = await merchantServicesOf(app.runtime).tenant.createEntity(
        createIdentityContext({
          actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
        }),
      );
    const make = createFactories({ db, clock: app.clock }),
      clerk = await signInAsMerchant(app),
      member = await make.entityMember({
        entityId: scope.entityId,
        merchantUserId: clerk.merchantUserId,
      });
    await make.storeMember({
      entityMemberId: member.id,
      storeId: scope.storeId,
      addedByMemberId: scope.memberId,
    });
    const at = app.clock.now();
    await installSitePurchasePolicy(db, app.runtime, [
      { when: { platforms: ["ios"] }, then: { mode: "offline_contract" } },
      { when: { platforms: ["android"] }, then: { mode: "hidden" } },
    ]);
    const getHome = (actor = owner, platform = "ios") =>
      app
        .request("/api/v1/m/home", {
          headers: { ...actor.withStore(scope.storeId), "X-Client-Platform": platform },
        })
        .then(
          data<{
            noticeBar?: {
              siteNoticeId: string;
              summary: string;
              link: { route: string; params: { key?: string } };
            } | null;
          }>,
        );
    expect((await getHome()).noticeBar?.summary).toBe("无价格摘要");
    expect((await getHome(owner, "android")).noticeBar).toBeNull();
    expect((await getHome(clerk)).noticeBar).toBeUndefined();
    app.clock.advance(1);
    const notice = await app.runtime.tx.run((tx) =>
      createNotices({ clock: app.clock, events: app.runtime.events }).announce(
        tx,
        createIdentityContext({ actor: { type: "staff", id: admin.staff.id, client: "admin" } }),
        {
          kind: "agreement_version",
          refId: uuidv7(),
          title: "旧协议公告",
          summary: "合法旧摘要",
          effectiveAt: new Date(at.getTime() + 86400000),
          createdByStaffId: admin.staff.id,
          link: { route: "agreement.version", params: { agreementVersionId: uuidv7() } },
        },
      ),
    );
    const row = await db.siteNotice.findUniqueOrThrow({ where: { id: notice.siteNoticeId } });
    await make.agreementVersion({
      id: row.refId,
      agreementKey: "member",
      status: "pending",
      siteNoticeId: row.id,
      effectiveAt: new Date(at.getTime() + 86400000),
    });
    expect((await getHome()).noticeBar?.link).toEqual({
      route: "agreement.view",
      params: { key: "member" },
    });
    expect(
      (
        await data<{ items: { siteNoticeId: string; link: { route: string } }[] }>(
          await request("admin.siteNotice.list", "/admin/site-notices"),
        )
      ).items.find((item) => item.siteNoticeId === row.id)?.link.route,
    ).toBe("agreement.view");
    await db.agreementVersion.update({
      where: { id: row.refId },
      data: { status: "withdrawn", updatedAt: app.clock.now() },
    });
    await db.siteNotice.update({
      where: { id: row.id },
      data: {
        status: "withdrawn",
        withdrawnByStaffId: admin.staff.id,
        withdrawnAt: app.clock.now(),
        updatedAt: app.clock.now(),
      },
    });
    expect((await getHome()).noticeBar?.siteNoticeId).not.toBe(row.id);
    app.clock.advance(1);
    const wrong = await app.runtime.tx.run((tx) =>
      createNotices({ clock: app.clock, events: app.runtime.events }).announce(
        tx,
        createIdentityContext({ actor: { type: "staff", id: admin.staff.id, client: "admin" } }),
        {
          kind: "agreement_version",
          refId: uuidv7(),
          title: "错引用",
          summary: "不展示",
          effectiveAt: new Date(app.clock.now().getTime() + 86400000),
          createdByStaffId: admin.staff.id,
          link: { route: "agreement.view", params: { key: "member" } },
        },
      ),
    );
    expect(wrong.created).toBe(true);
    expect((await getHome()).noticeBar).toBeNull();
    const all = await data<{
      items: { siteNoticeId: string; link: { route: string } }[];
      total: number;
    }>(await request("admin.siteNotice.list", "/admin/site-notices"));
    expect(all.items.find((item) => item.siteNoticeId === wrong.siteNoticeId)?.link).toEqual({
      route: "agreement.view",
      params: { key: "member" },
    });
    expect(all.total).toBe(await db.siteNotice.count());
  });
  it("search实际HTTP先于动态id，三字段与游客裁剪；坏词拒绝", async () => {
    const q = "浪漫";
    const response = await app.request(`/api/v1/m/dramas/search?q=${encodeURIComponent(q)}`);
    calls.add("m.drama.search");
    const result = await data<{
      viewerRole: string;
      mode: string;
      items: { dramaId: string; matchedFields: string[]; discountedPoints?: number }[];
    }>(response);
    expect(result.viewerRole).toBe("guest");
    expect(result.mode).toBe("match");
    expect(result.items.length).toBeGreaterThan(0);
    expect(
      result.items.every(
        (row) => row.matchedFields.length > 0 && row.discountedPoints === undefined,
      ),
    ).toBe(true);
    const byTitle = await data<{ items: { title: string; matchedFields: string[] }[] }>(
      await app.request(`/api/v1/m/dramas/search?q=${encodeURIComponent("花·店")}`),
    );
    expect(byTitle.items[0]).toMatchObject({ title: "重逢在花店", matchedFields: ["title"] });
    const byCast = await data<{ items: { matchedFields: string[] }[] }>(
      await app.request(`/api/v1/m/dramas/search?q=${encodeURIComponent("演示演员")}`),
    );
    expect(byCast.items.length).toBe(2);
    expect(byCast.items.every((row) => row.matchedFields.includes("cast"))).toBe(true);
    const longerGenre = await data<{ items: { matchedFields: string[] }[] }>(
      await app.request(`/api/v1/m/dramas/search?q=${encodeURIComponent("浪漫爱情故事")}`),
    );
    expect(longerGenre.items[0]!.matchedFields).toContain("genre");
    expect((await app.request("/api/v1/m/dramas/search?q=%C2%B7")).status).toBe(400);
    expect(dramaId).toBeTruthy();
    calls.delete("admin.paramValue.replace");
    expect([...calls].sort()).toEqual(
      [
        "admin.homeBanner.batchReorder",
        "admin.homeBanner.create",
        "admin.homeBanner.list",
        "admin.homeBanner.summary",
        "admin.homeBanner.update",
        "admin.siteConfig.draft.replace",
        "admin.siteConfig.get",
        "admin.siteConfig.publish",
        "admin.siteConfig.revision.list",
        "admin.siteNotice.list",
        "m.drama.search",
      ].sort(),
    );
  });
});
