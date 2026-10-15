// M2 的同键重放/预期错误只扩展请求边界；默认成功路径仍沿 M1 caller。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { allRoutes } from "@liyoxi/contract";
import type { operations as Merchant } from "@liyoxi/contract/types/merchant";
import type { operations as Admin } from "@liyoxi/contract/types/admin";
import type { M1Api } from "./in-process.js";
import type { M1Result, M1Headers } from "./runner-api.js";

type Operations = Merchant & Admin;
export type M2Operation = keyof Operations;
type Body<K extends M2Operation> = Operations[K] extends {
  requestBody?: { content: { "application/json": infer T } };
}
  ? T
  : never;
interface Input<K extends M2Operation> {
  body?: Body<K>;
  params?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string | number | boolean>>;
  key?: string;
}
export function createM2Http(api: M1Api) {
  async function request<K extends M2Operation>(
    operationId: K,
    headers: M1Headers = {},
    input: Input<K> = {},
  ) {
    const route = allRoutes.find((one) => one.operationId === operationId);
    assert.ok(route, `M2 实际契约缺 ${operationId}`);
    const path = route.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
      assert.ok(input.params?.[key], `M2 ${operationId} 缺 ${key}`);
      return encodeURIComponent(input.params[key]);
    });
    const query = new URLSearchParams(
      Object.entries(input.query ?? {}).map(
        ([key, value]) => [key, String(value)] as [string, string],
      ),
    ).toString();
    return api.request(`${path}${query ? `?${query}` : ""}`, {
      method: route.method.toUpperCase(),
      ...(input.body === undefined ? {} : { json: input.body }),
      headers: {
        ...headers,
        ...(route["x-idempotent"] === "required"
          ? { "Idempotency-Key": input.key ?? randomUUID() }
          : {}),
      },
    });
  }
  return {
    request,
    async call<K extends M2Operation>(
      operationId: K,
      headers: M1Headers = {},
      input: Input<K> = {},
    ) {
      const response = await request(operationId, headers, input);
      const raw: unknown = await response.json();
      if (response.status !== 200) {
        const symbol = raw && typeof raw === "object" && "error" in raw ? raw.error : "UNKNOWN";
        throw new Error(`M2 ${operationId}: HTTP ${response.status}, ${String(symbol)}`);
      }
      const definition = allRoutes.find((one) => one.operationId === operationId)?.responses[200];
      const media =
        definition && "content" in definition
          ? definition.content?.["application/json"]
          : undefined;
      const schema = media && "schema" in media ? media.schema : undefined;
      assert.ok(
        schema && "parse" in schema && typeof schema.parse === "function",
        `M2 ${operationId} 缺成功响应 schema`,
      );
      const parsed: unknown = schema.parse(raw);
      assert.ok(
        parsed && typeof parsed === "object" && "data" in parsed,
        `M2 ${operationId} 缺响应 data`,
      );
      return parsed.data as M1Result<K>;
    },
    async denied<K extends M2Operation>(
      operationId: K,
      headers: M1Headers,
      input: Input<K>,
      status: number,
      error: string,
    ) {
      const response = await request(operationId, headers, input);
      assert.equal(response.status, status, `${operationId} HTTP`);
      const body = (await response.json()) as {
        error: string;
        details?: { blockers?: { kind: string; count: number }[] };
      };
      assert.equal(body.error, error, operationId);
      return body;
    },
  };
}
export type M2Http = ReturnType<typeof createM2Http>;
