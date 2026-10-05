/**
 * 状态机覆盖检查的骨架（任务书 W0-12 第 7 节第 6 条；约定 C84 的契约自测；计划 第 5.7 节“状态机”行）：
 * 迁移表的每一行，要么被至少一个 operationId 的“触发的状态迁移”引用，要么出现在 x01 第 5 节的非 HTTP 迁移归属表里。
 *
 * 现在只出报告，不进 CI：计划 第 5.5 节把“状态机覆盖检查”放在 M1 起加的必过项里，M8 退出要求 100%。
 * 行的身份是迁移表的 ref（“分组:行号”，约定 C81、C84 的写法），与文档引用它的写法是同一个。
 *
 * 引用来源是可以换的（REFERENCE_SOURCES）。M0 只有文档一侧的两个：
 *   - x01 的机器可读清单 docs/api/working/frag/x01-events-jobs.json：attributions[].ref
 *   - 各接口清单 docs/api/working/frag/<文档>.json：endpoints[].transitions 的文字里出现的行引用
 * 接口清单多数条目没有写行号，所以 M0 的数字只是起点。M1 起由路由元数据接替接口一侧的来源，并带 --strict 进门禁：
 * 那时改的是来源，判定“一行算不算被引用”的口径不变。
 *
 * 用法（在仓库根目录）：pnpm machines:coverage [-- --strict]
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

function main(): void {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const unknown = args.filter((arg) => arg !== "--strict");
  if (unknown.length > 0) {
    console.error(`状态机覆盖检查：不认识的参数 ${unknown.join(" ")}`);
    process.exit(2);
  }
  let loaded: { source: ReferenceSource; references: Reference[] }[];
  try {
    loaded = REFERENCE_SOURCES.map((source) => ({ source, references: source.load() }));
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
      "状态机覆盖检查（骨架，只报告）：迁移表的每一行有没有被接口或 x01 归属表引用",
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
