// 接口链与 CLI 共用的真实应用适配器；无 fakeAuth/中间件替换，无 Vitest。
import { security } from "@liyoxi/services";
import type { M1Support } from "@liyoxi/services/testing";
import { createApp } from "../../src/app.js";
import { provideMerchantDeps } from "../../src/merchant/services.js";
import { HANDLERS } from "../../src/routes/index.js";

export interface M1RequestInit extends Omit<RequestInit, "body" | "headers"> {
  readonly json?: unknown;
  /** 已编码的官方签名信封；与json互斥，不重新序列化。 */
  readonly rawBody?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly peer?: string;
}
export interface M1Api {
  readonly support: M1Support;
  /** HTTP 混跑使用真实等待；原接口测试默认仍使用可拨时钟。 */
  readonly waitForNextMfaStep?: () => Promise<void>;
  readonly waitUntil?: (at: Date) => Promise<void>;
  request(path: string, init?: M1RequestInit): Promise<Response>;
}
export function createM1Api(support: M1Support): M1Api {
  const { runtime } = support;
  provideMerchantDeps(runtime, {
    keyring: security.loadKeyring(runtime.env),
    appid: "wxlyxm1demo000001",
  });
  const api = createApp({ runtime, handlers: HANDLERS });
  api.readiness.state = "ready";
  return {
    support,
    async request(path, init = {}) {
      if (!path.startsWith("/api/v1/")) throw new Error("M1 只调用正式 API 路径");
      const host = path.startsWith("/api/v1/admin/") ? "admin.localhost" : "api.localhost";
      const { json, rawBody, headers = {}, peer = "198.19.0.1", ...rest } = init;
      if (json !== undefined && rawBody !== undefined) throw new Error("M1 正文输入互斥");
      return api.app.request(
        `http://${host}${path}`,
        {
          ...rest,
          headers: {
            host,
            ...(json === undefined ? {} : { "content-type": "application/json" }),
            ...headers,
          },
          ...(rawBody !== undefined
            ? { body: rawBody }
            : json === undefined
              ? {}
              : { body: JSON.stringify(json) }),
        },
        { incoming: { socket: { remoteAddress: peer } } },
      );
    },
  };
}
export async function m1Data<T>(response: Response, step = "API"): Promise<T> {
  const body = (await response.json()) as { data?: T; error?: string; message?: string };
  if (response.status !== 200 || body.data === undefined)
    throw new Error(`M1 ${step}：${response.status} ${body.error ?? "非成功响应"}`);
  return body.data;
}
