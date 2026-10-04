// 由登记表出三份 OpenAPI 3.1 文档：商家端、后台、下载页各一份（约定 C74）。
// 回调与只登记的探活不出文档。每份文档都登记通用结构与错误体。
// 做法：用空处理器把路由注册进 OpenAPIHono，只取文档，不启动服务。
import { OpenAPIHono } from "@hono/zod-openapi";

import { DictRefSchema, ErrorBodySchema, SentryEnvelopeSchema } from "./common/index.js";
import { routeGroupOf, type AnyContractRoute } from "./routes/builders.js";
import { routeRegistryProblems } from "./routes/registry.js";
import type { z } from "./zod.js";

/** 三份文档：名字即生成物的文件名前缀 */
export const OPENAPI_DOCUMENTS = {
  merchant: { group: "m", title: "狸有戏 · 商家端接口" },
  admin: { group: "admin", title: "狸有戏 · 后台接口" },
  portal: { group: "portal", title: "狸有戏 · 下载页接口" },
} as const;
export type OpenApiDocumentName = keyof typeof OPENAPI_DOCUMENTS;
export const OPENAPI_DOCUMENT_NAMES = Object.keys(OPENAPI_DOCUMENTS) as OpenApiDocumentName[];

/** V1.x 期间只有 /api/v1（约定 C76） */
export const OPENAPI_VERSION = "1.0.0";

export type OpenApiDocument = ReturnType<OpenAPIHono["getOpenAPI31Document"]>;

/** 每份文档都登记的结构：归“约定”的通用结构与错误体（约定 C22、C87） */
const COMMON_COMPONENTS: Readonly<Record<string, z.ZodType>> = {
  DictRef: DictRefSchema,
  ErrorBody: ErrorBodySchema,
  SentryEnvelope: SentryEnvelopeSchema,
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 键按码位排序，数组保持原序：同一输入两次生成字节相同，与声明顺序无关 */
function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const sorted: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key] as Json);
  return sorted;
}

/** 操作上值为 null 的 x- 键不出文档（null 表示“不设”） */
function dropNullExtensions(doc: OpenApiDocument): void {
  for (const pathItem of Object.values(doc.paths ?? {})) {
    for (const operation of Object.values(pathItem as Record<string, unknown>)) {
      if (typeof operation !== "object" || operation === null) continue;
      const record = operation as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key.startsWith("x-") && record[key] === null) delete record[key];
      }
    }
  }
}

const emptyHandler = () => new Response(null);

/** 一份文档：只含该组的路由 */
export function buildOpenApiDocument(
  name: OpenApiDocumentName,
  routes: readonly AnyContractRoute[],
): OpenApiDocument {
  const { group, title } = OPENAPI_DOCUMENTS[name];
  const app = new OpenAPIHono();
  for (const [refId, schema] of Object.entries(COMMON_COMPONENTS)) {
    app.openAPIRegistry.register(refId, schema);
  }
  for (const route of routes) {
    if (routeGroupOf(route) !== group) continue;
    app.openapi(route as never, emptyHandler as never);
  }
  const doc = app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title, version: OPENAPI_VERSION },
  });
  dropNullExtensions(doc);
  // 先过一遍 JSON：去掉 undefined，深拷贝掉路由对象里的引用
  return sortKeys(JSON.parse(JSON.stringify(doc)) as Json) as unknown as OpenApiDocument;
}

/** 三份文档。先核对登记表（重复的 operationId、绕开构造器的路由），有问题即抛错 */
export function buildOpenApiDocuments(
  routes: readonly AnyContractRoute[],
): Record<OpenApiDocumentName, OpenApiDocument> {
  const problems = routeRegistryProblems(routes);
  if (problems.length > 0) throw new Error(`路由登记表有问题：\n- ${problems.join("\n- ")}`);
  return {
    merchant: buildOpenApiDocument("merchant", routes),
    admin: buildOpenApiDocument("admin", routes),
    portal: buildOpenApiDocument("portal", routes),
  };
}

/** 生成物里的写法：两格缩进、结尾换行 */
export function stringifyOpenApiDocument(doc: OpenApiDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
