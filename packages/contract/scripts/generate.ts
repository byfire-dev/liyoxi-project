/**
 * 契约生成脚本（约定 C74）：由路由登记表生成三份 OpenAPI 3.1 文档，再由文档出类型。
 *
 *   generated/merchant.openapi.json、admin.openapi.json、portal.openapi.json
 *   generated/merchant.d.ts、admin.d.ts、portal.d.ts
 *
 * 用法（在仓库根目录）：
 *   pnpm contract:generate   重新生成，写进 packages/contract/generated
 *   pnpm contract:check      重新生成后 git diff --exit-code：生成物与源码不一致即非 0 退出
 * 直接跑：tsx scripts/generate.ts [--out <目录>]，不给 --out 时写进本包的 generated/。
 *
 * 约定：
 *   - 生成物提交入库，只由本脚本写，不手改；冲突时变基后重新生成，不手工合并。
 *   - 输出稳定：键按码位排序、两格缩进、结尾换行；同一输入两次生成字节相同。
 *   - 回调（hooks）与只登记的探活不出文档。
 *   - 标了 x-open-enum 的枚举，生成的类型是“已知值 | (string & {})”（约定 C37）。
 *     这个转换只在本文件一处，后面的域包只调 openEnum()，不改这里。
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import openapiTS, { COMMENT_HEADER, astToString } from "openapi-typescript";

import {
  OPENAPI_DOCUMENT_NAMES,
  OPEN_ENUM_KEY,
  allRoutes,
  buildOpenApiDocuments,
  stringifyOpenApiDocument,
  type AnyContractRoute,
  type OpenApiDocument,
} from "../src/index.js";

/** 本包 generated/ 的绝对路径 */
export const GENERATED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../generated");

/** 开放枚举在出类型前临时加进 enum 的占位值；只存在于内存里，不进生成的 JSON */
const OPEN_ENUM_SENTINEL = "__lyx_open_enum__";
const OPEN_ENUM_TYPE = "(string & {})";

type JsonObject = { [key: string]: unknown };
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 深拷贝一份文档，并给每个标了 x-open-enum 的枚举补上占位值（放在 null 之前） */
function markOpenEnums(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(markOpenEnums);
  if (!isObject(value)) return value;
  const copy: JsonObject = {};
  for (const [key, child] of Object.entries(value)) copy[key] = markOpenEnums(child);
  if (copy[OPEN_ENUM_KEY] === true && Array.isArray(copy.enum)) {
    const known = copy.enum.filter((item) => item !== null);
    const nulls = copy.enum.filter((item) => item === null);
    copy.enum = [...known, OPEN_ENUM_SENTINEL, ...nulls];
  }
  return copy;
}

/** 由一份 OpenAPI 文档出类型声明 */
export async function renderTypes(doc: OpenApiDocument): Promise<string> {
  const ast = await openapiTS(markOpenEnums(doc) as never, { silent: true });
  const types = astToString(ast).replaceAll(JSON.stringify(OPEN_ENUM_SENTINEL), OPEN_ENUM_TYPE);
  return `${COMMENT_HEADER}${types}`;
}

/** 在内存里生成全部文件：文件名 → 内容。文件名按码位排序 */
export async function renderGenerated(
  routes: readonly AnyContractRoute[] = allRoutes,
): Promise<Map<string, string>> {
  const docs = buildOpenApiDocuments(routes);
  const files = new Map<string, string>();
  for (const name of [...OPENAPI_DOCUMENT_NAMES].sort()) {
    files.set(`${name}.d.ts`, await renderTypes(docs[name]));
    files.set(`${name}.openapi.json`, stringifyOpenApiDocument(docs[name]));
  }
  return files;
}

/** 生成并写盘，返回写了哪些文件 */
export async function generate(
  options: { outDir?: string; routes?: readonly AnyContractRoute[] } = {},
): Promise<string[]> {
  const outDir = options.outDir ?? GENERATED_DIR;
  const files = await renderGenerated(options.routes);
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of files) writeFileSync(join(outDir, name), content);
  return [...files.keys()];
}

async function main(argv: readonly string[]): Promise<void> {
  let outDir = GENERATED_DIR;
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === "--out" && value) {
      outDir = resolve(value);
      i += 1;
    } else {
      console.error(`不认识的参数 ${argv[i]}。用法：tsx scripts/generate.ts [--out <目录>]`);
      process.exit(2);
    }
  }
  const written = await generate({ outDir });
  console.log(`契约生成物已写入 ${outDir}（登记的路由 ${allRoutes.length} 条）：`);
  for (const name of written) console.log(`  ${name}`);
}

// 只在被直接执行时跑；被测试 import 时不跑。两边都取真实路径再比，免得符号链接下静默不执行
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  await main(process.argv.slice(2));
}
