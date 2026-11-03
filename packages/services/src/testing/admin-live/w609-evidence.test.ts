import { expect, it, vi } from "vitest";
import { uuidv7 } from "../../kernel/index.js";
import type { Env } from "../../kernel/index.js";
import { createW609EvidenceUploadController } from "./w609-evidence.js";
import type { W609EvidenceUploadFile, W609EvidenceUploadPorts } from "./w609-evidence.js";
const runId = "1234567890abcdef",
  scope = {
    runId,
    name: `lyx_test_admin_live_${runId}`,
    prefix: `lyx:test:admin_live_${runId}:`,
    startedAt: "2026-10-26T00:00:00.000Z",
    staffId: uuidv7(),
    entityId: uuidv7(),
    storeId: uuidv7(),
  };
const env: Pick<Env, "APP_ENV" | "DATABASE_URL" | "REDIS_URL"> = {
  APP_ENV: "test",
  DATABASE_URL: `postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/${scope.name}?options=-c%20role%3Dlyx_app`,
  REDIS_URL: "redis://127.0.0.1:6389/0",
};
function harness() {
  const files = new Map<string, W609EvidenceUploadFile>();
  const ports: W609EvidenceUploadPorts = {
    env,
    scope,
    prefix: scope.prefix,
    read: vi.fn(
      async (intent) =>
        [...files.values()].find(
          (file) =>
            file.clientToken === intent.clientToken &&
            (!intent.fileId || file.id === intent.fileId),
        ) ?? null,
    ),
    jobs: vi.fn(async () => [uuidv7()]),
    promote: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
  const file = (): W609EvidenceUploadFile => {
    const id = uuidv7(),
      token = uuidv7();
    return {
      id,
      category: "evidence",
      scopeType: "store",
      entityId: scope.entityId,
      storeId: scope.storeId,
      onBehalfStoreId: null,
      uploadActorType: "staff",
      uploadActorId: scope.staffId,
      uploadClient: "admin",
      clientToken: token,
      uploadBatchId: null,
      createdAt: new Date(scope.startedAt),
      status: "pending",
      ext: "png",
      bucket: "secure",
      objectKey: `evidence/${scope.storeId}/${token}.png`,
      incomingBucket: "secure",
      incomingKey: `incoming/${id}/${token}.png`,
    };
  };
  const request = (value: W609EvidenceUploadFile) =>
    new Request("http://127.0.0.1/api/v1/admin/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category: value.category,
        storeId: value.storeId,
        fileName: "fictional.png",
        sizeBytes: "100",
        clientToken: value.clientToken,
      }),
    });
  const response = (value: W609EvidenceUploadFile) =>
    Response.json({
      data: {
        fileId: value.id,
        clientToken: value.clientToken,
        status: "pending",
        mode: "post",
        bucket: "test-secure",
        region: "test",
        key: value.incomingKey,
        post: { url: "http://127.0.0.1/test-upload", fields: {} },
        sts: null,
        chunkSize: null,
        chunkParallel: null,
        expiresAt: "2026-10-26T00:10:00.000Z",
        uploadExpiresAt: "2026-10-26T00:10:00.000Z",
        credentialsLeft: 30,
      },
    });
  const complete = (id: string) =>
    new Request(`http://127.0.0.1/api/v1/admin/files/${id}/complete`, { method: "POST" });
  return { files, ports, file, request, response, complete };
}
it("只认本轮本地环境与唯一门店/本人/分类，八文件有界；其余请求走原handler且不扫描", async () => {
  const h = harness();
  for (const changed of [
    { ...h.ports, prefix: "lyx:test:foreign:" },
    { ...h.ports, scope: { ...scope, storeId: "invalid-store" } },
    { ...h.ports, env: { ...env, APP_ENV: "prod" as const } },
  ])
    expect(() => createW609EvidenceUploadController(changed)).toThrow();
  const pump = createW609EvidenceUploadController(h.ports),
    ignored = h.file();
  for (const value of [
    { ...ignored, storeId: uuidv7() },
    { ...ignored, category: "pay_receipt" },
    ignored,
  ])
    await pump.fetch(
      h.request(value),
      async () => h.response(value),
      async () => (value === ignored ? uuidv7() : scope.staffId),
    );
  expect(h.ports.read).not.toHaveBeenCalled();
  expect(h.ports.jobs).not.toHaveBeenCalled();
  for (let index = 0; index < 8; index++) {
    const file = h.file();
    h.files.set(file.id, file);
    await pump.fetch(
      h.request(file),
      async () => h.response(file),
      async () => scope.staffId,
    );
  }
  const overflow = vi.fn(async () => h.response(h.file()));
  await expect(
    pump.fetch(h.request(h.file()), overflow, async () => scope.staffId),
  ).rejects.toThrow("八文件");
  expect(overflow).not.toHaveBeenCalled();
  await pump.close();
  expect(h.ports.remove).toHaveBeenCalledTimes(16);
  expect(h.ports.promote).not.toHaveBeenCalled();
});
it("必须成功登记并真实complete后才按精确id找job；旧/外人complete和文件归属变更不执行", async () => {
  const h = harness(),
    pump = createW609EvidenceUploadController(h.ports),
    file = h.file();
  h.files.set(file.id, file);
  const original = Response.json({ data: { fileId: file.id, status: "promoting" } });
  const received = await pump.fetch(
    h.complete(file.id),
    async () => original,
    async () => scope.staffId,
  );
  expect(received).toBe(original);
  expect(h.ports.read).not.toHaveBeenCalled();
  await pump.fetch(
    h.request(file),
    async () => h.response(file),
    async () => scope.staffId,
  );
  await pump.fetch(
    h.complete(file.id),
    async () => Response.json({}),
    async () => uuidv7(),
  );
  expect(h.ports.jobs).not.toHaveBeenCalled();
  file.status = "promoting";
  await pump.fetch(
    h.complete(file.id),
    async () => new Response(null, { status: 409 }),
    async () => scope.staffId,
  );
  expect(h.ports.jobs).not.toHaveBeenCalled();
  const accepted = Response.json({ data: { fileId: file.id, status: "promoting" } });
  const forwarded = await pump.fetch(
    h.complete(file.id),
    async () => accepted,
    async () => scope.staffId,
  );
  expect(forwarded).toBe(accepted);
  expect(h.ports.jobs).toHaveBeenCalledWith(file.id);
  expect(h.ports.promote).toHaveBeenCalledTimes(1);
  file.entityId = uuidv7();
  await expect(
    pump.fetch(
      h.complete(file.id),
      async () => Response.json({}),
      async () => scope.staffId,
    ),
  ).rejects.toThrow("不属于");
  expect(h.ports.promote).toHaveBeenCalledTimes(1);
  file.entityId = scope.entityId;
  await pump.close();
  expect(h.ports.remove).toHaveBeenCalledTimes(2);
});
it("停机等在途promote，之后拒新意图；登记已提交应答丢失也只按原token回收本轮两对象", async () => {
  const h = harness(),
    pump = createW609EvidenceUploadController(h.ports),
    file = h.file();
  h.files.set(file.id, file);
  await expect(
    pump.fetch(
      h.request(file),
      async () => {
        throw new Error("应答丢失");
      },
      async () => scope.staffId,
    ),
  ).rejects.toThrow("应答丢失");
  await pump.fetch(
    h.request(file),
    async () => h.response(file),
    async () => scope.staffId,
  );
  file.status = "promoting";
  let resolve!: () => void, entered!: () => void;
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  vi.mocked(h.ports.promote).mockImplementation(() => {
    entered();
    return new Promise<void>((done) => {
      resolve = done;
    });
  });
  const pending = pump.fetch(
    h.complete(file.id),
    async () => Response.json({}),
    async () => scope.staffId,
  );
  await ready;
  const closed = pump.close();
  let done = false;
  void closed.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  const next = vi.fn(async () => Response.json({}));
  expect((await pump.fetch(h.request(h.file()), next, async () => scope.staffId)).status).toBe(503);
  expect(next).not.toHaveBeenCalled();
  resolve();
  await pending;
  await closed;
  expect(h.ports.remove).toHaveBeenCalledTimes(2);
  const lost = harness(),
    recovery = createW609EvidenceUploadController(lost.ports),
    committed = lost.file();
  lost.files.set(committed.id, committed);
  await expect(
    recovery.fetch(
      lost.request(committed),
      async () => {
        throw new Error("未知应答");
      },
      async () => scope.staffId,
    ),
  ).rejects.toThrow();
  await recovery.close();
  expect(lost.ports.remove).toHaveBeenCalledTimes(2);
});
