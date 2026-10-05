/**
 * 路由元数据对账（W0-10 任务书 第 7 节第 1、2、7 条；计划 第 5.7 节“路由元数据”一行）：
 * 拿契约里的路由清单（src/routes，规范化后就是 generated/routes.json 的内容）与路线图
 * docs/api/working/routemap.json 逐条逐字段比，一处不符即非 0 退出。接管之后代码为准：
 * 改接口同 PR 改契约、routemap.json 与分组文档，这里保证前两者一致（后两者一致由 tools/api-check 保证）。
 *
 * 用法（在仓库根目录）：
 *   pnpm contract:docs-check
 * 直接跑：tsx scripts/docs-check.ts [--write-golden]。只读文件，不连库。
 *   --write-golden  按当前的路由清单重写黄金文件。只在建立它、或单独的 gate-change PR 里用：
 *                   黄金文件是门禁文件（frozen），新增公开、可选、验签路由须评审（约定 C2）。
 *
 * 核对什么：
 *   集合      operationId（探活是登记键）的集合两边相同。
 *   逐字段    所属文档、方法、路径、摘要、x-auth、能力点、权限点、店员视图、幂等方式、约束名数组、
 *             幂等的理由（idempotentNote ↔ x-idempotent-reason）、x-step-up、版本、是否只登记。
 *             只登记的探活没有“理由”一栏，这一项不比。
 *   清单自查  routeCatalogProblems：每条都写了归属、权限点与能力点都在注册表里、skip 只用于驳回。
 *   资源段    约定 C10 里对着路由查的几条：V1.0 路由的路径里每个资源段都在资源登记里、参数名与登记一致、
 *             别名在登记过的别名之内（src/routes/resource-paths.ts）。
 *   黄金文件  x-auth 为 public、optional、signed 的路由集合与 golden/open-routes.json 一致，
 *             两条内网探活标“仅内网”（约定 C2）。
 *   C86       声明了 x-step-up: skip 的路由与约定 C86 登记表里的 operationId 双向一致。
 * 数量不写在本文件里：两边条数相等是“集合相同”的推论，这里只把数打印出来（共几条、各版本几条、
 * 只登记的几条、natural 几条、三种放开的鉴权各几条），供验收时看。
 * 退出码：0 通过；1 有差异；2 环境错误（文件读不了、表格认不出来）。
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ROUTE_PLACEMENTS,
  catalogResourcePathProblems,
  routeCatalog,
  routeCatalogProblems,
  type RouteCatalogEntry,
} from "../src/routes/index.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");

/** 对账读的文档（相对仓库根）。门禁自测的反例按这张表拷副本，多读一份文档时加在这里 */
export const SOURCE_PATHS = {
  routemap: "docs/api/working/routemap.json",
  conventions: "docs/api/00-conventions.md",
} as const;

/** 黄金文件（相对仓库根） */
export const GOLDEN_PATH = "packages/contract/golden/open-routes.json";

/** 不带鉴权门槛的三种取值：全量清单是黄金文件，新增须评审（约定 C2） */
export const OPEN_AUTH = ["public", "optional", "signed"] as const;
type OpenAuth = (typeof OPEN_AUTH)[number];

class EnvError extends Error {}

function readText(path: string): string {
  try {
    return readFileSync(join(repoRoot, path), "utf8");
  } catch (error) {
    throw new EnvError(`读不了 ${path}：${(error as Error).message}`);
  }
}

type Row = Readonly<Record<string, unknown>>;

/** 逐字段比的字段：[路线图与清单里的字段名, 报差异时的叫法] */
const FIELDS: readonly (readonly [keyof RouteCatalogEntry & string, string])[] = [
  ["doc", "所属文档"],
  ["method", "方法"],
  ["path", "路径"],
  ["summary", "摘要"],
  ["xAuth", "x-auth"],
  ["capability", "能力点"],
  ["permission", "权限点"],
  ["clerkView", "店员视图"],
  ["xIdempotent", "幂等方式"],
  ["idempotentBy", "约束名（x-idempotent-by）"],
  ["idempotentNote", "幂等的理由（x-idempotent-reason）"],
  ["xStepUp", "x-step-up"],
  ["version", "版本"],
  ["registryKeyOnly", "只登记（registryKeyOnly）"],
];

const show = (value: unknown): string => (value === undefined ? "（没有）" : JSON.stringify(value));
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** 契约的清单 ↔ 路线图：集合与逐字段 */
export function diffRoutemap(
  catalog: readonly RouteCatalogEntry[],
  routemap: readonly Row[],
): string[] {
  const problems: string[] = [];
  const mine = new Map(catalog.map((entry) => [entry.operationId, entry]));
  const theirs = new Map(routemap.map((row) => [String(row.operationId), row]));
  for (const id of theirs.keys()) {
    if (!mine.has(id)) problems.push(`路线图有而契约没有：${id}`);
  }
  for (const [id, entry] of mine) {
    const row = theirs.get(id);
    if (row === undefined) {
      problems.push(`契约有而路线图没有：${id}`);
      continue;
    }
    for (const [field, label] of FIELDS) {
      if (field === "idempotentNote" && entry.registryKeyOnly) continue;
      const left = (entry as unknown as Row)[field];
      if (!same(left, row[field])) {
        problems.push(`${id} 的${label}：契约是 ${show(left)}，路线图是 ${show(row[field])}`);
      }
    }
  }
  return problems;
}

/** 黄金文件里的一行：方法、路径、operationId；内网探活加“（仅内网）” */
const goldenLine = (entry: RouteCatalogEntry): string =>
  `${entry.method} ${entry.path} ${entry.operationId}${entry.internalOnly ? "（仅内网）" : ""}`;

export function openRoutes(catalog: readonly RouteCatalogEntry[]): Record<OpenAuth, string[]> {
  const lists: Record<OpenAuth, string[]> = { public: [], optional: [], signed: [] };
  for (const entry of catalog) {
    const auth = entry.xAuth as OpenAuth;
    if (OPEN_AUTH.includes(auth)) lists[auth].push(goldenLine(entry));
  }
  for (const auth of OPEN_AUTH) lists[auth].sort();
  return lists;
}

const GOLDEN_NOTES = [
  "黄金文件：x-auth 为 public、optional、signed 的全部路由（约定 C2）。这三种不带登录门槛，新增一条须评审。",
  "一行一条：方法、路径、operationId（探活是登记键）；只靠网络隔离的内网探活行尾标“（仅内网）”。",
  "pnpm contract:docs-check 拿它与契约的路由清单比，多一条、少一条、改一个字都失败。",
  "本文件是门禁文件（frozen）：只在单独的 gate-change PR 里改，用 tsx scripts/docs-check.ts --write-golden 重写。",
];

export function stringifyGolden(lists: Record<OpenAuth, string[]>): string {
  return `${JSON.stringify({ 说明: GOLDEN_NOTES, ...lists }, null, 2)}\n`;
}

/** 契约的清单 ↔ 黄金文件 */
export function diffGolden(catalog: readonly RouteCatalogEntry[], goldenText: string): string[] {
  let golden: Record<string, unknown>;
  try {
    golden = JSON.parse(goldenText) as Record<string, unknown>;
  } catch {
    throw new EnvError(`${GOLDEN_PATH} 不是合法的 JSON`);
  }
  const problems: string[] = [];
  const current = openRoutes(catalog);
  for (const auth of OPEN_AUTH) {
    const listed = golden[auth];
    if (!Array.isArray(listed)) throw new EnvError(`${GOLDEN_PATH} 里没有 ${auth} 这一组`);
    const want = new Set(listed.map(String));
    const have = new Set(current[auth]);
    for (const line of have) {
      if (!want.has(line)) {
        problems.push(
          `黄金文件：${auth} 路由不在黄金文件里：${line}（新增公开、可选、验签路由须评审）`,
        );
      }
    }
    for (const line of want) {
      if (!have.has(line)) problems.push(`黄金文件：黄金文件有而契约没有的 ${auth} 路由：${line}`);
    }
  }
  return problems;
}

/** 约定 C86 登记表里的 operationId：从“C86 驳回的再验证豁免”那一段起，取紧跟着的那张表的第一列 */
export function c86OperationIds(conventions: string): string[] {
  const start = conventions.indexOf("**C86 驳回的再验证豁免");
  if (start < 0) throw new EnvError(`${SOURCE_PATHS.conventions} 里找不到 C86 那一段`);
  const lines = conventions.slice(start).split("\n");
  const header = lines.findIndex((line) => /^\|\s*operationId\s*\|/.test(line));
  if (header < 0) throw new EnvError(`${SOURCE_PATHS.conventions} 的 C86 一段里找不到登记表`);
  const ids: string[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const id = /^\|\s*`([^`]+)`/.exec(line)?.[1];
    if (id === undefined)
      throw new EnvError(`C86 登记表有一行认不出 operationId：${line.slice(0, 60)}`);
    ids.push(id);
  }
  if (ids.length === 0) throw new EnvError("C86 登记表是空的");
  return ids;
}

export function diffStepUpSkip(
  catalog: readonly RouteCatalogEntry[],
  registered: readonly string[],
): string[] {
  const declared = new Set(
    catalog.filter((entry) => entry.xStepUp === "skip").map((e) => e.operationId),
  );
  const listed = new Set(registered);
  return [
    ...[...declared]
      .filter((id) => !listed.has(id))
      .map(
        (id) => `C86：${id} 声明了 x-step-up: skip，但不在约定 C86 的登记表里（新增须先改那张表）`,
      ),
    ...[...listed]
      .filter((id) => !declared.has(id))
      .map((id) => `C86：约定 C86 的登记表里有 ${id}，契约里它没有声明 x-step-up: skip`),
  ];
}

function countBy<T>(items: readonly T[], key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, count]) => `${name} ${count}`)
    .join("、");
}

function main(argv: readonly string[]): number {
  const unknown = argv.filter((arg) => arg !== "--write-golden");
  if (unknown.length > 0) {
    console.error(
      `不认识的参数 ${unknown.join(" ")}。用法：tsx scripts/docs-check.ts [--write-golden]`,
    );
    return 2;
  }
  if (argv.includes("--write-golden")) {
    writeFileSync(join(repoRoot, GOLDEN_PATH), stringifyGolden(openRoutes(routeCatalog)));
    console.log(`已按当前的路由清单重写 ${GOLDEN_PATH}`);
    return 0;
  }
  let routemap: Row[];
  try {
    routemap = JSON.parse(readText(SOURCE_PATHS.routemap)) as Row[];
  } catch (error) {
    if (error instanceof EnvError) throw error;
    throw new EnvError(`${SOURCE_PATHS.routemap} 不是合法的 JSON`);
  }
  const problems = [
    ...diffRoutemap(routeCatalog, routemap),
    ...routeCatalogProblems(routeCatalog, ROUTE_PLACEMENTS),
    ...catalogResourcePathProblems(routeCatalog),
    ...diffGolden(routeCatalog, readText(GOLDEN_PATH)),
    ...diffStepUpSkip(routeCatalog, c86OperationIds(readText(SOURCE_PATHS.conventions))),
  ];
  const open = openRoutes(routeCatalog);
  const summary = [
    `路由元数据 ${routeCatalog.length} 条（${countBy(routeCatalog, (entry) => entry.version)}）`,
    `只登记的探活 ${routeCatalog.filter((entry) => entry.registryKeyOnly).length} 条`,
    `natural ${routeCatalog.filter((entry) => entry.xIdempotent === "natural").length} 条`,
    `放开的鉴权 ${OPEN_AUTH.reduce((sum, auth) => sum + open[auth].length, 0)} 条（${OPEN_AUTH.map((auth) => `${auth} ${open[auth].length}`).join("、")}）`,
    `x-step-up: skip ${routeCatalog.filter((entry) => entry.xStepUp === "skip").length} 条`,
  ].join("；");
  if (problems.length > 0) {
    console.error(`路由元数据对账未通过，${problems.length} 处差异：\n- ${problems.join("\n- ")}`);
    console.error(`契约一侧：${summary}`);
    return 1;
  }
  console.log(
    `路由元数据对账通过：与 ${SOURCE_PATHS.routemap} 逐字段 0 差异，黄金文件与 C86 登记表一致。`,
  );
  console.log(summary);
  return 0;
}

// 只在被直接执行时跑；被测试 import 时不跑
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    console.error(`路由元数据对账：没跑成。${error.message}`);
    process.exit(2);
  }
}
