import { beforeAll, describe, expect, it } from "vitest";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
const handle = useTestApi();
let app: TestApi,
  db: Awaited<ReturnType<typeof handle.db.prisma>>,
  admin: SignedInStaff,
  viewer: SignedInStaff,
  editor: SignedInStaff;
const ops = new Set<string>();
const request = (path: string, method = "GET", json?: unknown, user = admin, key?: string) => {
  ops.add(method === "GET" ? "admin.mediaJob.list" : "admin.mediaJob.retry");
  return app.request("/api/v1/admin/media-jobs" + path, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { ...user.headers, ...(key ? { "Idempotency-Key": key } : {}) },
  });
};
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}
beforeAll(async () => {
  app = await handle.start();
  db = await handle.db.prisma();
  await runSeed({ tx: app.runtime.tx, clock: app.clock });
  admin = await signInAsStaff(db, { roleKey: "super_admin" });
  viewer = await signInAsStaff(db, { roleKey: "finance" });
  editor = await signInAsStaff(db, { roleKey: "editor" });
  const role = await db.staffRole.findUniqueOrThrow({ where: { key: "finance" } });
  await db.staffRole.update({
    where: { key: role.key },
    data: { moduleLevels: { ...(role.moduleLevels as Record<string, string>), system: "v" } },
  });
  app.runtime.staffAuth.roles.invalidate();
}, 180_000);
async function job(state = "failed") {
  const make = createFactories({ db, clock: app.clock });
  const user = await make.merchantUser();
  const file = await make.fileObject({
    category: "profile_image",
    uploadActorType: "merchant",
    uploadActorId: user.id,
    uploadClient: "weapp",
    bucket: "asset",
    ext: "png",
    declaredMime: "image/png",
    declaredSize: 8n,
    sizeBytes: 8n,
    moderationState: "pending",
  });
  return db.mediaJob.create({
    data: {
      id: uuidv7(),
      kind: "audit_image",
      provider: "fake",
      mode: "local",
      subjectType: "file_object",
      subjectId: file.id,
      dedupeKey: `audit_image:${file.id}:v1`,
      state,
      attemptNo: 3,
      input: { src: { bucket: file.bucket, key: file.objectKey }, scenes: ["profile"] },
      output: { arbitrary: "fictional-sensitive-output" },
      errorCode: "CI_IMAGE_UNAVAILABLE",
      errorMessage: "Bearer fictional-sensitive-message",
      nextRunAt: app.clock.now(),
      deadlineAt: app.clock.now(),
      finishedAt: app.clock.now(),
      createdAt: app.clock.now(),
      updatedAt: app.clock.now(),
    },
  });
}
describe("媒体任务两条实际生产管线", () => {
  it("默认failed/全部筛选/页码/投影/no-store/真实system读权限", async () => {
    const row = await job();
    await db.mediaJob.update({
      where: { id: row.id },
      data: { billableQty: "2.340", billableUnit: "minute", estCostMicro: 12345n },
    });
    const response = await request("", "GET", undefined, viewer);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await data(response);
    expect(JSON.stringify(page)).toContain(row.id);
    expect(JSON.stringify(page)).not.toContain("fictional-sensitive");
    expect(JSON.stringify(page)).not.toContain('"input"');
    expect(JSON.stringify(page)).not.toContain('"output"');
    const items = page.items as Array<Record<string, unknown>>;
    expect(items.find((one) => one.mediaJobId === row.id)?.billable).toEqual({
      qty: "2.340",
      unit: "minute",
      estCostMicro: "12345",
    });
    expect(items.find((one) => one.mediaJobId === row.id)?.actions).toEqual([]);
    expect((await request("", "GET", undefined, editor)).status).toBe(403);
    expect((await app.request("/api/v1/admin/media-jobs")).status).toBe(401);
    const selected = await data(
      await request(
        `?kind=audit_image&state=failed&subjectType=file_object&subjectId=${row.subjectId}&sort=-createdAt&page=1&pageSize=10`,
      ),
    );
    expect(selected.total).toBe(1);
    for (const query of [
      "?parentType=playable_asset",
      "?createdFrom=2026-01-01",
      "?state=constructor",
      "?kind=alien",
      "?createdFrom=2026-10-02&createdTo=2026-10-01",
    ])
      expect((await request(query)).status).toBe(400);
  });
  it("required retry真实审计一次与重放；仅failed仍需要，重置正式预算", async () => {
    const row = await job(),
      key = uuidv7();
    const first = await data(
      await request(`/${row.id}/retry`, "POST", { note: "真实fixture重投" }, admin, key),
    );
    expect(first).toMatchObject({ state: "queued", attemptNo: 0, finishedAt: null, error: null });
    const fresh = await db.mediaJob.findUniqueOrThrow({ where: { id: row.id } });
    expect(fresh.deadlineAt.getTime() - app.clock.now().getTime()).toBe(15 * 60_000);
    expect(
      await data(
        await request(`/${row.id}/retry`, "POST", { note: "真实fixture重投" }, admin, key),
      ),
    ).toEqual(first);
    expect(
      await db.auditLog.count({
        where: { targetId: row.id, targetType: "media_job", action: "media.job.retry" },
      }),
    ).toBe(1);
    expect((await request(`/${row.id}/retry`, "POST", {}, admin, uuidv7())).status).toBe(409);
    expect((await request(`/${uuidv7()}/retry`, "POST", {}, admin, uuidv7())).status).toBe(404);
    expect((await request(`/${row.id}/retry`, "POST", {}, viewer, uuidv7())).status).toBe(403);
    expect((await request(`/${row.id}/retry`, "POST", {}, admin)).status).toBe(400);
  });
  it("业务已退役/不再需要拒绝重试；坏payload不是通用重投入口", async () => {
    const row = await job();
    await db.fileObject.update({ where: { id: row.subjectId }, data: { moderationState: "pass" } });
    const response = await request(`/${row.id}/retry`, "POST", {}, admin, uuidv7());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "MEDIA_JOB_NOT_RETRYABLE" });
    expect(
      (await request(`/${row.id}/retry`, "POST", { note: "ok", input: {} }, admin, uuidv7()))
        .status,
    ).toBe(400);
    expect(ops).toEqual(new Set(["admin.mediaJob.list", "admin.mediaJob.retry"]));
  });
});
