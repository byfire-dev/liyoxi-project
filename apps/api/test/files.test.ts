// W1-07："m.file.create", "m.file.get", "m.file.refreshCredentials", "m.file.complete", "m.file.cancel", "admin.file.create", "admin.file.get", "admin.file.complete", "admin.file.downloadUrls"。
import { beforeAll, describe, expect, it } from "vitest";
import { createIdentityContext, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import type { FileRegistration, FileStatusView, AdminFileView, SignedUrl } from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { merchantServicesOf } from "../src/merchant/services.js";
const handle = useTestApi();
let api: TestApi;
let owner: SignedInMerchant;
let clerk: SignedInMerchant;
let outsider: SignedInMerchant;
let storeId: string;
let entityId: string;
let admin: SignedInStaff;
let editor: SignedInStaff;
let prisma: Awaited<ReturnType<typeof handle.db.prisma>>;
let fake: FakeStorage;
let peer = 0;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
async function error(response: Response, status: number, code: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: code });
}
const post = (path: string, json: unknown, headers: Record<string, string>, key = uuidv7()) =>
  api.request(`/api/v1${path}`, {
    method: "POST",
    json,
    headers: { ...headers, "Idempotency-Key": key },
    peer: `198.19.77.${++peer}`,
  });
const body = (category = "profile_image", token = uuidv7()) => ({
  category,
  files: [{ fileName: "photo.png", sizeBytes: "8", clientToken: token }],
});
const create = async (token = uuidv7()) =>
  (
    await data<{ items: FileRegistration[] }>(
      await post("/m/files", body("profile_image", token), owner.withStore(storeId)),
    )
  ).items[0]!;
beforeAll(async () => {
  api = await handle.start();
  prisma = await handle.db.prisma();
  await seedUserAgreements(handle, api);
  owner = await signInAsMerchant(api);
  const created = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  storeId = created.storeId;
  entityId = created.entityId;
  const make = createFactories({ db: prisma, clock: api.clock });
  clerk = await signInAsMerchant(api);
  const member = await make.entityMember({ entityId, merchantUserId: clerk.merchantUserId });
  await make.storeMember({ entityMemberId: member.id, storeId, addedByMemberId: created.memberId });
  outsider = await signInAsMerchant(api);
  admin = await signInAsStaff(prisma, { roleKey: "super_admin" });
  editor = await signInAsStaff(prisma, { roleKey: "editor" });
  fake = api.runtime.providers.storage as FakeStorage;
}, 180_000);
describe("文件九接口生产处理器与鉴权", { timeout: 60_000 }, () => {
  it("创建自然重用、批量失败零新增、店员拒绝和归属自读", async () => {
    const token = uuidv7();
    const file = await create(token);
    expect((await create(token)).fileId).toBe(file.fileId);
    await error(await post("/m/files", body(), clerk.withStore(storeId)), 403, "ROLE_FORBIDDEN");
    await error(
      await api.request(`/api/v1/m/files/${file.fileId}`, { headers: clerk.withStore(storeId) }),
      404,
      "NOT_FOUND",
    );
    await error(
      await api.request(`/api/v1/m/files/${file.fileId}`, { headers: outsider.withStore(storeId) }),
      403,
      "NOT_A_MEMBER",
    );
    const before = await prisma.fileObject.count();
    await error(
      await post(
        "/m/files",
        { ...body(), files: [body().files[0], { ...body().files[0], fileName: "bad.svg" }] },
        owner.withStore(storeId),
      ),
      400,
      "FILE_TYPE_NOT_ALLOWED",
    );
    expect(await prisma.fileObject.count()).toBe(before);
    const rowBefore = await prisma.fileObject.findUnique({ where: { id: file.fileId } });
    await data<FileStatusView>(
      await api.request(`/api/v1/m/files/${file.fileId}`, { headers: owner.withStore(storeId) }),
    );
    expect(await prisma.fileObject.findUnique({ where: { id: file.fileId } })).toEqual(rowBefore);
  });
  it("post 续签无次数写，missing 同幂等键补传成功，再重放 retaining promoting", async () => {
    const file = await create();
    const refreshed = await data<FileRegistration>(
      await post(`/m/files/${file.fileId}/refresh-credentials`, {}, owner.withStore(storeId)),
    );
    expect(refreshed).toMatchObject({ key: file.key, credentialsLeft: 30 });
    const key = uuidv7();
    await error(
      await post(`/m/files/${file.fileId}/complete`, {}, owner.withStore(storeId), key),
      409,
      "UPLOAD_NOT_FOUND",
    );
    fake.put({ bucket: "asset", key: file.key }, png, "image/jpeg");
    expect(
      await data<FileStatusView>(
        await post(`/m/files/${file.fileId}/complete`, {}, owner.withStore(storeId), key),
      ),
    ).toMatchObject({ status: "promoting" });
    const job = await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${file.fileId}` },
    });
    await api.runtime.media.promote({ jobId: job.id });
    const replay = await post(
      `/m/files/${file.fileId}/complete`,
      {},
      owner.withStore(storeId),
      key,
    );
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await data<FileStatusView>(replay)).toMatchObject({ status: "promoting" });
    await error(
      await post(`/m/files/${file.fileId}/cancel`, {}, owner.withStore(storeId)),
      409,
      "STATE_NOT_ALLOWED",
    );
    const pending = await create();
    expect(
      await data<FileStatusView>(
        await post(`/m/files/${pending.fileId}/cancel`, {}, owner.withStore(storeId)),
      ),
    ).toMatchObject({ status: "expired" });
  });
  it("后台 poster 登记/确认/get、不开放生产分类与矩阵404、不写GET审计", async () => {
    const request = {
      category: "poster",
      fileName: "cover.png",
      sizeBytes: "8",
      clientToken: uuidv7(),
      mime: "text/html",
    };
    const file = await data<FileRegistration>(await post("/admin/files", request, admin.headers));
    fake.put({ bucket: "asset", key: file.key }, png, "text/html");
    await error(
      await post("/admin/files", { ...request, category: "final_episode" }, admin.headers),
      400,
      "FILE_CATEGORY_NOT_ALLOWED",
    );
    await error(await post("/admin/files", request, editor.headers), 403, "PERMISSION_DENIED");
    const confirmKey = uuidv7();
    const confirmed = await data<AdminFileView>(
      await post(`/admin/files/${file.fileId}/complete`, {}, admin.headers, confirmKey),
    );
    expect(confirmed).toMatchObject({ status: "promoting", production: null, check: null });
    const job = await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${file.fileId}` },
    });
    await api.runtime.media.promote({ jobId: job.id });
    await prisma.staff.update({ where: { id: admin.staff.id }, data: { name: "确认后更名" } });
    const headCalls = fake.callsOf("head").length;
    const replay = await post(
      `/admin/files/${file.fileId}/complete`,
      {},
      admin.headers,
      confirmKey,
    );
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await data<AdminFileView>(replay)).toEqual(confirmed);
    expect(fake.callsOf("head")).toHaveLength(headCalls);
    const before = await prisma.auditLog.count();
    expect(
      await data<AdminFileView>(
        await api.request(`/api/v1/admin/files/${file.fileId}`, { headers: admin.headers }),
      ),
    ).toMatchObject({ status: "stored", mime: "image/png", actions: [] });
    expect(await prisma.auditLog.count()).toBe(before);
    // 默认角色均可查看短剧库；editor 的 v 级可以签海报，但不能登记新海报。
    expect(
      await data<SignedUrl>(
        await post(`/admin/files/${file.fileId}/download-urls`, {}, editor.headers),
      ),
    ).toHaveProperty("url");
    const signed = await data<SignedUrl>(
      await post(
        `/admin/files/${file.fileId}/download-urls`,
        { disposition: "inline" },
        admin.headers,
      ),
    );
    expect(signed.url).toBeTruthy();
    expect(fake.fetch(signed.url)).toMatchObject({ status: 200, contentDisposition: "inline" });
  });
  it("secure 签发逐次 access 留痕；block 409，不接受全局幂等缓存", async () => {
    const receipt = (
      await data<{ items: FileRegistration[] }>(
        await post("/m/files", body("pay_receipt"), owner.withStore(storeId)),
      )
    ).items[0]!;
    fake.put({ bucket: "secure", key: receipt.key }, png, "image/png");
    await api.runtime.media.complete(
      {
        identity: createIdentityContext({
          actor: { type: "merchant", id: owner.merchantUserId, client: "weapp", role: "owner" },
          entityId,
          storeId,
        }),
        merchant: { standing: "owner", entityId, storeId },
      },
      receipt.fileId,
    );
    await api.runtime.media.promote({
      jobId: (
        await prisma.mediaJob.findUniqueOrThrow({
          where: { dedupeKey: `promote:${receipt.fileId}` },
        })
      ).id,
    });
    const before = await prisma.auditLog.count();
    await error(
      await post(`/admin/files/${receipt.fileId}/download-urls`, {}, editor.headers),
      404,
      "NOT_FOUND",
    );
    const key = uuidv7();
    await data<SignedUrl>(
      await post(
        `/admin/files/${receipt.fileId}/download-urls`,
        { purpose: "财务核对" },
        admin.headers,
        key,
      ),
    );
    await data<SignedUrl>(
      await post(
        `/admin/files/${receipt.fileId}/download-urls`,
        { purpose: "财务核对" },
        admin.headers,
        key,
      ),
    );
    expect(await prisma.auditLog.count()).toBe(before + 2);
    await prisma.fileObject.update({
      where: { id: receipt.fileId },
      data: { moderationState: "block" },
    });
    await error(
      await post(`/admin/files/${receipt.fileId}/download-urls`, {}, admin.headers),
      409,
      "FILE_NOT_AVAILABLE",
    );
  });
});
