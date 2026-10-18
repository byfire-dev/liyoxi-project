import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runSeed, seedDemoContent, uuidv7 } from "@liyoxi/services";
import {
  createCodecDemoMasterPreparer,
  createFactories,
  signInAsStaff,
} from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import type {
  AdminDramaDetail,
  DramaPermit,
  DramaEpisodeRow,
  ActivityItem,
} from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import { adminDramaHandlers } from "../src/routes/admin/dramas.js";
const h = useTestApi();
let ownConfigDirectory: string | undefined;
afterAll(async () => {
  if (ownConfigDirectory) await rm(ownConfigDirectory, { recursive: true });
});
let app: Awaited<ReturnType<typeof h.start>>, admin: SignedInStaff, editor: SignedInStaff;
const root = "/api/v1/admin";
async function data<T>(res: Response): Promise<T> {
  const body = await res.clone().text();
  expect(res.status, body).toBe(200);
  expect(res.headers.get("Cache-Control")).toContain("no-store");
  return ((await res.json()) as { data: T }).data;
}
const get = (path: string, who = admin) => app.request(root + path, { headers: who.headers });
const write = (
  method: "POST" | "PUT" | "PATCH",
  path: string,
  body: unknown,
  key: string | null = uuidv7(),
  who = admin,
) =>
  app.request(root + path, {
    method,
    json: body,
    headers: { ...who.headers, ...(key ? { "Idempotency-Key": key } : {}) },
  });
beforeAll(async () => {
  // Queue/target API tests configure a local tool capability but never execute the external tool.
  ownConfigDirectory = await mkdtemp("/tmp/lyx-w309-api-");
  const configPath = join(ownConfigDirectory, "production.json");
  await writeFile(
    configPath,
    JSON.stringify({
      workDir: ownConfigDirectory,
      socketPath: `${ownConfigDirectory}/.sock/tool.sock`,
      aigc: {
        Label: "1",
        ContentProducer: "test",
        ReservedCode1: "",
        ContentPropagator: "test",
        ReservedCode2: "",
      },
      templates: {
        normalize: "test",
        sd: "test",
        hd: "test",
        sample: "test",
        brand: "test",
        ai: "test",
      },
    }),
  );
  const previous = process.env.MEDIA_PRODUCTION_FILE;
  process.env.MEDIA_PRODUCTION_FILE = configPath;
  try {
    app = await h.start();
  } finally {
    if (previous === undefined) delete process.env.MEDIA_PRODUCTION_FILE;
    else process.env.MEDIA_PRODUCTION_FILE = previous;
  }
  const operations = [
    "admin.drama.list",
    "admin.drama.summary",
    "admin.drama.get",
    "admin.drama.activity.list",
    "admin.drama.dramaEpisode.list",
    "admin.drama.dramaPermit.list",
    "admin.drama.listingChecks.get",
    "admin.drama.mediaReadiness.get",
    "admin.drama.create",
    "admin.drama.basic.update",
    "admin.drama.commercial.update",
    "admin.drama.cast.replace",
    "admin.drama.shelve",
    "admin.drama.delist",
    "admin.drama.trailer.replace",
    "admin.drama.confirmPermitRecheck",
    "admin.drama.dramaPermit.create",
    "admin.dramaEpisode.update",
    "admin.dramaPermit.update",
    "admin.dramaPermit.retire",
    "admin.drama.copyright.replace",
    "admin.drama.dramaCopyrightRevision.create",
  ];
  expect(adminDramaHandlers.map(({ route }) => route.operationId).sort()).toEqual(
    [...operations].sort(),
  );
  expect(app.api.mountedOperations).toEqual(expect.arrayContaining(operations));
  await runSeed({ tx: app.runtime.tx, clock: app.clock });
  const db = await h.db.prisma();
  admin = await signInAsStaff(db, { roleKey: "super_admin" });
  editor = await signInAsStaff(db, { roleKey: "editor" });
}, 180000);
it("新建真实required/C50重放：仅一草稿版权行/历史审计，非法字段零写", async () => {
  const db = await h.db.prisma(),
    key = uuidv7();
  expect((await write("POST", "/dramas", { title: "内容API样本" }, null)).status).toBe(400);
  expect((await write("POST", "/dramas", { title: "内容API样本" }, undefined, editor)).status).toBe(
    403,
  );
  const first = await data<AdminDramaDetail>(
    await write("POST", "/dramas", { title: "内容API样本" }, key),
  );
  const replay = await write("POST", "/dramas", { title: "内容API样本" }, key);
  expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
  expect(await data<AdminDramaDetail>(replay)).toMatchObject({
    dramaId: first.dramaId,
    posterUrl: null,
  });
  expect(await db.dramaCopyright.count({ where: { dramaId: first.dramaId } })).toBe(1);
  expect(await db.statusTransition.count({ where: { subjectId: first.dramaId } })).toBe(1);
  expect(await db.auditLog.count({ where: { targetId: first.dramaId } })).toBe(1);
  expect((await write("POST", "/dramas", { title: "错误", status: "listed" })).status).toBe(400);
});
it("基础/商业/角色/剧集四入口真实CAS与字段边界；未授权不能写", async () => {
  let drama = await data<AdminDramaDetail>(await write("POST", "/dramas", { title: "聚合编辑" }));
  drama = await data<AdminDramaDetail>(
    await write("PATCH", `/dramas/${drama.dramaId}/basic`, {
      lockVersion: drama.lockVersion,
      totalEpisodes: 3,
    }),
  );
  drama = await data<AdminDramaDetail>(
    await write("PATCH", `/dramas/${drama.dramaId}/commercial`, {
      lockVersion: drama.lockVersion,
      manualBoost: 10,
    }),
  );
  drama = await data<AdminDramaDetail>(
    await write("PUT", `/dramas/${drama.dramaId}/cast`, {
      lockVersion: drama.lockVersion,
      roles: [{ name: "主角", actor: null, desc: "诚实的店主" }],
    }),
  );
  const episodes = await data<{ items: DramaEpisodeRow[]; total: number }>(
    await get(`/dramas/${drama.dramaId}/drama-episodes?pageSize=2`),
  );
  expect(episodes.items).toHaveLength(2);
  expect(episodes.total).toBe(3);
  expect(episodes.items[0]!.masterState).toBe("missing");
  const path = `/drama-episodes/${episodes.items[0]!.dramaEpisodeId}`;
  const result = await data<{ episode: DramaEpisodeRow; dramaLockVersion: number }>(
    await write("PATCH", path, { dramaLockVersion: drama.lockVersion, title: "第一集" }),
  );
  expect(result.episode.title).toBe("第一集");
  expect(result.dramaLockVersion).toBe(drama.lockVersion + 1);
  expect(
    (await write("PATCH", path, { dramaLockVersion: drama.lockVersion, title: "旧草稿" })).status,
  ).toBe(409);
  expect(
    (
      await write(
        "PATCH",
        path,
        { dramaLockVersion: result.dramaLockVersion, title: "越权" },
        undefined,
        editor,
      )
    ).status,
  ).toBe(403);
});
it("许可create/list/update/retire真实行及父版本；不存在跨对象不泄露", async () => {
  const drama = await data<AdminDramaDetail>(await write("POST", "/dramas", { title: "许可历史" }));
  const created = await data<{ permit: DramaPermit; dramaLockVersion: number }>(
    await write("POST", `/dramas/${drama.dramaId}/drama-permits`, {
      platform: "all",
      permitKind: "program_no",
      permitNo: "TEST-001",
    }),
  );
  const path = `/drama-permits/${created.permit.dramaPermitId}`;
  const changed = await data<{ permit: DramaPermit; dramaLockVersion: number }>(
    await write("PATCH", path, {
      dramaLockVersion: created.dramaLockVersion,
      permitNo: "TEST-002",
      note: "仅测试编号",
    }),
  );
  expect(changed.permit.permitNo).toBe("TEST-002");
  await data(await write("POST", path + "/retire", { retireReason: "测试停用" }));
  const listed = await data<{
    items: DramaPermit[];
    requiredKinds: string[];
    dramaLockVersion: number;
  }>(await get(`/dramas/${drama.dramaId}/drama-permits?status=active,retired`));
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0]!.status).toBe("retired");
  expect(listed.dramaLockVersion).toBe(changed.dramaLockVersion + 1);
  expect(
    (await write("PATCH", `/drama-permits/${uuidv7()}`, { dramaLockVersion: 0, note: null }))
      .status,
  ).toBe(404);
});
it("列表/独立summary/详情/活动/就绪/校验GET真实零业务写，游标绑定本目标且不回传原JSON或IP", async () => {
  const drama = await data<AdminDramaDetail>(
    await write("POST", "/dramas", { title: "查询完整入口" }),
  );
  const db = await h.db.prisma(),
    before = [await db.drama.count(), await db.statusTransition.count(), await db.auditLog.count()];
  const list = await data<{ items: unknown[]; total: number }>(
    await get("/dramas?q=查询完整&isArchived=false"),
  );
  expect(list.total).toBe(1);
  await data(await get("/dramas/summary?q=不存在"));
  await data(await get(`/dramas/${drama.dramaId}`));
  const activities = await data<{ items: ActivityItem[] }>(
    await get(`/dramas/${drama.dramaId}/activities`),
  );
  expect(activities.items).toHaveLength(1);
  expect(activities.items[0]!.transition).toMatchObject({
    toState: "draft",
    event: "drama.create",
  });
  expect(activities.items[0]).not.toHaveProperty("before");
  expect(activities.items[0]).not.toHaveProperty("ip");
  await data(await get(`/dramas/${drama.dramaId}/media-readiness`));
  await data(await get(`/dramas/${drama.dramaId}/listing-checks`));
  expect([
    await db.drama.count(),
    await db.statusTransition.count(),
    await db.auditLog.count(),
  ]).toEqual(before);
  const cursor = Buffer.from(
    JSON.stringify({ targetId: uuidv7(), at: app.clock.now().toISOString(), seq: "1" }),
  ).toString("base64url");
  expect((await get(`/dramas/${drama.dramaId}/activities?cursor=${cursor}`)).status).toBe(400);
});
it("上下架真flow守卫与媒体错误，不以缺母版或错误文件假通过", async () => {
  const drama = await data<AdminDramaDetail>(
    await write("POST", "/dramas", { title: "缺母版不可上架" }),
  );
  const res = await write("POST", `/dramas/${drama.dramaId}/shelve`, {});
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    error: "LISTING_CHECK_FAILED",
    details: { failed: expect.arrayContaining([expect.objectContaining({ code: "L10" })]) },
  });
  expect(
    (await write("POST", `/dramas/${drama.dramaId}/delist`, { reasonCode: "ops_strategy" })).status,
  ).toBe(409);
  const db = await h.db.prisma(),
    make = createFactories({ db, clock: app.clock }),
    wrong = await make.fileObject({ category: "poster" });
  const trailer = await write("PUT", `/dramas/${drama.dramaId}/trailer`, {
    sourceFileId: wrong.id,
  });
  expect(trailer.status).toBe(400);
  expect(await trailer.json()).toMatchObject({ error: "FILE_NOT_USABLE" });
});

it("真实全母版种子后上下架重放只产生一次业务迁移；签名URL不持久化且初修订不重复", async () => {
  const runtime = app.runtime,
    db = await h.db.prisma();
  await seedDemoContent(
    {
      ...runtime,
      appEnv: "test",
      prepareMasters: createCodecDemoMasterPreparer({ ...runtime, appEnv: "test" }),
    },
    admin.staff.id,
  );
  const drama = await db.drama.findFirstOrThrow({ where: { title: "巷口那家店" } });
  const original = drama.firstListedAt,
    revisionCount = await db.dramaCopyrightRevision.count({ where: { dramaId: drama.id } });
  const delistKey = uuidv7();
  await data(
    await write("POST", `/dramas/${drama.id}/delist`, { reasonCode: "ops_strategy" }, delistKey),
  );
  const replay = await write(
    "POST",
    `/dramas/${drama.id}/delist`,
    { reasonCode: "ops_strategy" },
    delistKey,
  );
  expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
  await data(replay);
  const shelveKey = uuidv7();
  const shelved = await data<AdminDramaDetail>(
    await write("POST", `/dramas/${drama.id}/shelve`, {}, shelveKey),
  );
  expect(shelved.status).toBe("listed");
  expect(shelved.posterUrl).not.toBeNull();
  const replayShelve = await write("POST", `/dramas/${drama.id}/shelve`, {}, shelveKey);
  expect(replayShelve.headers.get("Idempotent-Replayed")).toBe("true");
  expect((await data<AdminDramaDetail>(replayShelve)).posterUrl).toBeNull();
  expect((await db.drama.findUniqueOrThrow({ where: { id: drama.id } })).firstListedAt).toEqual(
    original,
  );
  expect(await db.dramaCopyrightRevision.count({ where: { dramaId: drama.id } })).toBe(
    revisionCount,
  );
  expect(
    await db.statusTransition.count({ where: { subjectId: drama.id, event: "drama.relist" } }),
  ).toBe(1);
});
it("预告片真实source检查/180秒及同file-spec复用，失败可重试、retired严格拒，不新建重复任务", async () => {
  const db = await h.db.prisma(),
    make = createFactories({ db, clock: app.clock });
  const drama = await data<AdminDramaDetail>(
    await write("POST", "/dramas", { title: "预告片真实目标" }),
  );
  const source = await make.fileObject({
    category: "trailer_src",
    bucket: "media",
    ext: "mp4",
    mime: "video/mp4",
    declaredMime: "video/mp4",
  });
  const path = `/dramas/${drama.dramaId}/trailer`;
  const checking = await write("PUT", path, { sourceFileId: source.id });
  expect(checking.status).toBe(409);
  expect(await checking.json()).toMatchObject({ error: "TRAILER_SOURCE_CHECKING" });
  await db.mediaCheck.create({
    data: {
      fileId: source.id,
      profile: "trailer_src",
      ruleVersion: 1,
      gate: "pass",
      hard: [],
      soft: [],
      checkedAt: app.clock.now(),
      createdAt: app.clock.now(),
      updatedAt: app.clock.now(),
    },
  });
  await db.mediaInfo.create({
    data: {
      fileId: source.id,
      kind: "video",
      container: "mp4",
      durationMs: 180001,
      probeVersion: 1,
      raw: { fixture: "database-codec-only" },
      probedAt: app.clock.now(),
      createdAt: app.clock.now(),
      updatedAt: app.clock.now(),
    },
  });
  expect((await write("PUT", path, { sourceFileId: source.id })).status).toBe(409);
  await db.mediaInfo.update({ where: { fileId: source.id }, data: { durationMs: 180000 } });
  const asset = await db.playableAsset.create({
    data: {
      id: uuidv7(),
      kind: "trailer",
      sourceFileId: source.id,
      ownerType: "drama",
      ownerId: drama.dramaId,
      specVersion: 1,
      state: "processing",
      createdAt: app.clock.now(),
      updatedAt: app.clock.now(),
    },
  });
  const jobs = await db.mediaJob.count();
  for (const state of ["processing", "ready", "failed"]) {
    await db.playableAsset.update({
      where: { id: asset.id },
      data: { state, readyAt: state === "ready" ? app.clock.now() : null },
    });
    await data(await write("PUT", path, { sourceFileId: source.id }));
    expect(
      (await db.dramaTrailer.findUniqueOrThrow({ where: { dramaId: drama.dramaId } }))
        .targetPlayableAssetId,
    ).toBe(asset.id);
    expect(await db.mediaJob.count()).toBe(jobs);
  }
  await db.playableAsset.update({
    where: { id: asset.id },
    data: { state: "retired", retiredAt: app.clock.now() },
  });
  const retired = await write("PUT", path, { sourceFileId: source.id });
  expect(retired.status).toBe(409);
  expect(await retired.json()).toMatchObject({
    error: "TRAILER_SOURCE_REJECTED",
    details: { reason: "retired" },
  });
  expect(await db.mediaJob.count()).toBe(jobs);
});
