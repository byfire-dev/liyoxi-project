import { createCodecDemoMasterPreparer } from "@liyoxi/services/testing";
// W310 nine real routes, including required replay/C50 and read-only pricing metadata.
import { beforeAll, expect, it } from "vitest";
import { createIdentityContext, runSeed, seedDemoContent, uuidv7 } from "@liyoxi/services";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import type {
  AdminDramaDetail,
  CopyrightRevisionCreateResult,
  DramaPriceCreateResult,
  DramaPricePage,
  DramaPriceSummary,
  DramaPriceRevisionPage,
  PriceTierList,
} from "@liyoxi/contract";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff, FakeStorage } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
const handle = useTestApi();
let app: TestApi,
  prisma: Awaited<ReturnType<typeof handle.db.prisma>>,
  supervisor: SignedInStaff,
  editor: SignedInStaff,
  finance: SignedInStaff;
let make: ReturnType<typeof createFactories>;
const root = "/api/v1/admin";
async function data<T>(res: Response): Promise<T> {
  const body = await res.clone().text();
  expect(
    res.status,
    JSON.stringify({
      body,
      errors:
        res.status >= 500 ? app.logs.filter((entry) => entry.evt === "http.error").slice(-1) : [],
    }),
  ).toBe(200);
  return ((await res.json()) as { data: T }).data;
}
const post = (path: string, body: unknown, session = supervisor, key: string | null = uuidv7()) =>
  app.request(root + path, {
    method: "POST",
    json: body,
    headers: { ...session.headers, ...(key ? { "Idempotency-Key": key } : {}) },
  });
const put = (path: string, body: unknown, session = supervisor, key: string | null = uuidv7()) =>
  app.request(root + path, {
    method: "PUT",
    json: body,
    headers: { ...session.headers, ...(key ? { "Idempotency-Key": key } : {}) },
  });
const ctx = () =>
  createIdentityContext({ actor: { type: "staff", id: supervisor.staff.id, client: "admin" } });
async function draft() {
  return app.runtime.tx.run((tx) =>
    app.runtime.content.createDraft(tx, ctx(), { title: "版权接口测试" }),
  );
}
async function proof() {
  return make.fileObject({
    category: "drama_license_doc",
    bucket: "secure",
    ext: "pdf",
    mime: "application/pdf",
    moderationState: "none",
  });
}
const snapshot = (id: string) => ({
  source: "licensed",
  platforms: ["douyin", "wechat_channels"],
  territory: "中国大陆",
  hasNetworkRight: true,
  canSublicense: true,
  canEditEmbed: true,
  canAdapt: true,
  licenseStartDate: "2026-01-01",
  licenseEndDate: "2028-01-01",
  proofFileIds: [id],
});
beforeAll(async () => {
  app = await handle.start();
  prisma = await handle.db.prisma();
  await runSeed({ tx: app.runtime.tx, clock: app.clock });
  supervisor = await signInAsStaff(prisma, { roleKey: "super_admin" });
  editor = await signInAsStaff(prisma, { roleKey: "editor" });
  finance = await signInAsStaff(prisma, { roleKey: "finance" });
  make = createFactories({ db: prisma, clock: app.clock });
}, 180000);
it("admin.drama.copyright.replace 真required/自身版本/C50：首次签名，持久结果无URL，重放null且无额外签名", async () => {
  const d = await draft(),
    file = await proof(),
    poster = await make.fileObject({
      category: "poster",
      bucket: "pub",
      ext: "png",
      mime: "image/png",
      moderationState: "pass",
    });
  await prisma.drama.update({ where: { id: d.id }, data: { posterFileId: poster.id } });
  const body = { ...snapshot(file.id), lockVersion: 0 },
    path = `/dramas/${d.id}/copyright`,
    key = uuidv7();
  expect((await put(path, body, supervisor, null)).status).toBe(400);
  expect((await put(path, body, editor)).status).toBe(403);
  const storage = app.runtime.providers.storage as FakeStorage,
    before = storage.callsOf("presignGet").length;
  const first = await data<AdminDramaDetail>(await put(path, body, supervisor, key));
  expect(first.copyright.lockVersion).toBe(1);
  expect(first.copyright.proofFiles[0]).toMatchObject({
    status: "stored",
    moderationState: "none",
  });
  expect(first.lockVersion).toBe(0);
  expect(first.posterUrl?.url).toContain("http");
  const cached = await prisma.idempotencyRecord.findFirstOrThrow({
    where: { scope: "admin.drama.copyright.replace", key },
  });
  expect(cached.result).toMatchObject({ posterUrl: null });
  expect(JSON.stringify(cached.result)).not.toMatch(/https?:/);
  const after = storage.callsOf("presignGet").length;
  expect(after).toBeGreaterThan(before);
  const replay = await put(path, body, supervisor, key);
  expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
  expect((await data<AdminDramaDetail>(replay)).posterUrl).toBeNull();
  expect(storage.callsOf("presignGet")).toHaveLength(after);
  expect(await (await put(path, body)).json()).toMatchObject({ error: "VERSION_CONFLICT" });
  expect(
    await prisma.auditLog.count({
      where: { targetId: d.id, action: "content.drama.copyright_update" },
    }),
  ).toBe(1);
});
it("admin.drama.confirmPermitRecheck only真实true、required与幂等；revision入口不能替代草稿", async () => {
  const d = await draft();
  await prisma.drama.update({ where: { id: d.id }, data: { isPermitRecheckRequired: true } });
  const path = `/dramas/${d.id}/confirm-permit-recheck`,
    key = uuidv7();
  expect((await post(path, { note: null }, finance)).status).toBe(403);
  const first = await data<AdminDramaDetail>(
    await post(path, { note: "已核许可" }, supervisor, key),
  );
  expect(first.isPermitRecheckRequired).toBe(false);
  expect(first.lockVersion).toBe(1);
  expect(
    (await post(path, { note: "已核许可" }, supervisor, key)).headers.get("Idempotent-Replayed"),
  ).toBe("true");
  expect((await post(path, {})).status).toBe(409);
  const file = await proof();
  const res = await post(`/dramas/${d.id}/drama-copyright-revisions`, {
    lockVersion: 0,
    changeKind: "extend",
    copyright: snapshot(file.id),
    reason: "续约",
    revisionProofFileIds: [file.id],
    confirm: { prevEndDate: "2028-01-01" },
  });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: "STATE_NOT_ALLOWED" });
});
it("admin.drama.dramaCopyrightRevision.create 真只增/嵌套C50、确认和缩短拒绝，无重放副作用", async () => {
  const d = await draft(),
    file = await proof(),
    poster = await make.fileObject({
      category: "poster",
      bucket: "pub",
      ext: "png",
      mime: "image/png",
      moderationState: "pass",
    });
  await data(await put(`/dramas/${d.id}/copyright`, { ...snapshot(file.id), lockVersion: 0 }));
  // A valid already-listed history snapshot; this case uses delisted to exercise revision without bypassing listing checks.
  const initial = uuidv7();
  await prisma.dramaCopyrightRevision.create({
    data: {
      id: initial,
      dramaId: d.id,
      changeKind: "initial",
      copyrightSnapshot: snapshot(file.id),
      prevEndDate: null,
      newEndDate: new Date("2028-01-01T00:00:00Z"),
      reason: "首次合法上架",
      proofFileIds: [file.id],
      createdByStaffId: supervisor.staff.id,
      createdAt: app.clock.now(),
    },
  });
  await prisma.dramaCopyright.update({
    where: { dramaId: d.id },
    data: { currentDramaCopyrightRevisionId: initial },
  });
  await prisma.drama.update({
    where: { id: d.id },
    data: {
      status: "delisted",
      firstListedAt: app.clock.now(),
      listedAt: app.clock.now(),
      delistedAt: app.clock.now(),
      delistReasonCode: "ops_strategy",
      posterFileId: poster.id,
    },
  });
  const path = `/dramas/${d.id}/drama-copyright-revisions`,
    body = {
      lockVersion: 1,
      changeKind: "extend",
      copyright: { ...snapshot(file.id), licenseEndDate: "2029-01-01" },
      reason: "合法续约",
      revisionProofFileIds: [file.id],
      confirm: { prevEndDate: "2028-01-01" },
    },
    key = uuidv7();
  const first = await data<CopyrightRevisionCreateResult>(await post(path, body, supervisor, key));
  expect(first.drama.posterUrl?.url).toContain("http");
  expect(first.revision.changeKind).toBe("extend");
  expect(
    (
      await prisma.idempotencyRecord.findFirstOrThrow({
        where: { scope: "admin.drama.dramaCopyrightRevision.create", key },
      })
    ).result,
  ).toMatchObject({ drama: { posterUrl: null } });
  const replay = await data<CopyrightRevisionCreateResult>(await post(path, body, supervisor, key));
  expect(replay.drama.posterUrl).toBeNull();
  expect(await prisma.dramaCopyrightRevision.count({ where: { dramaId: d.id } })).toBe(2);
  const shorten = await post(path, {
    ...body,
    lockVersion: 2,
    changeKind: "shorten",
    copyright: { ...body.copyright, licenseEndDate: "2028-01-01" },
    confirm: { prevEndDate: "2029-01-01" },
  });
  expect(shorten.status).toBe(409);
  expect(await shorten.json()).toMatchObject({
    error: "LICENSE_SHORTEN_NOT_OPEN",
    details: { currentEndDate: "2029-01-01" },
  });
});
it("admin.drama.dramaPriceRevision.create/withdraw 两required路由：当前确认、未来timer、只增撤销和重放一次", async () => {
  const d = await draft();
  await prisma.drama.update({ where: { id: d.id }, data: { heatTier: "A" } });
  const body = {
      mode: "custom",
      customPoints: 1700,
      effectiveDate: "2026-01-07",
      reasonCode: "quality",
      note: null,
      confirm: { currentPoints: 2000 },
    },
    path = `/dramas/${d.id}/drama-price-revisions`,
    key = uuidv7();
  expect((await post(path, body, editor)).status).toBe(403);
  expect((await post(path, body, supervisor, null)).status).toBe(400);
  const first = await data<DramaPriceCreateResult>(await post(path, body, supervisor, key));
  expect(first.revision.state).toBe("pending");
  const id = first.revision.dramaPriceRevisionId;
  expect((await post(path, body, supervisor, key)).headers.get("Idempotent-Replayed")).toBe("true");
  const withdraw = `/drama-price-revisions/${id}/withdraw`,
    wk = uuidv7();
  expect((await post(withdraw, {}, supervisor, null)).status).toBe(400);
  await data(await post(withdraw, { note: "撤回计划" }, supervisor, wk));
  expect(
    (await post(withdraw, { note: "撤回计划" }, supervisor, wk)).headers.get("Idempotent-Replayed"),
  ).toBe("true");
  expect((await prisma.timer.findFirstOrThrow({ where: { subjectId: id } })).status).toBe(
    "cancelled",
  );
  expect(await prisma.dramaPriceRevision.count({ where: { dramaId: d.id } })).toBe(1);
  const mismatch = await post(path, { ...body, confirm: { currentPoints: 999 } });
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({ error: "CONFIRM_MISMATCH" });
});
it("admin.dramaPrice.list/summary、admin.dramaPriceRevision.list、admin.priceTierRevision.list 真DTO/分页/九权限与只读零写", async () => {
  const counts = async () => [
    await prisma.auditLog.count(),
    await prisma.timer.count(),
    await prisma.outboxEvent.count(),
    await prisma.dramaPriceRevision.count(),
  ];
  const before = await counts();
  const list = await data<DramaPricePage>(
    await app.request(root + "/drama-prices?status=draft,delisted&pageSize=1", {
      headers: finance.headers,
    }),
  );
  expect(list.items).toHaveLength(1);
  expect(list.total).toBeGreaterThan(1);
  const summary = await data<DramaPriceSummary>(
    await app.request(root + "/drama-prices/summary", { headers: finance.headers }),
  );
  expect(summary.minLicenseMonths).toBeGreaterThan(0);
  const revisions = await data<DramaPriceRevisionPage>(
    await app.request(root + "/drama-price-revisions", { headers: finance.headers }),
  );
  expect(revisions.items.length).toBeGreaterThan(0);
  const tiers = await data<PriceTierList>(
    await app.request(root + "/price-tier-revisions", { headers: finance.headers }),
  );
  expect(tiers.items.map((row) => row.tier)).toEqual(["S", "A", "B", "C"]);
  expect(await counts()).toEqual(before);
  for (const path of [
    "/drama-prices",
    "/drama-prices/summary",
    "/drama-price-revisions",
    "/price-tier-revisions",
  ]) {
    expect((await app.request(root + path, { headers: editor.headers })).status).toBe(403);
    expect((await app.request(root + path)).status).toBe(401);
  }
});
it("商城60秒home缓存跨午夜价格边界与热度事件，实际SQL priceVersion变更且回包即时新价，无等待timer", async () => {
  app.clock.set(new Date("2026-01-05T04:00:00Z"));
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
    supervisor.staff.id,
  );
  const d = await prisma.drama.findFirstOrThrow({ where: { status: "listed", heatTier: "S" } });
  const read = () => app.request("/api/v1/m/home");
  const future = await data<DramaPriceCreateResult>(
    await post(`/dramas/${d.id}/drama-price-revisions`, {
      mode: "custom",
      customPoints: 3200,
      effectiveDate: "2026-01-06",
      reasonCode: "quality",
      confirm: { currentPoints: 3000 },
    }),
  );
  app.clock.set(new Date("2026-01-05T15:59:59.999Z"));
  type Home = {
    hot: { dramaId: string; listPricePoints: number }[];
    new: { dramaId: string; listPricePoints: number }[];
  };
  const rowOf = (home: Home) => [...home.hot, ...home.new].find((row) => row.dramaId === d.id);
  const before = await data<Home>(await read()),
    versionBefore = (
      await app.runtime.tx.run((tx) => app.runtime.content.visibleCatalog(tx, app.clock.now()))
    ).find((row) => row.id === d.id)!.priceVersion;
  expect(rowOf(before)?.listPricePoints).toBe(3000);
  app.clock.advance(1);
  expect(rowOf(await data<Home>(await read()))?.listPricePoints).toBe(3200);
  const versionAfter = (
    await app.runtime.tx.run((tx) => app.runtime.content.visibleCatalog(tx, app.clock.now()))
  ).find((row) => row.id === d.id)!.priceVersion;
  expect(versionAfter).not.toEqual(versionBefore);
  expect(
    (
      await prisma.timer.findFirstOrThrow({
        where: { subjectId: future.revision.dramaPriceRevisionId },
      })
    ).status,
  ).toBe("scheduled");
  // Crossing midnight expires the original staff session; keep the real session TTL intact.
  supervisor = await signInAsStaff(prisma, { roleKey: "super_admin", now: app.clock.now() });
  // Restore template through the real write path, then apply a real tier fact without bumping site cache.
  app.clock.advance(1);
  await data(
    await post(`/dramas/${d.id}/drama-price-revisions`, {
      mode: "template",
      customPoints: null,
      effectiveDate: null,
      reasonCode: "restore_template",
      confirm: { currentPoints: 3200 },
    }),
  );
  const templateBefore = await data<Home>(await read());
  expect(rowOf(templateBefore)?.listPricePoints).toBe(3000);
  const old = (
    await app.runtime.tx.run((tx) => app.runtime.content.visibleCatalog(tx, app.clock.now()))
  ).find((row) => row.id === d.id)!.priceVersion;
  app.clock.advance(1);
  const event = await app.runtime.tx.run(async (tx) => {
    await tx.drama.update({
      where: { id: d.id },
      data: { heatTier: "A", updatedAt: app.clock.now() },
    });
    return app.runtime.events.emit(tx, ctx(), {
      type: "drama.tier_changed",
      aggregate: { type: "drama", id: d.id },
      payload: { v: 1, dramaId: d.id, fromTier: "S", toTier: "A" },
    });
  });
  const stored = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id! } });
  await app.runtime.tx.run((tx) =>
    app.runtime.assembly.subscriber("billing.onTierChanged")!.handle(tx, {
      id: stored.id,
      type: stored.eventType,
      payload: EVENT_PAYLOAD_SCHEMAS["drama.tier_changed"].parse(stored.payload),
    }),
  );
  const next = (
    await app.runtime.tx.run((tx) => app.runtime.content.visibleCatalog(tx, app.clock.now()))
  ).find((row) => row.id === d.id)!.priceVersion;
  expect(next).not.toEqual(old);
  expect(rowOf(await data<Home>(await read()))?.listPricePoints).toBe(2000);
  expect(
    await prisma.outboxEvent.count({
      where: { aggregateId: d.id, eventType: "pricing.drama_price_changed" },
    }),
  ).toBe(1);
});
