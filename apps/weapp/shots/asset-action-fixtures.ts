import { ApiError, type RequestLayer } from "../src/lib/request";
import type { FileStatus, UploadApi } from "../src/lib/upload/api";
import { createUpload } from "../src/lib/upload/queue";
import type { PortraitPorts } from "../src/sub/asset/private/portrait-platform";
import { assetDetail, assetId } from "./asset-fixtures";

type Call = { path: string; method: string; data?: unknown; key?: string };
type Fixture = {
  calls: Call[];
  submitted: boolean;
  portraitAttempts: number;
  partialFailed: boolean;
};
const fixtures = new Map<string, Fixture>();
const fixture = (scene: string) => {
  let value = fixtures.get(scene);
  if (!value) {
    value = { calls: [], submitted: false, portraitAttempts: 0, partialFailed: false };
    fixtures.set(scene, value);
  }
  (globalThis as { __LYX_ASSET_ACTION_CALLS__?: Call[] }).__LYX_ASSET_ACTION_CALLS__ = value.calls;
  return value;
};
const error = (symbol: string, status: number) =>
  new ApiError({ error: symbol, status, message: "private", requestId: "offline" });
function detail(scene: string, value: Fixture) {
  const result = assetDetail();
  result.uploader.role = scene.endsWith("clerk") ? "clerk" : "owner";
  result.actions = scene.includes("denied") ? [] : ["feedback", "portrait-auth"];
  result.usability = "need_portrait_auth";
  result.displayStatus = "need_portrait_auth";
  result.portraitAuth = { fileCount: value.submitted ? 2 : 0, authorizedAt: null };
  return result;
}
export function offlineAssetActionRequest(scene: string): RequestLayer["request"] {
  const value = fixture(scene);
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    value.calls.push({
      path,
      method: options?.method ?? "GET",
      data: options?.data,
      key: options?.idempotencyKey,
    });
    if (options?.method === "POST" && path.endsWith("/feedback")) {
      if (scene.includes("feedback-limit")) throw error("ASSET_FEEDBACK_DAILY_LIMIT", 409);
      return null as T;
    }
    if (options?.method === "POST" && path.endsWith("/portrait-auth")) {
      value.submitted = true;
      value.portraitAttempts++;
      if (scene.includes("unknown") && value.portraitAttempts === 1)
        throw error("NETWORK_ERROR", 0);
      return { ...detail(scene, value), replayed: value.portraitAttempts > 1 } as T;
    }
    if ((options?.method ?? "GET") === "GET" && path === `/m/store-assets/${assetId()}`)
      return detail(scene, value) as T;
    throw new Error("未登记素材详情增量入口");
  };
}
const status = (id: string, state: string): FileStatus => ({
  fileId: id,
  category: "portrait_auth",
  status: state,
  rejectReason: null,
  declaredSizeBytes: "32",
  sizeBytes: state === "stored" ? "32" : null,
  mime: "image/jpeg",
  moderationState: "pass",
  storedAt: null,
  uploadExpiresAt: null,
  createdAt: "2026-10-13T02:00:00.000Z",
});
export function assetActionPorts(scene: string, current: () => boolean): PortraitPorts {
  const value = fixture(scene),
    ids = new Map<string, string>();
  let sequence = 200;
  const files: UploadApi = {
    register: async (body) => {
      value.calls.push({ path: "/m/files", method: "POST", data: body });
      return {
        items: body.files.map((file) => {
          const id = ids.get(file.clientToken) ?? assetId(++sequence);
          ids.set(file.clientToken, id);
          return {
            fileId: id,
            clientToken: file.clientToken,
            status: "pending",
            mode: "post",
            bucket: "offline",
            region: "offline",
            key: "offline",
            post: { url: "https://offline.invalid/upload", fields: {} },
            sts: null,
            chunkSize: null,
            chunkParallel: null,
            expiresAt: "2099-10-13T02:00:00.000Z",
            uploadExpiresAt: "2099-10-13T02:00:00.000Z",
            credentialsLeft: 30,
          };
        }),
      };
    },
    complete: async (id, key) => {
      value.calls.push({ path: `/m/files/${id}/complete`, method: "POST", key });
      return status(id, "stored");
    },
    get: async (id) => status(id, "stored"),
    cancel: async (id, key) => {
      value.calls.push({ path: `/m/files/${id}/cancel`, method: "POST", key });
      return status(id, "expired");
    },
    refresh: async () => {
      throw new Error("离线凭据不刷新");
    },
  };
  return {
    choose: async (kind) =>
      [1, 2].map((n) => ({
        path: `/offline/portrait${n}.${kind === "pdf" ? "pdf" : "jpg"}`,
        name: `portrait${n}.${kind === "pdf" ? "pdf" : "jpg"}`,
        size: 32,
      })),
    fingerprint: async (file) => file.name,
    job: (file) =>
      createUpload(
        {
          api: files,
          context: () => ({ token: current() ? "offline" : null, storeId: "offline", revision: 0 }),
          head: async () => new Uint8Array([255, 216, 255]),
          post: () => ({
            abort: () => {},
            done:
              scene.includes("partial") && file.name.includes("2") && !value.partialFailed
                ? ((value.partialFailed = true), Promise.reject(new Error("第二份材料传输失败")))
                : Promise.resolve(),
          }),
          now: Date.now,
          sleep: async () => {},
          key: (action) => `${action}-${++sequence}`,
        },
        file,
        "portrait_auth",
      ),
    files,
    forget: () => {},
  };
}
