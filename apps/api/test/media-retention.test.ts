// W3-06："admin.file.list", "admin.file.restore", "admin.file.erase", "admin.purgeRun.list", "admin.purgeRun.approve", "admin.purgeRun.reject"。
import { beforeAll, describe, expect, it } from "vitest";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  createFactories,
  signInAsStaff,
  sampleStaffContext,
  snapshotTables,
  assertSnapshotsEqual,
} from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import {
  AdminFileViewSchema,
  AdminFilePageSchema,
  PurgeRunViewSchema,
  PurgeRunPageSchema,
} from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { HANDLERS } from "../src/routes/index.js";

const handle = useTestApi();
let app: TestApi, db: Awaited<ReturnType<typeof handle.db.prisma>>, storage: FakeStorage;
let admin: SignedInStaff, stale: SignedInStaff, viewer: SignedInStaff, editor: SignedInStaff;
let make: ReturnType<typeof createFactories>,
  peer = 0;
const operations = [
  "admin.file.list",
  "admin.file.restore",
  "admin.file.erase",
  "admin.purgeRun.list",
  "admin.purgeRun.approve",
  "admin.purgeRun.reject",
];
const request = (
  path: string,
  method = "GET",
  json?: unknown,
  who: SignedInStaff | null = admin,
  key: string | null = uuidv7(),
) =>
  app.request(`/api/v1${path}`, {
    method,
    ...(json === undefined ? {} : { json }),
    peer: `198.19.106.${++peer}`,
    headers: { ...who?.headers, ...(method !== "GET" && key ? { "Idempotency-Key": key } : {}) },
  });
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: unknown }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ error: symbol });
  return body;
}
beforeAll(async () => {
  app = await handle.start();
  db = await handle.db.prisma();
  await runSeed({ tx: app.runtime.tx, clock: app.clock });
  admin = await signInAsStaff(db, { roleKey: "super_admin", now: app.clock.now() });
  stale = await signInAsStaff(db, { roleKey: "super_admin", now: app.clock.now() });
  await db.staffSession.update({ where: { id: stale.sessionId }, data: { stepupAt: null } });
  editor = await signInAsStaff(db, { roleKey: "editor", now: app.clock.now() });
  viewer = await signInAsStaff(db, { roleKey: "finance", now: app.clock.now() });
  const current = await sampleStaffContext(db, viewer.staff.id);
  await db.staffRole.update({
    where: { key: "finance" },
    data: { moduleLevels: { ...current.moduleLevels, system: "v" }, dataScope: "own" },
  });
  app.runtime.staffAuth.roles.invalidate();
  make = createFactories({ db, clock: app.clock });
  storage = app.runtime.providers.storage as FakeStorage;
  storage.capabilities.versioning = true;
  expect(
    HANDLERS.filter((entry) => operations.includes(entry.route.operationId))
      .map((entry) => entry.route.operationId)
      .sort(),
  ).toEqual([...operations].sort());
}, 180_000);

async function file(deleted = true, days = 1) {
  const old = new Date(app.clock.now().getTime() - (days + 1) * 86_400_000),
    deletedAt = new Date(app.clock.now().getTime() - days * 86_400_000);
  const row = await make.fileObject({
    category: "poster",
    bucket: "pub",
    scopeType: "platform",
    originalName: `retention-${uuidv7()}.png`,
    uploadActorType: "staff",
    uploadActorId: admin.staff.id,
    uploadClient: "admin",
    status: deleted ? "deleted" : "stored",
    deletedAt: deleted ? deletedAt : null,
    purgeAfter: deleted ? deletedAt : null,
    storedAt: old,
    createdAt: old,
    updatedAt: app.clock.now(),
    ext: "png",
    declaredMime: "image/png",
    mime: "image/png",
    declaredSize: 8n,
    sizeBytes: 8n,
  });
  const ref = { bucket: "pub" as const, key: row.objectKey };
  storage.put(ref, new Uint8Array(8), "image/png");
  if (deleted) expect((await storage.delete(ref)).ok).toBe(true);
  return row;
}
async function run(state: "proposed" | "held" = "proposed") {
  const candidate = await file(false);
  return db.filePurgeRun.create({
    data: {
      id: uuidv7(),
      mode: "list_only",
      state,
      candidateCount: 1,
      candidateBytes: 8n,
      byCategory: { poster: { count: 1, bytes: "8" } },
      candidateIds: [candidate.id],
      heldReason: state === "held" ? "虚构阈值熔断" : null,
      createdAt: app.clock.now(),
      updatedAt: app.clock.now(),
    },
  });
}

describe("W3-06六正式媒体保留HTTP", { timeout: 60_000 }, () => {
  it("文件完整筛选/分页/零写/范围，restore无stepup/erase有stepup，真实版本与幂等审计一次", async () => {
    const row = await file(),
      candidateRun = await db.filePurgeRun.create({
        data: {
          id: uuidv7(),
          mode: "list_only",
          state: "held",
          candidateCount: 1,
          candidateBytes: 8n,
          byCategory: { poster: { count: 1, bytes: "8" } },
          candidateIds: [row.id],
          heldReason: "虚构熔断",
          createdAt: app.clock.now(),
          updatedAt: app.clock.now(),
        },
      });
    await error(await request("/admin/files", "GET", undefined, null), 401, "AUTH_REQUIRED");
    await error(await request("/admin/files", "GET", undefined, editor), 403, "PERMISSION_DENIED");
    const tables = ["file_object", "file_purge_run", "audit_log"],
      before = await snapshotTables(db, tables);
    const listed = await request(
      `/admin/files?status=deleted,stored&category=poster&scopeType=platform&uploadActorType=staff&uploadActorId=${admin.staff.id}&purgeRunId=${candidateRun.id}&fileIds=${row.id}&q=retention-&page=1&pageSize=1&sort=-deletedAt`,
    );
    expect(listed.headers.get("cache-control")).toBe("no-store");
    const page = AdminFilePageSchema.parse(await data(listed));
    expect(page).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 1,
      items: [{ fileId: row.id, status: "deleted", check: null, liveRefCount: 0 }],
    });
    expect(JSON.stringify(page)).not.toContain(row.objectKey);
    const second = AdminFilePageSchema.parse(
      await data(await request(`/admin/files?fileIds=${row.id}&page=2&pageSize=1&sort=-sizeBytes`)),
    );
    expect(second.items).toEqual([]);
    expect(second.total).toBe(1);
    assertSnapshotsEqual(before, await snapshotTables(db, tables));
    for (const query of [
      "status=bad",
      "sort=sizeBytes",
      "deletedFrom=2026-02-30",
      `fileIds=${Array.from({ length: 101 }, () => uuidv7()).join(",")}`,
    ])
      await error(await request(`/admin/files?${query}`), 400, "VALIDATION_FAILED");
    const entity = await make.entity(),
      store = await make.store({ entityId: entity.id, deliveryManagerId: admin.staff.id });
    const scoped = await make.fileObject({
      category: "profile_image",
      bucket: "asset",
      scopeType: "store",
      entityId: entity.id,
      storeId: store.id,
      uploadActorType: "staff",
      uploadActorId: admin.staff.id,
      uploadClient: "admin",
    });
    const invisible = AdminFilePageSchema.parse(
      await data(
        await request(
          `/admin/files?entityId=${entity.id}&storeId=${store.id}&fileIds=${scoped.id}`,
          "GET",
          undefined,
          viewer,
        ),
      ),
    );
    expect(invisible.items).toEqual([]);
    await db.storeProfile.create({
      data: {
        entityId: entity.id,
        storeId: store.id,
        logoFileId: scoped.id,
        createdAt: app.clock.now(),
        updatedAt: app.clock.now(),
      },
    });
    await app.runtime.tx.run((tx) =>
      app.runtime.media.link(tx, {
        fileId: scoped.id,
        refType: "store_profile",
        refId: store.id,
        role: "logo",
        entityId: entity.id,
        storeId: store.id,
      }),
    );
    await error(
      await request(
        `/admin/files/${row.id}/restore`,
        "POST",
        { reason: "人工核实需要恢复" },
        admin,
        null,
      ),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    await error(
      await request(`/admin/files/${row.id}/restore`, "POST", { reason: "短" }),
      400,
      "VALIDATION_FAILED",
    );
    await error(
      await request(
        `/admin/files/${row.id}/restore`,
        "POST",
        { reason: "人工核实需要恢复" },
        editor,
      ),
      403,
      "PERMISSION_DENIED",
    );
    const key = uuidv7(),
      body = { reason: "人工核实需要恢复" };
    const restored = AdminFileViewSchema.parse(
      await data(await request(`/admin/files/${row.id}/restore`, "POST", body, stale, key)),
    );
    expect(restored).toMatchObject({ fileId: row.id, status: "stored", deletedAt: null });
    const replay = await request(`/admin/files/${row.id}/restore`, "POST", body, stale, key);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await data(replay)).toEqual(restored);
    expect(
      await db.auditLog.count({ where: { targetId: row.id, action: "files.file.restore" } }),
    ).toBe(1);
    const erase = {
      reason: "本人信息删除请求已经人工核实",
      confirm: { fileId: row.id, category: "poster" },
    };
    await error(
      await request(`/admin/files/${row.id}/erase`, "POST", erase, stale),
      403,
      "STEP_UP_REQUIRED",
    );
    await error(
      await request(`/admin/files/${row.id}/erase`, "POST", {
        ...erase,
        confirm: { fileId: row.id, category: "banner" },
      }),
      409,
      "CONFIRM_MISMATCH",
    );
    await error(
      await request(`/admin/files/${scoped.id}/erase`, "POST", {
        ...erase,
        confirm: { fileId: scoped.id, category: "profile_image" },
      }),
      409,
      "FILE_IN_USE",
    );
    const eraseKey = uuidv7(),
      erased = AdminFileViewSchema.parse(
        await data(await request(`/admin/files/${row.id}/erase`, "POST", erase, admin, eraseKey)),
      );
    expect(erased).toMatchObject({ status: "deleted", originalName: null, restorableUntil: null });
    expect(erased.erasedAt).not.toBe(null);
    expect(
      await data(await request(`/admin/files/${row.id}/erase`, "POST", erase, admin, eraseKey)),
    ).toEqual(erased);
    expect(
      await db.auditLog.count({ where: { targetId: row.id, action: "files.file.erase" } }),
    ).toBe(1);
    await error(
      await request(`/admin/files/${row.id}/restore`, "POST", body),
      409,
      "STATE_NOT_ALLOWED",
    );
    const expired = await file(true, 31);
    await error(
      await request(`/admin/files/${expired.id}/restore`, "POST", body),
      409,
      "FILE_RESTORE_WINDOW_PASSED",
    );
    expect(
      await storage.restoreVersions({
        bucket: "pub",
        key: row.objectKey,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      ok: false,
      reason: "rejected",
    });
  });

  it("PurgeRun真实默认/多状态分页、required/回显/再验证差别，放行只approved与reject不执行删除", async () => {
    const proposed = await run(),
      held = await run("held");
    const tables = ["file_object", "file_purge_run", "audit_log"],
      before = await snapshotTables(db, tables);
    const response = await request("/admin/purge-runs?page=1&pageSize=100");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = PurgeRunPageSchema.parse(await data(response));
    expect(page.items.some((row) => row.purgeRunId === proposed.id)).toBe(true);
    expect(page.items.some((row) => row.purgeRunId === held.id)).toBe(true);
    expect(page.items.every((row) => ["proposed", "held"].includes(row.state))).toBe(true);
    expect(JSON.stringify(page)).not.toContain("candidateIds");
    assertSnapshotsEqual(before, await snapshotTables(db, tables));
    await error(await request("/admin/purge-runs?state=invalid"), 400, "VALIDATION_FAILED");
    await error(
      await request("/admin/purge-runs", "GET", undefined, editor),
      403,
      "PERMISSION_DENIED",
    );
    const approve = {
      confirm: { candidateCount: 1, candidateBytes: "8" },
      note: "逐项人工核实候选",
    };
    await error(
      await request(`/admin/purge-runs/${proposed.id}/approve`, "POST", approve, admin, null),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    await error(
      await request(`/admin/purge-runs/${proposed.id}/approve`, "POST", approve, stale),
      403,
      "STEP_UP_REQUIRED",
    );
    await error(
      await request(`/admin/purge-runs/${proposed.id}/approve`, "POST", approve, viewer),
      403,
      "PERMISSION_DENIED",
    );
    await error(
      await request(`/admin/purge-runs/${proposed.id}/approve`, "POST", {
        confirm: { candidateCount: 2, candidateBytes: "8" },
      }),
      409,
      "CONFIRM_MISMATCH",
    );
    const key = uuidv7(),
      approved = PurgeRunViewSchema.parse(
        await data(
          await request(`/admin/purge-runs/${proposed.id}/approve`, "POST", approve, admin, key),
        ),
      );
    expect(approved).toMatchObject({
      state: "approved",
      candidateBytes: "8",
      startedAt: null,
      deletedCount: null,
      actions: [],
    });
    expect(approved.decidedBy?.staffId).toBe(admin.staff.id);
    const replay = await request(
      `/admin/purge-runs/${proposed.id}/approve`,
      "POST",
      approve,
      admin,
      key,
    );
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await data(replay)).toEqual(approved);
    expect(
      await db.auditLog.count({ where: { targetId: proposed.id, action: "files.purge.approve" } }),
    ).toBe(1);
    const rejectBody = { reason: "候选需重新人工核实" };
    await error(
      await request(`/admin/purge-runs/${held.id}/reject`, "POST", rejectBody, stale, null),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    const rejectKey = uuidv7(),
      rejected = PurgeRunViewSchema.parse(
        await data(
          await request(
            `/admin/purge-runs/${held.id}/reject`,
            "POST",
            rejectBody,
            stale,
            rejectKey,
          ),
        ),
      );
    expect(rejected).toMatchObject({ state: "rejected", startedAt: null, deletedCount: null });
    expect(
      await data(
        await request(`/admin/purge-runs/${held.id}/reject`, "POST", rejectBody, stale, rejectKey),
      ),
    ).toEqual(rejected);
    expect(
      await db.auditLog.count({ where: { targetId: held.id, action: "files.purge.reject" } }),
    ).toBe(1);
    const completed = PurgeRunPageSchema.parse(
      await data(await request("/admin/purge-runs?state=approved,rejected&page=1&pageSize=100")),
    );
    expect(completed.items.map((row) => row.purgeRunId)).toEqual(
      expect.arrayContaining([proposed.id, held.id]),
    );
    expect(
      await db.fileObject.findMany({
        where: { id: { in: [...proposed.candidateIds, ...held.candidateIds] } },
        select: { status: true },
      }),
    ).toEqual([{ status: "stored" }, { status: "stored" }]);
    await error(
      await request(`/admin/purge-runs/${proposed.id}/reject`, "POST", rejectBody, stale),
      409,
      "STATE_NOT_ALLOWED",
    );
  });
});
