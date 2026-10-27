import { expect, it, vi } from "vitest";
import { uuidv7 } from "../../kernel/index.js";
import type { Env } from "../../kernel/index.js";
import { createInvoiceUploadController } from "./invoice-upload.js";
import type { InvoiceUploadFile, InvoiceUploadPorts } from "./invoice-upload.js";
const runId = "1234567890abcdef",
  scope = {
    runId,
    name: `lyx_test_admin_live_${runId}`,
    prefix: `lyx:test:admin_live_${runId}:`,
    startedAt: "2026-10-26T00:00:00.000Z",
    staffId: uuidv7(),
    entityIds: [uuidv7()],
  };
const env: Pick<Env, "APP_ENV" | "DATABASE_URL" | "REDIS_URL"> = {
  APP_ENV: "test",
  DATABASE_URL: `postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/${scope.name}?options=-c%20role%3Dlyx_app`,
  REDIS_URL: "redis://127.0.0.1:6389/0",
};
function harness() {
  const files = new Map<string, InvoiceUploadFile>();
  const ports: InvoiceUploadPorts = {
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
  const file = (): InvoiceUploadFile => {
    const id = uuidv7(),
      token = uuidv7();
    return {
      id,
      category: "invoice",
      scopeType: "entity",
      entityId: scope.entityIds[0]!,
      uploadActorType: "staff",
      uploadActorId: scope.staffId,
      uploadClient: "admin",
      clientToken: token,
      uploadBatchId: null,
      createdAt: new Date(scope.startedAt),
      status: "pending",
      ext: "pdf",
      bucket: "secure",
      objectKey: `invoice/${scope.entityIds[0]}/${token}.pdf`,
      incomingBucket: "secure",
      incomingKey: `incoming/${id}/${token}.pdf`,
    };
  };
  const request = (value: InvoiceUploadFile) =>
    new Request("http://127.0.0.1/api/v1/admin/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category: value.category,
        entityId: value.entityId,
        fileName: "fictional.pdf",
        sizeBytes: "100",
        clientToken: value.clientToken,
      }),
    });
  const response = (value: InvoiceUploadFile) =>
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
it("只认本轮本地环境与唯一实体/本人/分类，六文件有界；其余请求走原handler且不扫描", async () => {
  const h = harness();
  for (const changed of [
    { ...h.ports, prefix: "lyx:test:foreign:" },
    { ...h.ports, scope: { ...scope, entityIds: [scope.entityIds[0], scope.entityIds[0]] } },
    { ...h.ports, env: { ...env, APP_ENV: "prod" as const } },
  ])
    expect(() => createInvoiceUploadController(changed)).toThrow();
  const pump = createInvoiceUploadController(h.ports),
    ignored = h.file();
  for (const value of [
    { ...ignored, entityId: uuidv7() },
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
  for (let index = 0; index < 6; index++) {
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
  ).rejects.toThrow("六文件");
  expect(overflow).not.toHaveBeenCalled();
  await pump.close();
  expect(h.ports.remove).toHaveBeenCalledTimes(12);
  expect(h.ports.promote).not.toHaveBeenCalled();
});
it("必须成功登记并真实complete后才按精确id找job；旧/外人complete和文件归属变更不执行", async () => {
  const h = harness(),
    pump = createInvoiceUploadController(h.ports),
    file = h.file();
  h.files.set(file.id, file);
  await pump.fetch(
    h.complete(file.id),
    async () => Response.json({}),
    async () => scope.staffId,
  );
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
  await pump.fetch(
    h.complete(file.id),
    async () => Response.json({}),
    async () => scope.staffId,
  );
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
  file.entityId = scope.entityIds[0]!;
  await pump.close();
  expect(h.ports.remove).toHaveBeenCalledTimes(2);
});
it("停机等在途promote，之后拒新意图；登记已提交应答丢失也只按原token回收本轮两对象", async () => {
  const h = harness(),
    pump = createInvoiceUploadController(h.ports),
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
    recovery = createInvoiceUploadController(lost.ports),
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
