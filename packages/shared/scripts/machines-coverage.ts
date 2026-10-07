/**
 * 状态机覆盖检查的骨架（任务书 W0-12 第 7 节第 6 条；约定 C84 的契约自测；计划 第 5.7 节“状态机”行）：
 * 迁移表的每一行，要么被至少一个 operationId 的“触发的状态迁移”引用，要么出现在 x01 第 5 节的非 HTTP 迁移归属表里。
 *
 * 旧文档模式只出报告；W1-21 契约模式进入 CI。计划 第 5.5 节要求 M1 起必过，M8 退出覆盖 100%。
 * 行的身份是迁移表的 ref（“分组:行号”，约定 C81、C84 的写法），与文档引用它的写法是同一个。
 *
 * 引用来源是可以换的（REFERENCE_SOURCES）。M0 只有文档一侧的两个：
 *   - x01 的机器可读清单 docs/api/working/frag/x01-events-jobs.json：attributions[].ref
 *   - 各接口清单 docs/api/working/frag/<文档>.json：endpoints[].transitions 的文字里出现的行引用
 * 接口清单多数条目没有写行号，所以 M0 的数字只是起点。M1 起由路由元数据接替接口一侧的来源，并带 --strict 进门禁：
 * 那时改的是来源，判定“一行算不算被引用”的口径不变。
 *
 * W1-21 新增 --contract 模式：契约 operationId JOIN 文档真实 transitions；存量未覆盖行只减不增。
 * 旧来源和旧 --strict 的“未覆盖即失败”行为保留。基线中的行仍报告未覆盖，不能冒充引用。
 * 用法（在仓库根目录）：pnpm machines:coverage [-- --strict [--contract] [--baseline <文件>]]
 *   --strict  有没被引用的行即退出码 1
 * 退出码：0 报告完成（不带 --strict 时不论覆盖多少）；1 带 --strict 且有没被引用的行；2 环境错误或用法错误。
 */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CHAINS, type Chain } from "../src/machines/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const FRAG_DIR = join(repoRoot, "docs/api/working/frag");
const X01_FRAG = "x01-events-jobs.json";

/** 一处引用：谁引用了分组文档的哪一行 */
export interface Reference {
  /** “分组:行号” */
  ref: string;
  /** 引用方：operationId，或“x01 归属表（方式）” */
  by: string;
}

/**
 * 从一段文字里取行引用，统一成“分组:行号”。认两种写法：“08-billing-payment.md:164”与“08:164”；
 * 行号可以是区间（“173-187”）与顿号并列（“431、433-434”），都展开成逐行。
 */
export function parseRefs(text: string): string[] {
  const refs: string[] = [];
  const pattern = /(?<![\d.])(\d{2})(?:-[a-z-]+\.md)?:(\d+(?:-\d+)?(?:、\d+(?:-\d+)?)*)(?![\d:])/g;
  for (const match of text.matchAll(pattern)) {
    for (const part of match[2]!.split("、")) {
      const [first, last = first] = part.split("-").map(Number) as [number, number?];
      // 区间写反或跨度离谱的不展开（多半不是行引用）
      if (first < 1 || last < first || last - first > 200) continue;
      for (let line = first; line <= last; line += 1) refs.push(`${match[1]}:${line}`);
    }
  }
  return [...new Set(refs)];
}

/** 一个引用来源 */
export interface ReferenceSource {
  name: string;
  load(): Reference[];
}

const readFrag = (file: string) =>
  JSON.parse(readFileSync(join(FRAG_DIR, file), "utf8")) as unknown;

/** x01 第 5 节的归属表（机器可读清单里的 attributions） */
export const x01Attributions: ReferenceSource = {
  name: "x01 第 5 节归属表",
  load() {
    const frag = readFrag(X01_FRAG) as { attributions: { ref: string; via: string }[] };
    return frag.attributions.flatMap((item) =>
      parseRefs(item.ref).map((ref) => ({ ref, by: `x01 归属表（${item.via}）` })),
    );
  },
};

/** 各接口清单里“触发的状态迁移”的文字 */
export const apiFragTransitions: ReferenceSource = {
  name: "接口清单的 transitions",
  load() {
    return readdirSync(FRAG_DIR)
      .filter((file) => file.endsWith(".json") && file !== X01_FRAG)
      .sort()
      .flatMap((file) => {
        const frag = readFrag(file) as {
          endpoints?: { operationId: string; transitions?: string[] | null }[];
        };
        return (frag.endpoints ?? []).flatMap((endpoint) =>
          (endpoint.transitions ?? []).flatMap((text) =>
            parseRefs(text).map((ref) => ({ ref, by: endpoint.operationId })),
          ),
        );
      });
  },
};

/** 现在接上的来源。M1 起往这里加路由元数据的来源（或接替接口清单这一个） */
export const REFERENCE_SOURCES: readonly ReferenceSource[] = [x01Attributions, apiFragTransitions];

export interface ChainCoverage {
  column: string;
  /** 这条链的文档行（按 ref 去重）数 */
  total: number;
  /** 没被引用的行：ref 与它的事件码 */
  uncovered: { ref: string; events: string[] }[];
}

/** 逐条链算：哪些行没有被任何来源引用 */
export function coverageOf(
  chains: readonly Chain[],
  references: readonly Reference[],
): ChainCoverage[] {
  const referenced = new Set(references.map((item) => item.ref));
  return chains.map((item) => {
    const events = new Map<string, string[]>();
    for (const row of item.rows) events.set(row.ref, [...(events.get(row.ref) ?? []), row.event]);
    const uncovered = [...events]
      .filter(([ref]) => !referenced.has(ref))
      .map(([ref, codes]) => ({ ref, events: [...new Set(codes)] }));
    return { column: item.column, total: events.size, uncovered };
  });
}

export interface TransitionFragment {
  endpoints?: { operationId: string; transitions?: string[] | null }[];
}

/** 契约只有路由身份；迁移文字仍读取冻结文档，未登记接口不能贡献引用。 */
export function registeredReferences(
  routes: readonly { operationId: string }[],
  fragments: readonly TransitionFragment[],
): Reference[] {
  const ids = new Set<string>();
  for (const route of routes) {
    if (typeof route.operationId !== "string" || !route.operationId || ids.has(route.operationId))
      throw new Error("契约 operationId 必须非空且唯一");
    ids.add(route.operationId);
  }
  if (ids.size === 0) throw new Error("契约路由清单为空");
  return fragments.flatMap((frag) =>
    (frag.endpoints ?? []).flatMap((endpoint) =>
      ids.has(endpoint.operationId)
        ? (endpoint.transitions ?? []).flatMap((text) =>
            parseRefs(text).map((ref) => ({ ref, by: endpoint.operationId })),
          )
        : [],
    ),
  );
}

export const contractApiTransitions: ReferenceSource = {
  name: "契约 operationId JOIN 文档 transitions",
  load() {
    const routes = JSON.parse(
      readFileSync(join(repoRoot, "packages/contract/generated/routes.json"), "utf8"),
    ) as { operationId: string }[];
    const fragments = readdirSync(FRAG_DIR)
      .filter((file) => file.endsWith(".json") && file !== X01_FRAG)
      .sort()
      .map((file) => readFrag(file) as TransitionFragment);
    return registeredReferences(routes, fragments);
  },
};
export const CONTRACT_REFERENCE_SOURCES: readonly ReferenceSource[] = [
  x01Attributions,
  contractApiTransitions,
];
export const COVERAGE_BASELINE = join(repoRoot, "infra/ci/machines-coverage-baseline.jsonl");
export const coverageRowKey = (column: string, ref: string): string => `${column}|${ref}`;

/** 每行一个完整快照，后续集合必须是前一份的子集；存量原因不能偷偷改写。 */
export function baselineKeys(text: string, chains: readonly Chain[] = CHAINS): Set<string> {
  const known = new Set(
    chains.flatMap((item) => item.rows.map((row) => coverageRowKey(item.column, row.ref))),
  );
  const lines = text.trim().split("\n");
  if (text.trim() === "") throw new Error("覆盖基线为空文件");
  let previous: Map<string, string> | undefined;
  for (const [index, line] of lines.entries()) {
    const snapshot = JSON.parse(line) as {
      schemaVersion: number;
      rows: { column: string; ref: string; reason: string }[];
    };
    if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.rows))
      throw new Error(`覆盖基线第 ${index + 1} 行格式无效`);
    const current = new Map<string, string>();
    let lastKey = "";
    for (const row of snapshot.rows) {
      if (
        !row ||
        typeof row.column !== "string" ||
        typeof row.ref !== "string" ||
        typeof row.reason !== "string" ||
        !row.reason.trim()
      )
        throw new Error(`覆盖基线第 ${index + 1} 行缺少真实 row 键或原因`);
      const key = coverageRowKey(row.column, row.ref);
      if (!known.has(key)) throw new Error(`覆盖基线包含未知行：${key}`);
      if (current.has(key)) throw new Error(`覆盖基线重复行：${key}`);
      if (key < lastKey) throw new Error("覆盖基线行键必须排序");
      if (previous && !previous.has(key))
        throw new Error(`覆盖基线只减不增：第 ${index + 1} 行新增 ${key}`);
      if (previous?.has(key) && previous.get(key) !== row.reason)
        throw new Error(`覆盖基线保留行的原因不得改写：${key}`);
      current.set(key, row.reason);
      lastKey = key;
    }
    previous = current;
  }
  return new Set(previous!.keys());
}

export function missingBeyondBaseline(
  result: readonly ChainCoverage[],
  baseline: ReadonlySet<string>,
) {
  return result.flatMap((item) =>
    item.uncovered
      .filter((row) => !baseline.has(coverageRowKey(item.column, row.ref)))
      .map((row) => ({ column: item.column, ...row })),
  );
}

function main(): void {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  let baselinePath = COVERAGE_BASELINE;
  const baselineIndex = args.indexOf("--baseline");
  if (
    baselineIndex !== -1 &&
    args.includes("--contract") &&
    args[baselineIndex + 1] &&
    !args[baselineIndex + 1]!.startsWith("--")
  ) {
    baselinePath = resolve(args[baselineIndex + 1]!);
    args.splice(baselineIndex, 2);
  }
  const unknown = args.filter((arg) => arg !== "--strict" && arg !== "--contract");
  if (unknown.length > 0) {
    console.error(`状态机覆盖检查：不认识的参数 ${unknown.join(" ")}`);
    process.exit(2);
  }
  let loaded: { source: ReferenceSource; references: Reference[] }[];
  try {
    loaded = (args.includes("--contract") ? CONTRACT_REFERENCE_SOURCES : REFERENCE_SOURCES).map(
      (source) => ({ source, references: source.load() }),
    );
  } catch (error) {
    console.error(
      `状态机覆盖检查：没跑成。${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
  const result = coverageOf(
    CHAINS,
    loaded.flatMap((item) => item.references),
  );
  const total = result.reduce((sum, item) => sum + item.total, 0);
  const uncovered = result.reduce((sum, item) => sum + item.uncovered.length, 0);
  console.log(
    [
      args.includes("--contract")
        ? "状态机覆盖检查（契约模式）：迁移表的每一行有没有被登记接口或 x01 归属表引用"
        : "状态机覆盖检查（骨架，只报告）：迁移表的每一行有没有被接口或 x01 归属表引用",
      ...loaded.map(
        (item) =>
          `  来源“${item.source.name}”：${new Set(item.references.map((r) => r.ref)).size} 行被引用`,
      ),
      "",
      ...result.map((item) => {
        const head = `  ${item.column}：${item.total - item.uncovered.length} / ${item.total}`;
        if (item.uncovered.length === 0) return head;
        const rows = item.uncovered.map((row) => `${row.ref}（${row.events.join("、")}）`);
        return `${head}；没被引用：${rows.join("、")}`;
      }),
      "",
      `合计：${total - uncovered} / ${total} 行已被引用，${uncovered} 行还没有`,
    ].join("\n"),
  );
  if (args.includes("--contract")) {
    let baseline: Set<string>;
    try {
      baseline = baselineKeys(readFileSync(baselinePath, "utf8"));
    } catch (error) {
      console.error(`状态机覆盖检查：${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
    const missing = missingBeyondBaseline(result, baseline);
    console.log(
      `契约模式：${uncovered - missing.length} 行未覆盖但属于存量基线；${missing.length} 行未收录在基线（不将存量计作已覆盖）`,
    );
    if (args.includes("--strict") && missing.length > 0) {
      console.error(
        `状态机覆盖检查未通过（--strict --contract）：未收录在基线的行：${missing.map((row) => coverageRowKey(row.column, row.ref)).join("、")}`,
      );
      process.exit(1);
    }
    return;
  }
  if (args.includes("--strict") && uncovered > 0) {
    console.error("\n状态机覆盖检查未通过（--strict）：还有没被引用的行");
    process.exit(1);
  }
}

// 只在被直接执行时跑；被用例 import 时不跑
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
