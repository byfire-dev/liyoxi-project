import { expect, it, vi } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { createBatchApi } from "./batch-api";
import { batchFixture, batchCredentials, batchId } from "./batch-test.fixture";
const handlers = (): ApiHandlers => ({
  redirectToLogin: vi.fn(),
  stepUp: vi.fn(async () => false),
  refreshAccess: vi.fn(),
  invalidateQueries: vi.fn(),
  notify: vi.fn(),
  showBlocked: vi.fn(),
  buildMismatch: vi.fn(),
});
it("八条真实typed路径、严格body与当前意图key，经现中央后台头发送", async () => {
  const requests: Request[] = [];
  const api = createBatchApi({
    api: createAdminApi({
      baseUrl: "https://fictional-admin.test",
      build: "w302",
      handlers: handlers(),
      fetch: async (request) => {
        requests.push(request.clone());
        const path = new URL(request.url).pathname;
        const data = path.endsWith("refresh-credentials")
          ? batchCredentials()
          : path.endsWith("complete")
            ? batchFixture().items[0]
            : path.endsWith("commit")
              ? { batch: batchFixture(), masters: [] }
              : batchFixture();
        return new Response(JSON.stringify({ code: 0, data, message: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
  });
  const body = {
    purpose: "final_release" as const,
    targetId: batchId(2),
    scope: "full" as const,
    isContentChanged: false,
    aiUsage: { used: false, tools: [] },
    files: [{ clientToken: "file-one", originalName: "第1集.mp4", sizeBytes: "1" }],
  };
  await api.create(body, "intent-create");
  await api.get(batchId(1));
  await api.start(batchId(1), true, "intent-start");
  await api.refresh(batchId(1));
  await api.update(batchId(101), { episodeNo: 1 }, "intent-map");
  await api.complete(batchId(101), "intent-complete");
  await api.cancel(batchId(1), "intent-cancel");
  await api.commit(batchId(1), "intent-master-only");
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["POST", "/api/v1/admin/upload-batches"],
    ["GET", `/api/v1/admin/upload-batches/${batchId(1)}`],
    ["POST", `/api/v1/admin/upload-batches/${batchId(1)}/start`],
    ["POST", `/api/v1/admin/upload-batches/${batchId(1)}/refresh-credentials`],
    ["PATCH", `/api/v1/admin/upload-batch-items/${batchId(101)}`],
    ["POST", `/api/v1/admin/upload-batch-items/${batchId(101)}/complete`],
    ["POST", `/api/v1/admin/upload-batches/${batchId(1)}/cancel`],
    ["POST", `/api/v1/admin/upload-batches/${batchId(1)}/commit`],
  ]);
  expect(await requests[0]!.json()).toEqual(body);
  expect(await requests[2]!.json()).toEqual({ acceptSequenceSuggestion: true });
  expect(await requests[4]!.json()).toEqual({ episodeNo: 1 });
  expect(requests[5]!.headers.get("Idempotency-Key")).toBe("intent-complete");
  expect(
    requests
      .filter((request) => request.method !== "GET")
      .every(
        (request) =>
          request.headers.get("X-LYX-Admin") === "1" && request.credentials === "same-origin",
      ),
  ).toBe(true);
});
it("续签受当前中央授权限制且不把403伪装为可上传；请求取消signal真实传递", async () => {
  const hooks = handlers();
  const requests: Request[] = [];
  const api = createBatchApi({
    api: createAdminApi({
      baseUrl: "https://fictional-admin.test",
      build: "w302",
      handlers: hooks,
      fetch: async (request) => {
        requests.push(request);
        return new Response(
          JSON.stringify({
            code: 40301,
            error: "PERMISSION_DENIED",
            message: "无权续签当前批次",
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      },
    }),
  });
  const controller = new AbortController();
  await expect(api.refresh(batchId(1), controller.signal)).rejects.toThrow(
    "没有该操作的权限，请联系管理员开通",
  );
  controller.abort();
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(hooks.refreshAccess).toHaveBeenCalledTimes(1);
});
