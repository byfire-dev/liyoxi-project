import { afterEach, expect, it, vi } from "vitest";
import { AdminAdListQuerySchema } from "@liyoxi/contract";
import { createPrismaClient } from "@liyoxi/db";
import {
  createFactories,
  createW508OrderAdFixture,
  testDatabaseUrl,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let f: Awaited<ReturnType<typeof createW508OrderAdFixture>> | undefined;
let observer: ReturnType<typeof createPrismaClient> | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await observer?.$disconnect();
  observer = undefined;
  await f?.close();
  f = undefined;
});

it(
  "后台广告真实范围/列表计数、资质与人员拒绝；屏障竞争的两路指派只有一次capture",
  { timeout: 120_000 },
  async () => {
    const p = await db.prisma();
    f = await createW508OrderAdFixture(p, {
      databaseUrl: await db.url(),
      redisUrl: process.env.REDIS_URL!,
      redisKeyPrefix: redis.prefix,
    });
    const h = f,
      r = h.runtime,
      make = createFactories({ db: p, clock: h.clock });
    const created = await h.createAd(),
      second = await h.createAd();
    const before = await p.ad.findUniqueOrThrow({ where: { id: created.adId } });
    const disabled = await make.staff({ staffRoleKey: "editor" });
    await r.staffManagement.disable(h.admin.staff, h.admin.ctx, disabled.id, {
      reason: "resigned",
      confirm: { staffNo: disabled.staffNo, openWorkCount: 0 },
    });
    await expect(
      r.adminAds.assign(h.admin, created.adId, { staffId: disabled.id }),
    ).rejects.toMatchObject({
      error: "ASSIGNEE_INVALID",
      details: { staffId: disabled.id, reason: "not_active" },
    });
    await p.store.update({
      where: { id: before.storeId },
      data: { qualificationStatus: "pending" },
    });
    await expect(
      r.adminAds.assign(h.admin, created.adId, { staffId: h.editor.staff.staff.id }),
    ).rejects.toMatchObject({ error: "AD_WAITING_QUALIFICATION" });
    expect(
      (await p.pointHold.findUniqueOrThrow({ where: { id: before.pointHoldId } })).status,
    ).toBe("held");
    await p.store.update({
      where: { id: before.storeId },
      data: { qualificationStatus: "verified" },
    });
    let release!: () => void;
    let writerPid = 0;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transition = r.flow.transition.bind(r.flow);
    const spy = vi.spyOn(r.flow, "transition").mockImplementation(async (tx, ctx, input) => {
      if (input.machine === "ad" && input.event === "ad.assign") {
        const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        writerPid = rows[0]!.pid;
        await released;
      }
      return transition(tx, ctx, input);
    });
    const first = r.adminAds
      .assign(h.admin, created.adId, { staffId: h.editor.staff.staff.id })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    try {
      await vi.waitFor(() => expect(writerPid).toBeGreaterThan(0), { timeout: 5000, interval: 10 });
    } catch (error) {
      release();
      await first;
      throw error;
    }
    const competing = r.adminAds
      .assign(h.admin, created.adId, { staffId: h.editor.staff.staff.id })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    // Only the observer uses owner privileges; both competing business writers retain lyx_app.
    const monitor = (observer = createPrismaClient({
      connectionString: testDatabaseUrl(db.name, { role: null }),
      max: 1,
    }));
    try {
      await vi.waitFor(
        async () => {
          const waiting = await monitor.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND ${writerPid}=ANY(pg_blocking_pids(pid)) AND (query LIKE '%FROM "entity"%' OR query LIKE '%FROM "store"%' OR query LIKE '%FROM "ad"%')`;
          expect(Number(waiting[0]?.count)).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 10 },
      );
    } finally {
      release();
    }
    const results = await Promise.all([first, competing]);
    expect(results.filter((row) => "value" in row)).toHaveLength(1);
    expect(results.find((row) => "error" in row)).toMatchObject({
      error: { error: "STATE_NOT_ALLOWED" },
    });
    expect(
      spy.mock.calls.filter((args) => args[2].machine === "ad" && args[2].event === "ad.assign"),
    ).toHaveLength(1);
    spy.mockRestore();
    const hold = await p.pointHold.findUniqueOrThrow({ where: { id: before.pointHoldId } });
    expect(hold.status).toBe("captured");
    expect(hold.capturedAt).not.toBeNull();
    expect(
      await p.ledgerOperation.count({ where: { opType: "capture", pointHoldId: hold.id } }),
    ).toBe(1);
    expect(
      await p.assignmentHistory.count({ where: { subjectType: "ad", subjectId: created.adId } }),
    ).toBe(0);
    const query = AdminAdListQuerySchema.parse({
      tab: "all",
      storeId: before.storeId,
      pageSize: 1,
    });
    const all = await r.adminAds.list(h.admin, query),
      summary = await r.adminAds.summary(h.admin, { storeId: before.storeId });
    expect(all.total).toBe(2);
    expect(all.items).toHaveLength(1);
    expect(summary.tabs.todo).toBe(all.total);
    const own = await r.adminAds.list(
      h.editor,
      AdminAdListQuerySchema.parse({ tab: "all", storeId: before.storeId }),
    );
    expect(own.items.map((row) => row.adId)).toEqual([created.adId]);
    await expect(r.adminAds.get(h.editor, second.adId)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    const detail = await r.adminAds.get(h.admin, created.adId);
    expect(detail.pointHold).toMatchObject({
      status: "captured",
      capturedAt: hold.capturedAt!.toISOString(),
    });
    expect(detail.agreement.agreementKey).toBe("ad_service");
    expect(detail.actions).toContain("return");
  },
);
