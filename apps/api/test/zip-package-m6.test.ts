import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeliveryReleasePackResultSchema } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  createPublishWorkbenchFixture,
  signInAsStaff,
  snapshotTables,
  assertSnapshotsEqual,
} from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
let api: TestApi;
let h: ReturnType<typeof createPublishWorkbenchFixture>;
let released: Awaited<ReturnType<typeof h.release>>;
let admin: SignedInStaff, publisher: SignedInStaff, cs: SignedInStaff;
let peer = 0;
const tables = [
  "delivery_release",
  "download_grant",
  "zip_bundle",
  "media_job",
  "file_object",
  "file_ref",
  "outbox_event",
  "audit_log",
];
const request = (
  options: { id?: string; headers?: Record<string, string>; key?: string; body?: unknown } = {},
) =>
  api.request(
    `/api/v1/admin/delivery-releases/${options.id ?? released.release.deliveryReleaseId}/pack`,
    {
      method: "POST",
      json: options.body ?? {},
      peer: `198.19.117.${++peer}`,
      headers: {
        ...(options.headers ?? admin.headers),
        "Idempotency-Key": options.key ?? uuidv7(),
      },
    },
  );
async function result(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return DeliveryReleasePackResultSchema.parse(((await response.json()) as { data: unknown }).data);
}

beforeAll(async () => {
  api = await handle.start();
  const prisma = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  h = createPublishWorkbenchFixture(prisma);
  // Public fixture traverses real preparation/QC/push; no successful release or ZIP is patched.
  released = await h.release(false, 2);
  api.clock.set(h.clock.now());
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  publisher = await signInAsStaff(prisma, { roleKey: "publisher", now: api.clock.now() });
  cs = await signInAsStaff(prisma, { roleKey: "cs", now: api.clock.now() });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe("W6-07 预打包真实 HTTP", () => {
  it("挂载唯一接口；显式预打包与同键重放共用推包已排队的任务", async () => {
    expect(api.api.mountedOperations).toContain("admin.deliveryRelease.pack");
    const before = await h.prisma.mediaJob.count({ where: { kind: "zip_package" } });
    expect(before).toBe(1);
    const key = uuidv7(),
      first = await result(await request({ key }));
    expect(first).toMatchObject({
      deliveryReleaseId: released.release.deliveryReleaseId,
      zipState: "building",
      zipGen: 1,
      zipFileId: null,
      publishListFileId: null,
    });
    expect(first.zipBundleId).toBeTruthy();
    const snapshot = await snapshotTables(h.prisma, tables);
    expect(await result(await request({ key }))).toEqual(first);
    assertSnapshotsEqual(snapshot, await snapshotTables(h.prisma, tables));
    expect(await result(await request())).toEqual(first);
    expect(await h.prisma.mediaJob.count({ where: { kind: "zip_package" } })).toBe(before);
    const job = await h.prisma.mediaJob.findFirstOrThrow({ where: { kind: "zip_package" } });
    expect(job).toMatchObject({ state: "queued", attemptNo: 0, externalJobId: null });
    expect(job.input).toMatchObject({
      ownerId: released.release.deliveryReleaseId,
      items: [
        expect.objectContaining({ name: expect.any(String) }),
        expect.objectContaining({ name: expect.any(String) }),
      ],
    });
  });

  it("未登录、无权限、范围外与不存在对象全部拒绝且业务零写", async () => {
    const before = await snapshotTables(h.prisma, tables);
    expect((await request({ headers: {} })).status).toBe(401);
    const denied = await request({ headers: cs.headers });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "PERMISSION_DENIED" });
    const outside = await request({ headers: publisher.headers });
    expect(outside.status).toBe(404);
    expect(await outside.json()).toMatchObject({ error: "NOT_FOUND" });
    const missing = await request({ id: uuidv7() });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "NOT_FOUND" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });

  it("拒绝客户端指定产物、代次及清单，不改变当前任务", async () => {
    const before = await snapshotTables(h.prisma, tables);
    for (const body of [{ dstKey: "foreign.zip" }, { zipGen: 9 }, { items: [] }, { retry: true }])
      expect((await request({ body })).status).toBe(400);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });

  it("授权到期后不能以预打包延长授权或生成新任务", async () => {
    const grant = await h.prisma.downloadGrant.findFirstOrThrow({
      where: {
        deliveryReleaseId: released.release.deliveryReleaseId,
        state: "active",
      },
    });
    api.clock.set(new Date(grant.expiresAt.getTime() + 1));
    const current = await signInAsStaff(h.prisma, { roleKey: "super_admin", now: api.clock.now() });
    const before = await snapshotTables(h.prisma, tables);
    const response = await request({ headers: current.headers });
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "DOWNLOAD_GRANT_INVALID",
      details: { reason: "expired", canRegenerate: false },
    });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });
});
