// W3-01: "admin.file.refreshCredentials", "admin.file.cancel"; real production pipeline, no cloud account.
import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@liyoxi/services";
import { signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff, FakeStorage } from "@liyoxi/services/testing";
import type { FileRegistration } from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { RATE_LIMIT_QUOTAS } from "../src/http/rate-limit-quotas.js";
const handle = useTestApi();
let app: TestApi;
let prisma: Awaited<ReturnType<typeof handle.db.prisma>>;
let owner: SignedInStaff, other: SignedInStaff;
let storage: FakeStorage;
const prefix = "/api/v1/admin/files";
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
const post = (path: string, session = owner, key?: string) =>
  app.request(prefix + path, {
    method: "POST",
    headers: { ...session.headers, ...(key ? { "Idempotency-Key": key } : {}) },
  });
const create = async (multipart = false) => {
  const file = await data<FileRegistration>(
    await app.request(prefix, {
      method: "POST",
      json: { category: "poster", fileName: "a.png", sizeBytes: "8", clientToken: uuidv7() },
      headers: owner.headers,
    }),
  );
  // A legitimate existing pending row exercises the multipart endpoint independent of registration's >20MB choice.
  if (multipart)
    await prisma.fileObject.update({
      where: { id: file.fileId },
      data: { uploadMode: "multipart", stsIssued: 1 },
    });
  return file;
};
beforeAll(async () => {
  app = await handle.start();
  prisma = await handle.db.prisma();
  owner = await signInAsStaff(prisma, { roleKey: "super_admin" });
  other = await signInAsStaff(prisma, { roleKey: "super_admin" });
  storage = app.runtime.providers.storage as FakeStorage;
}, 120000);

describe("两条后台凭据/取消正式管线", { timeout: 60000 }, () => {
  it("none续签真实STS/no-store/无幂等凭据，缺鉴权与非本人均拒绝", async () => {
    const file = await create(true);
    const before = storage.callsOf("issueSts").length;
    expect(
      (
        await app.request(`${prefix}/${file.fileId}/refresh-credentials`, {
          method: "POST",
          headers: { "X-LYX-Admin": "1", Origin: "http://localhost" },
        })
      ).status,
    ).toBe(401);
    expect((await post(`/${file.fileId}/refresh-credentials`, other)).status).toBe(404);
    expect((await post(`/${uuidv7()}/refresh-credentials`)).status).toBe(404);
    expect(storage.callsOf("issueSts")).toHaveLength(before);
    const response = await post(`/${file.fileId}/refresh-credentials`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await data<FileRegistration>(response)).toMatchObject({
      mode: "multipart",
      post: null,
      chunkSize: 8388608,
      chunkParallel: 4,
      credentialsLeft: 28,
      key: file.key,
    });
    expect(
      await prisma.idempotencyRecord.count({ where: { scope: "admin.file.refreshCredentials" } }),
    ).toBe(0);
    expect(storage.callsOf("issueSts")).toHaveLength(before + 1);
  });
  it("确认中/额度30/过期真实409及符号；不存在/归属不提前发密钥", async () => {
    const file = await create(true);
    const before = storage.callsOf("issueSts").length;
    await prisma.fileObject.update({
      where: { id: file.fileId },
      data: { confirmingUntil: new Date(app.clock.now().getTime() + 30000) },
    });
    expect(await (await post(`/${file.fileId}/refresh-credentials`)).json()).toMatchObject({
      error: "CONFIRM_IN_PROGRESS",
    });
    expect((await post(`/${file.fileId}/cancel`, owner, uuidv7())).status).toBe(409);
    await prisma.fileObject.update({
      where: { id: file.fileId },
      data: { confirmingUntil: null, stsIssued: 30 },
    });
    const limit = await post(`/${file.fileId}/refresh-credentials`);
    expect(limit.status).toBe(409);
    expect(await limit.json()).toMatchObject({ error: "UPLOAD_CREDENTIAL_LIMIT" });
    await prisma.fileObject.update({
      where: { id: file.fileId },
      data: { stsIssued: 1, uploadExpiresAt: app.clock.now() },
    });
    expect(await (await post(`/${file.fileId}/refresh-credentials`)).json()).toMatchObject({
      error: "UPLOAD_EXPIRED",
    });
    expect(storage.callsOf("issueSts")).toHaveLength(before);
  });
  it("required取消重放不重中止，真AdminFileView、无事件/审计、GET只读", async () => {
    const file = await create(true),
      key = uuidv7();
    expect((await post(`/${file.fileId}/cancel`)).status).toBe(400);
    expect((await post(`/${file.fileId}/cancel`, other, uuidv7())).status).toBe(404);
    const before = storage.callsOf("abortMultipart").length;
    const first = await data<Record<string, unknown>>(
      await post(`/${file.fileId}/cancel`, owner, key),
    );
    expect(first).toMatchObject({
      fileId: file.fileId,
      status: "expired",
      uploader: { actorType: "staff", actorId: owner.staff.id },
      liveRefCount: 0,
    });
    const replay = await post(`/${file.fileId}/cancel`, owner, key);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await data(replay)).toEqual(first);
    expect(storage.callsOf("abortMultipart")).toHaveLength(before + 1);
    expect(storage.callsOf("abortMultipart").at(-1)?.input).toMatchObject({ key: file.key });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: file.fileId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { targetId: file.fileId } })).toBe(0);
    expect(
      await data(await app.request(`${prefix}/${file.fileId}`, { headers: owner.headers })),
    ).toMatchObject({ status: "expired" });
  });
  it("nonce来源检查和真实限流429在续签前；原pipeline不绕过", async () => {
    const file = await create(true);
    const headers: Record<string, string> = { ...owner.headers };
    delete headers.origin;
    delete headers.Origin;
    expect(
      (
        await app.request(`${prefix}/${file.fileId}/refresh-credentials`, {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(403);
    const limited = await handle.start({
      rateLimitQuotas: {
        ...RATE_LIMIT_QUOTAS,
        "admin.global": [{ by: "ip", limit: 1, windowSec: 60 }],
      },
    });
    const path = `${prefix}/${file.fileId}/refresh-credentials`;
    const before = (limited.runtime.providers.storage as FakeStorage).callsOf("issueSts").length;
    expect(
      (await limited.request(path, { method: "POST", headers: owner.headers, peer: "198.19.75.1" }))
        .status,
    ).toBe(200);
    const response = await limited.request(path, {
      method: "POST",
      headers: owner.headers,
      peer: "198.19.75.1",
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "RATE_LIMITED" });
    expect((limited.runtime.providers.storage as FakeStorage).callsOf("issueSts")).toHaveLength(
      before + 1,
    );
  });
});
