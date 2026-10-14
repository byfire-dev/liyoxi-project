import { expect, it, vi } from "vitest";
import type { Env } from "../../kernel/index.js";
import { uuidv7 } from "../../kernel/index.js";
import { createMerchantAssetUploadController } from "./merchant-assets-upload.js";
import type {
  MerchantAssetUploadFile,
  MerchantAssetUploadPorts,
} from "./merchant-assets-upload.js";

const runId = "1234567890abcdef";
const env: Pick<Env, "APP_ENV" | "DATABASE_URL" | "REDIS_URL"> = {
  APP_ENV: "test",
  DATABASE_URL: `postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/lyx_test_admin_live_${runId}?options=-c%20role%3Dlyx_app`,
  REDIS_URL: "redis://127.0.0.1:6389/0",
};
const scope = {
  runId,
  name: `lyx_test_admin_live_${runId}`,
  prefix: `lyx:test:admin_live_${runId}:`,
  startedAt: "2026-10-14T00:00:00.000Z",
  staffId: uuidv7(),
  storeId: uuidv7(),
};
function harness() {
  const files = new Map<string, MerchantAssetUploadFile>();
  const ports: MerchantAssetUploadPorts = {
    env,
    prefix: scope.prefix,
    scope,
    read: vi.fn(
      async (intent) =>
        [...files.values()].find(
          (file) =>
            file.clientToken === intent.clientToken &&
            (intent.fileId === undefined || file.id === intent.fileId),
        ) ?? null,
    ),
    jobs: vi.fn(async () => [uuidv7()]),
    promote: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
  function file(category = "store_asset"): MerchantAssetUploadFile {
    const id = uuidv7(),
      token = uuidv7(),
      bucket = category === "store_asset" ? "asset" : "secure";
    return {
      id,
      category,
      scopeType: "store",
      storeId: scope.storeId,
      onBehalfStoreId: scope.storeId,
      uploadActorType: "staff",
      uploadActorId: scope.staffId,
      uploadClient: "admin",
      clientToken: token,
      createdAt: new Date(scope.startedAt),
      status: "pending",
      bucket,
      objectKey: `${category}/${scope.storeId}/${token}.png`,
      incomingBucket: bucket,
      incomingKey: `incoming/${id}/${token}.png`,
    };
  }
  const request = (file: MerchantAssetUploadFile, storeId = scope.storeId) =>
    new Request("http://127.0.0.1/api/v1/admin/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category: file.category,
        storeId,
        onBehalfStore: true,
        fileName: "fictional.png",
        sizeBytes: "68",
        clientToken: file.clientToken,
      }),
    });
  const registered = (file: MerchantAssetUploadFile) =>
    Response.json({
      data: {
        fileId: file.id,
        clientToken: file.clientToken,
        status: "pending",
        mode: "post",
        bucket: `test-${file.bucket}`,
        region: "test",
        key: file.incomingKey,
        post: { url: "http://127.0.0.1/test-upload", fields: {} },
        sts: null,
        chunkSize: null,
        chunkParallel: null,
        expiresAt: "2026-10-14T00:10:00.000Z",
        uploadExpiresAt: "2026-10-14T00:10:00.000Z",
        credentialsLeft: 30,
      },
    });
  return { files, ports, file, request, registered };
}

it("上传泵只接受本轮环境与本人本店登记，八文件有界且不干预外店/其他员工", async () => {
  const h = harness();
  for (const changed of [
    { ...h.ports, prefix: "lyx:test:foreign:" },
    { ...h.ports, scope: { ...scope, runId: "abcdef1234567890" } },
    { ...h.ports, env: { ...env, APP_ENV: "prod" as const } },
  ])
    expect(() => createMerchantAssetUploadController(changed)).toThrow();
  expect(h.ports.read).not.toHaveBeenCalled();
  const pump = createMerchantAssetUploadController(h.ports);
  const ignored = h.file();
  await pump.fetch(
    h.request(ignored, uuidv7()),
    async () => h.registered(ignored),
    async () => scope.staffId,
  );
  await pump.fetch(
    h.request(ignored),
    async () => h.registered(ignored),
    async () => uuidv7(),
  );
  expect(h.ports.read).not.toHaveBeenCalled();
  for (let index = 0; index < 8; index++) {
    const file = h.file(index % 2 ? "portrait_auth" : "store_asset");
    h.files.set(file.id, file);
    await pump.fetch(
      h.request(file),
      async () => h.registered(file),
      async () => scope.staffId,
    );
  }
  const ninth = vi.fn(async () => h.registered(h.file()));
  await expect(pump.fetch(h.request(h.file()), ninth, async () => scope.staffId)).rejects.toThrow(
    "八个",
  );
  expect(ninth).not.toHaveBeenCalled();
  await pump.close();
  expect(h.ports.remove).toHaveBeenCalledTimes(16);
  expect(h.ports.promote).not.toHaveBeenCalled();
});

it("真实登记记录只驱动complete后的精确promote；失败响应仍按原请求token回收对象", async () => {
  const h = harness(),
    pump = createMerchantAssetUploadController(h.ports),
    file = h.file();
  h.files.set(file.id, file);
  await pump.fetch(
    h.request(file),
    async () => h.registered(file),
    async () => scope.staffId,
  );
  expect(h.ports.promote).not.toHaveBeenCalled();
  file.status = "promoting";
  await pump.fetch(
    new Request(`http://127.0.0.1/api/v1/admin/files/${file.id}/complete`, { method: "POST" }),
    async () => Response.json({ data: { status: "promoting" } }),
    async () => scope.staffId,
  );
  expect(h.ports.jobs).toHaveBeenCalledExactlyOnceWith(file.id);
  expect(h.ports.promote).toHaveBeenCalledTimes(1);
  const failed = h.file("portrait_auth");
  h.files.set(failed.id, failed);
  await expect(
    pump.fetch(
      h.request(failed),
      async () => {
        throw new Error("response lost");
      },
      async () => scope.staffId,
    ),
  ).rejects.toThrow("response lost");
  const unrelated = h.file();
  h.files.set(unrelated.id, unrelated);
  await pump.close();
  expect(h.ports.remove).toHaveBeenCalledTimes(4);
  expect(h.ports.remove).not.toHaveBeenCalledWith({
    bucket: unrelated.bucket,
    key: unrelated.objectKey,
  });
});

it("停止先拒绝新请求、收完迟到登记再清对象；失败清理继续处理其余对象并传播", async () => {
  const h = harness(),
    pump = createMerchantAssetUploadController(h.ports),
    file = h.file();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const work = pump.fetch(
    h.request(file),
    async () => {
      started();
      await gate;
      h.files.set(file.id, file);
      return h.registered(file);
    },
    async () => scope.staffId,
  );
  await entering;
  pump.beginStop();
  const next = vi.fn(async () => h.registered(h.file()));
  expect((await pump.fetch(h.request(h.file()), next, async () => scope.staffId)).status).toBe(503);
  expect(next).not.toHaveBeenCalled();
  const closing = pump.close();
  expect(h.ports.remove).not.toHaveBeenCalled();
  release();
  await work;
  await closing;
  await pump.close();
  expect(h.ports.remove).toHaveBeenCalledTimes(2);
  const failed = harness(),
    other = createMerchantAssetUploadController(failed.ports),
    owned = failed.file();
  failed.files.set(owned.id, owned);
  await other.fetch(
    failed.request(owned),
    async () => failed.registered(owned),
    async () => scope.staffId,
  );
  vi.mocked(failed.ports.remove).mockRejectedValueOnce(new Error("delete unavailable"));
  await expect(other.close()).rejects.toThrow("未全部完成");
  expect(failed.ports.remove).toHaveBeenCalledTimes(2);
});
