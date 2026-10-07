// W1-21：方法/路径/响应验证来自实际契约；调用方的 body 来自生成的 operation 类型。
import { randomUUID } from "node:crypto";
import { allRoutes } from "@liyoxi/contract";
import type { operations as MerchantOperations } from "@liyoxi/contract/types/merchant";
import type { operations as AdminOperations } from "@liyoxi/contract/types/admin";
import type { M1Api } from "./in-process.js";

type Operations = MerchantOperations & AdminOperations;
type Operation = keyof Operations;
type Body<K extends Operation> = Operations[K] extends {
  requestBody?: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type M1Result<K extends Operation> = Operations[K] extends {
  responses: { 200: { content: { "application/json": { data: infer R } } } };
}
  ? R
  : never;
interface Input<K extends Operation> {
  readonly body?: Body<K>;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
}
export type M1Headers = Readonly<Record<string, string>>;

export function createM1Caller(api: M1Api) {
  return async function call<K extends Operation>(
    operationId: K,
    headers: M1Headers = {},
    input: Input<K> = {},
  ): Promise<M1Result<K>> {
    const route = allRoutes.find((r) => r.operationId === operationId);
    if (!route) throw new Error(`M1 路由尚未带生产结构：${operationId}`);
    const path = route.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
      const value = input.params?.[key];
      if (!value) throw new Error(`M1 ${operationId} 缺路径参数 ${key}`);
      return encodeURIComponent(value);
    });
    const query = new URLSearchParams(
      Object.entries(input.query ?? {}).map(
        ([key, value]) => [key, String(value)] as [string, string],
      ),
    ).toString();
    const response = await api.request(`${path}${query ? `?${query}` : ""}`, {
      method: route.method.toUpperCase(),
      ...(input.body === undefined ? {} : { json: input.body }),
      headers: {
        ...headers,
        ...(route["x-idempotent"] === "required" ? { "Idempotency-Key": randomUUID() } : {}),
      },
    });
    const raw: unknown = await response.json();
    if (response.status !== 200) {
      const symbol = raw && typeof raw === "object" && "error" in raw ? raw.error : "UNKNOWN";
      // 不输出带密码/令牌/手机号/签名地址的请求或完整响应。
      throw new Error(`M1 ${operationId}: HTTP ${response.status}, ${String(symbol)}`);
    }
    const definition = route.responses[200];
    const media =
      definition && "content" in definition ? definition.content?.["application/json"] : undefined;
    const schema = media && "schema" in media ? media.schema : undefined;
    if (!schema || !("parse" in schema) || typeof schema.parse !== "function") {
      throw new Error(`M1 ${operationId} 缺成功响应 schema`);
    }
    const parsed: unknown = schema.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
      throw new Error(`M1 ${operationId} 缺响应 data`);
    }
    // schema 已验证实际 operation 的完整响应；这里接回生成类型，未用 any。
    return parsed.data as M1Result<K>;
  };
}
