import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { git, makeTempRepo, repoRoot, writeFiles } from "./helpers.js";

const GOLDEN = "apps/api/golden/clerk-visible-keys.snap";
const source = readFileSync(join(repoRoot, GOLDEN), "utf8");
const before = JSON.parse(source) as Record<string, string[]>;
const entries = Object.entries(before);
const canonical = (value: Record<string, unknown>) =>
  `${JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;
const candidates = ["m.aaa.get", "m.file.create", "m.zzz.get"] as const;
/** 候选可能成为真实路由；始终按输入基线选出未存在的键，不覆盖未来新增黄金。 */
function unusedOperationId(base: Record<string, unknown>, candidate: string): string {
  let key = candidate;
  for (let index = 1; Object.hasOwn(base, key); index += 1) {
    key = `${candidate}.clerkGate${index}`;
  }
  return key;
}
const additions = candidates.map((candidate) => unusedOperationId(before, candidate));
const lastAddition = additions[2]!;

interface Report {
  verdict: string;
  touch: Array<{ file: string; what: string }>;
  loosen: Array<{ file: string; what: string }>;
  outside: string[];
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** 真 Git 差分、真实门禁清单；不引入 API、库或服务运行时。 */
function classify(
  head: string | null,
  options: { base?: string | null; mutate?: (dir: string) => void } = {},
) {
  const base = options.base === undefined ? source : options.base;
  const temp = makeTempRepo("lyx-clerk-gate-", {
    ...(base === null ? {} : { [GOLDEN]: base }),
    "packages/contract/golden/open-routes.json": "[]\n",
  });
  cleanups.push(temp.cleanup);
  git(temp.dir, "commit", "-q", "-m", "base");
  if (head === null) rmSync(join(temp.dir, GOLDEN));
  else writeFiles(temp.dir, { [GOLDEN]: head });
  git(temp.dir, "add", "-A");
  options.mutate?.(temp.dir);
  git(temp.dir, "commit", "-q", "--allow-empty", "-m", "head");
  const out = join(temp.dir, "result.json");
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "infra/ci/classify-gate-changes.mjs"), "--base", "HEAD~1", "--out", out],
    { cwd: temp.dir, encoding: "utf8" },
  );
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    report: existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Report) : null,
  };
}

function rejected(head: string | null, reason: string, options?: Parameters<typeof classify>[1]) {
  const result = classify(head, options);
  expect(result.status, result.output).toBe(1);
  expect(result.report?.verdict).toBe("loosen");
  expect(result.report?.loosen.some((item) => item.what.includes(reason))).toBe(true);
  expect(result.output).toContain("没有 gate-change 标签");
}

describe("店员黄金新增完整 operationId 条目", () => {
  it("专用 kind 只登记 clerk 黄金，契约黄金仍冻结", () => {
    const registry = JSON.parse(
      readFileSync(join(repoRoot, "infra/ci/gate-files.json"), "utf8"),
    ) as {
      files: Array<{ pattern: string; kind: string }>;
    };
    expect(
      registry.files.filter((entry) => entry.kind === "clerk-golden").map((entry) => entry.pattern),
    ).toEqual([GOLDEN]);
    expect(
      registry.files.find((entry) => entry.pattern === "packages/contract/golden/**")?.kind,
    ).toBe("frozen");
  });

  it.each(additions)("新增 %s 可排在旧条目前、中、后，当前全部旧条目逐项保持", (operationId) => {
    expect(Object.hasOwn(before, operationId)).toBe(false);
    const next = { ...before, [operationId]: ["fileId", "url"] };
    for (const [key, value] of entries) expect(next[key]).toEqual(value);
    const result = classify(canonical(next));
    expect(result.status, result.output).toBe(0);
    expect(result.report).toMatchObject({
      verdict: "touch",
      touch: [{ file: GOLDEN, what: `新增店员黄金条目 ${operationId}` }],
      loosen: [],
      outside: [],
    });
  });

  it("同一次生成可新增多条路由，空响应的字符串数组也可为空", () => {
    const [first, last] = [additions[0]!, lastAddition];
    const result = classify(canonical({ ...before, [first]: [], [last]: ["item"] }));
    expect(result.status, result.output).toBe(0);
    expect(result.report?.touch.map((item) => item.what)).toEqual([
      `新增店员黄金条目 ${first}`,
      `新增店员黄金条目 ${last}`,
    ]);
    expect(result.report?.loosen).toEqual([]);
  });

  it("基线已有 m.file.create 及其他候选时仍可新增路由，旧条目逐项不变", () => {
    const base = { ...before };
    for (const candidate of candidates) {
      if (!Object.hasOwn(base, candidate)) base[candidate] = ["alreadyVisible"];
    }
    const fresh = candidates.map((candidate) => unusedOperationId(base, candidate));
    for (const key of fresh) expect(Object.hasOwn(base, key)).toBe(false);
    const next = { ...base, ...Object.fromEntries(fresh.map((key) => [key, ["newVisible"]])) };
    for (const [key, value] of Object.entries(base)) expect(next[key]).toEqual(value);
    const result = classify(canonical(next), { base: canonical(base) });
    expect(result.status, result.output).toBe(0);
    expect(result.report).toMatchObject({
      verdict: "touch",
      touch: fresh.map((key) => ({ file: GOLDEN, what: `新增店员黄金条目 ${key}` })),
      loosen: [],
    });
  });

  it("不扩展其他 frozen 的判法", () => {
    rejected(source, "改了公开、可选、验签路由的黄金文件", {
      mutate(dir) {
        writeFiles(dir, { "packages/contract/golden/open-routes.json": '["m.aaa.get"]\n' });
        git(dir, "add", "-A");
      },
    });
  });
});

describe("旧条目的键和字段路径数组全部冻结", () => {
  it.each(entries)("%s 增加一个旧值路径仍判放松", (key, value) => {
    rejected(
      canonical({ ...before, [key]: [...value, "extra"], [lastAddition]: [] }),
      `旧条目 ${key}`,
    );
  });

  it.each(entries)("%s 删除旧 operationId 仍判放松", (key) => {
    const next: Record<string, string[]> = { ...before, [lastAddition]: [] };
    delete next[key];
    rejected(canonical(next), `删掉了店员黄金旧条目 ${key}`);
  });

  it.each(entries.filter(([, value]) => value.length > 0))(
    "%s 删除或改动旧值路径仍判放松",
    (key, value) => {
      rejected(canonical({ ...before, [key]: value.slice(1) }), `旧条目 ${key}`);
      rejected(canonical({ ...before, [key]: ["changed", ...value.slice(1)] }), `旧条目 ${key}`);
    },
  );

  it("数组重排不是新增路由", () => {
    const [key, value] = entries.find(([, paths]) => paths.length > 1)!;
    rejected(canonical({ ...before, [key]: [...value].reverse() }), `旧条目 ${key}`);
  });

  it("同形对象不能替代旧字符串数组", () => {
    const [key, value] = entries[0]!;
    rejected(canonical({ ...before, [key]: { ...value } }), "完整对象");
  });
});

describe("不完整、歧义与类型不符的 JSON 保守拒绝", () => {
  it.each([
    ["JSON 截断", source.slice(0, -3)],
    ["尾逗号", source.replace(/\n}\n$/, ",\n}\n")],
    ["顶层数组", "[]\n"],
    ["null", "null\n"],
    ["字符串", '"object"\n'],
    ["新值不是数组", canonical({ ...before, "m.zzz.get": "field" })],
    ["数组含对象", canonical({ ...before, "m.zzz.get": [{ key: "field" }] })],
    ["数组含数字", canonical({ ...before, "m.zzz.get": [1] })],
    ["数组含 null", canonical({ ...before, "m.zzz.get": [null] })],
    ["空 operationId", canonical({ ...before, "": [] })],
    ["重复旧键", source.replace("{\n", `{\n  ${JSON.stringify(entries[0]![0])}: [],\n`)],
    [
      "重复新键",
      canonical({ ...before, "m.zzz.get": [] }).replace(/\n}\n$/, ',\n  "m.zzz.get": []\n}\n'),
    ],
    [
      "转义的同名键",
      canonical({ ...before, "m.zzz.get": [] }).replace(
        /\n}\n$/,
        ',\n  "m.\\u007azz.get": []\n}\n',
      ),
    ],
    ["缺尾换行", canonical({ ...before, "m.zzz.get": [] }).trimEnd()],
    ["单空格缩进", `${JSON.stringify({ ...before, "m.zzz.get": [] }, null, 1)}\n`],
    ["重排顶层键", `${JSON.stringify({ "m.zzz.get": [], ...before }, null, 2)}\n`],
    ["多余空白", `${canonical({ ...before, "m.zzz.get": [] })}\n`],
    [
      "转义字符串",
      canonical({ ...before, "m.zzz.get": ["field"] }).replace('"field"', '"\\u0066ield"'),
    ],
  ])("%s 判放松", (_name, text) => {
    rejected(text!, "改后的店员黄金无效");
  });

  it.each([
    "[]\n",
    "null\n",
    source.trimEnd(),
    source.replace("{\n", '{\n  "m.zzz.get": [],\n  "m.zzz.get": [],\n'),
  ])("基线也必须是无歧义的 canonical 完整对象", (base) => {
    rejected(canonical({ ...before, "m.zzz.get": [] }), "基线上的店员黄金无效", { base });
  });
});

describe("黄金的文件类型、属性和存在性保护", () => {
  it("删整份黄金不能伪装成增量", () => rejected(null, "删除了门禁文件"));
  it("没有基线的整份新建保守判放松", () => {
    rejected(canonical(before), "已有普通文件", { base: null });
  });
  it("内容不变但 executable 属性改变不能算无门禁改动", () => {
    rejected(source, "文件类型或属性有变", {
      mutate: (dir) => {
        git(dir, "update-index", "--chmod=+x", GOLDEN);
      },
    });
  });
  it("新增条目同时改文件属性也判放松", () => {
    rejected(canonical({ ...before, "m.zzz.get": [] }), "文件类型或属性有变", {
      mutate: (dir) => {
        git(dir, "update-index", "--chmod=+x", GOLDEN);
      },
    });
  });
  it("符号链接即使 Git 存的目标名是合法 canonical JSON 也拒绝", () => {
    rejected(source, "已有普通文件", {
      mutate(dir) {
        rmSync(join(dir, GOLDEN));
        symlinkSync(canonical({ "m.zzz.get": [] }), join(dir, GOLDEN));
        git(dir, "add", "-A");
      },
    });
  });
});
