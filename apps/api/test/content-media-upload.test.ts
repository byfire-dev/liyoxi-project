import { beforeAll, describe, expect, it } from "vitest";
import { runSeed, SEED_MODULES, uuidv7 } from "@liyoxi/services";
import { signInAsStaff } from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import type { FileRegistration, SignedUrl } from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
let api: TestApi;
let db: Awaited<ReturnType<typeof handle.db.prisma>>;
let editor: SignedInStaff;
let reviewer: SignedInStaff;
let viewer: SignedInStaff;
let unrelated: SignedInStaff;
let admin: SignedInStaff;
let storage: FakeStorage;
let peer = 0;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Only the upload boundary is tested here; this is not a playable production fixture.
const mp4 = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
type Category = "banner" | "trailer_src" | "drama_license_doc";
const bytesFor = (category: Category) => (category === "trailer_src" ? mp4 : png);
const input = (category: Category) => ({
  category,
  fileName: `fictional.${category === "trailer_src" ? "mp4" : "png"}`,
  sizeBytes: String(bytesFor(category).length),
  clientToken: uuidv7(),
});
const post = (path: string, json: unknown, staff = editor) =>
  api.request(`/api/v1${path}`, {
    method: "POST",
    json,
    headers: { ...staff.headers, "idempotency-key": uuidv7() },
    peer: `198.19.81.${++peer}`,
  });
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
async function denied(response: Response, status: number, error: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error });
}
async function stored(category: Category, staff = editor) {
  const request = input(category);
  const file = await data<FileRegistration>(await post("/admin/files", request, staff));
  expect((await data<FileRegistration>(await post("/admin/files", request, staff))).fileId).toBe(
    file.fileId,
  );
  const bucket = category === "banner" ? "pub" : category === "trailer_src" ? "media" : "secure";
  const incomingBucket = category === "banner" ? "asset" : bucket;
  storage.put(
    { bucket: incomingBucket, key: file.key },
    bytesFor(category),
    category === "trailer_src" ? "video/mp4" : "image/png",
  );
  await data(await post(`/admin/files/${file.fileId}/complete`, {}, staff));
  const job = await db.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.fileId}` },
  });
  await api.runtime.media.promote({ jobId: job.id });
  expect(await db.fileObject.findUniqueOrThrow({ where: { id: file.fileId } })).toMatchObject({
    category,
    bucket,
    scopeType: "platform",
    entityId: null,
    storeId: null,
    onBehalfStoreId: null,
    status: "stored",
    uploadActorId: staff.staff.id,
  });
  return file.fileId;
}
beforeAll(async () => {
  api = await handle.start();
  await runSeed({ tx: api.runtime.tx, clock: api.clock, modules: SEED_MODULES });
  db = await handle.db.prisma();
  for (const [key, drama, ops] of [
    ["editor", "e", "e"],
    ["content_ops", "v", "v"],
    ["cs", "v", "v"],
    ["finance", "n", "v"],
  ] as const) {
    const role = await db.staffRole.findUniqueOrThrow({ where: { key } });
    await db.staffRole.update({
      where: { key },
      data: {
        moduleLevels: { ...(role.moduleLevels as Record<string, string>), drama, ops },
        ...(key === "content_ops"
          ? {
              actions: {
                ...(role.actions as Record<string, unknown>),
                "drama.media.manage": { on: false, leadOnly: false },
              },
            }
          : {}),
      },
    });
  }
  editor = await signInAsStaff(db, { roleKey: "editor", now: api.clock.now() });
  reviewer = await signInAsStaff(db, { roleKey: "content_ops", now: api.clock.now() });
  viewer = await signInAsStaff(db, { roleKey: "cs", now: api.clock.now() });
  unrelated = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  admin = await signInAsStaff(db, { roleKey: "super_admin", now: api.clock.now() });
  storage = api.runtime.providers.storage as FakeStorage;
}, 60_000);

describe("内容与站点文件的正式后台分类授权", () => {
  it.each(["banner", "drama_license_doc", "trailer_src"] as const)(
    "%s 真实登记、自然重用、完成与promote，按正式范围签发",
    async (category) => {
      const fileId = await stored(category, category === "trailer_src" ? admin : editor);
      const auditBefore = await db.auditLog.count({
        where: { targetId: fileId, stream: "access" },
      });
      const reader = category === "drama_license_doc" ? viewer : unrelated;
      const signed = await data<SignedUrl>(
        await post(`/admin/files/${fileId}/download-urls`, {}, reader),
      );
      expect(storage.fetch(signed.url)).toMatchObject({ status: 200, body: bytesFor(category) });
      expect(Date.parse(signed.expiresAt)).toBeGreaterThan(api.clock.now().getTime());
      expect(await db.auditLog.count({ where: { targetId: fileId, stream: "access" } })).toBe(
        auditBefore + (category === "drama_license_doc" ? 1 : 0),
      );
      if (category === "drama_license_doc")
        await denied(
          await post(`/admin/files/${fileId}/download-urls`, {}, unrelated),
          404,
          "NOT_FOUND",
        );
      await db.fileObject.update({ where: { id: fileId }, data: { moderationState: "block" } });
      await denied(
        await post(`/admin/files/${fileId}/download-urls`, {}, reader),
        409,
        "FILE_NOT_AVAILABLE",
      );
    },
  );
  it("版权权限可独立登记证明，但普通只读不能登记，媒体权限单独判定", async () => {
    await data<FileRegistration>(await post("/admin/files", input("drama_license_doc"), reviewer));
    const before = await db.fileObject.count();
    for (const category of ["banner", "trailer_src", "drama_license_doc"] as const)
      await denied(await post("/admin/files", input(category), viewer), 403, "PERMISSION_DENIED");
    for (const staff of [editor, reviewer])
      await denied(
        await post("/admin/files", input("trailer_src"), staff),
        403,
        "PERMISSION_DENIED",
      );
    expect(await db.fileObject.count()).toBe(before);
  });
  it("平台分类拒绝主体、门店和代传归属，原片及系统派生分类仍禁止通用登记", async () => {
    const before = await db.fileObject.count();
    for (const category of ["banner", "trailer_src", "drama_license_doc"] as const)
      for (const scope of [{ entityId: uuidv7() }, { storeId: uuidv7() }, { onBehalfStore: true }])
        await denied(
          await post("/admin/files", { ...input(category), ...scope }, admin),
          400,
          "FILE_CATEGORY_NOT_ALLOWED",
        );
    for (const category of ["drama_master", "trailer_out", "seal_image"])
      await denied(
        await post("/admin/files", { ...input("trailer_src"), category }, admin),
        400,
        "FILE_CATEGORY_NOT_ALLOWED",
      );
    expect(await db.fileObject.count()).toBe(before);
  });
});
