/**
 * 路由元数据接管脚本（W0-10，一次性）：读 docs/api/working/routemap.json，按“一份接口文档一个目录、
 * 一个顶层资源一个文件”写出 src/routes/<文档>/<资源>.ts、各目录的 index.ts 与汇总 src/routes/docs.ts。
 *
 * 已经跑过，留档备查：不进 CI，也不在 package.json 的脚本里。接管之后契约以 src/routes 为准，
 * 改接口是直接改那里的文件（同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账），
 * 不再用本脚本覆盖。目标目录已经存在时本脚本拒绝执行，除非带 --force。
 *
 * 用法（在 packages/contract 下）：tsx scripts/takeover.ts [--force]，跑完再用 prettier 排一遍。
 *
 * 写法：
 *   - 文件名取路径里组名之后的第一段（/admin/alerts/{alertId}/claim → alerts.ts）；回调取渠道名
 *     （/hooks/wechatpay/transactions → wechatpay.ts）；五条探活放 probes.ts。
 *   - 导出名取 operationId 的驼峰（m.session.create → mSessionCreate）。
 *   - 与缺省值相同的 x-auth 不写（商家端 member、后台 staff）；能力点为空不写；后台的权限点为空写 null。
 *   - idempotentNote 进 x-idempotent-reason，GET 也照写；xStepUp 照抄；registryKeyOnly 的只登记。
 *   - 归属的里程碑与版本不在这里，在 src/routes/milestones.ts。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const ROUTES_DIR = join(packageDir, "src/routes");

interface RoutemapEntry {
  operationId: string;
  doc: string;
  method: string;
  path: string;
  summary: string;
  xAuth: string;
  capability: string | null;
  permission: string | null;
  clerkView: string | null;
  xIdempotent: string;
  idempotentBy: string[] | null;
  idempotentNote: string | null;
  xStepUp?: string;
  registryKeyOnly?: boolean;
}

const GROUPS = {
  m: { fn: "merchantMeta", fallbackAuth: "member" },
  admin: { fn: "adminMeta", fallbackAuth: "staff" },
  portal: { fn: "portalMeta", fallbackAuth: null },
  hooks: { fn: "hookMeta", fallbackAuth: "signed" },
} as const;
type Group = keyof typeof GROUPS;

/** 文档在汇总里的先后：商家端、后台、下载页、回调（07 第 1 节的顺序） */
const DOC_ORDER = ["m", "a", "p", "h"];

const camel = (text: string): string =>
  text.replace(/[-.]([a-zA-Z0-9])/g, (_, ch: string) => ch.toUpperCase());
const constName = (doc: string): string => doc.replaceAll("-", "_").toUpperCase();
const str = (value: string): string => JSON.stringify(value);

function fileOf(entry: RoutemapEntry): string {
  if (entry.registryKeyOnly) return "probes";
  const segment = entry.path.split("/")[2];
  if (!segment) throw new Error(`${entry.operationId} 的路径 ${entry.path} 没有资源段`);
  return segment;
}

function renderEntry(entry: RoutemapEntry): string {
  const name = camel(entry.operationId);
  if (entry.registryKeyOnly) {
    return [
      `export const ${name} = registryOnly({`,
      `  registryKey: ${str(entry.operationId)},`,
      `  path: ${str(entry.path)},`,
      `  summary: ${str(entry.summary)},`,
      `});`,
    ].join("\n");
  }
  const group = entry.operationId.slice(0, entry.operationId.indexOf(".")) as Group;
  const { fn, fallbackAuth } = GROUPS[group];
  const method = entry.method.toLowerCase();
  const lines = [
    `export const ${name} = ${fn}({`,
    `  method: ${str(method)},`,
    `  path: ${str(entry.path)},`,
    `  operationId: ${str(entry.operationId)},`,
    `  summary: ${str(entry.summary)},`,
  ];
  if (entry.xAuth !== fallbackAuth) lines.push(`  "x-auth": ${str(entry.xAuth)},`);
  if (group === "admin") {
    lines.push(`  "x-permission": ${entry.permission === null ? "null" : str(entry.permission)},`);
  } else if (entry.capability !== null) {
    lines.push(`  "x-capability": ${str(entry.capability)},`);
  }
  if (group === "m") lines.push(`  "x-clerk-view": ${str(entry.clerkView ?? "")},`);
  if (entry.xStepUp !== undefined) lines.push(`  "x-step-up": ${str(entry.xStepUp)},`);
  if (method !== "get") lines.push(`  "x-idempotent": ${str(entry.xIdempotent)},`);
  if (entry.idempotentBy !== null) {
    lines.push(`  "x-idempotent-by": [${entry.idempotentBy.map(str).join(", ")}],`);
  }
  if (entry.idempotentNote !== null) {
    lines.push(`  "x-idempotent-reason": ${str(entry.idempotentNote)},`);
  }
  lines.push(`});`);
  return lines.join("\n");
}

function docTitle(doc: string): string {
  const first = readFileSync(join(repoRoot, "docs/api", `${doc}.md`), "utf8").split("\n", 1)[0];
  return (first ?? "").replace(/^#\s*/, "");
}

function main(argv: readonly string[]): void {
  const force = argv.includes("--force");
  const routemap = JSON.parse(
    readFileSync(join(repoRoot, "docs/api/working/routemap.json"), "utf8"),
  ) as RoutemapEntry[];

  const byDoc = new Map<string, Map<string, RoutemapEntry[]>>();
  for (const entry of routemap) {
    const files = byDoc.get(entry.doc) ?? new Map<string, RoutemapEntry[]>();
    byDoc.set(entry.doc, files);
    const file = fileOf(entry);
    files.set(file, [...(files.get(file) ?? []), entry]);
  }
  const docs = [...byDoc.keys()].sort(
    (a, b) =>
      DOC_ORDER.indexOf(a.charAt(0)) - DOC_ORDER.indexOf(b.charAt(0)) || a.localeCompare(b, "en"),
  );

  if (!force) {
    const existing = docs.filter((doc) => existsSync(join(ROUTES_DIR, doc)));
    if (existing.length > 0) {
      console.error(
        `接管已经做过（${existing.length} 个文档目录已存在）。契约以 src/routes 为准，不再由本脚本覆盖；确要重跑带 --force。`,
      );
      process.exit(2);
    }
  }

  let fileCount = 0;
  for (const doc of docs) {
    const title = docTitle(doc);
    const files = [...(byDoc.get(doc) ?? new Map<string, RoutemapEntry[]>())].sort(([a], [b]) =>
      a.localeCompare(b, "en"),
    );
    mkdirSync(join(ROUTES_DIR, doc), { recursive: true });
    for (const [file, entries] of files) {
      const fns = new Set<string>();
      for (const entry of entries) {
        if (entry.registryKeyOnly) fns.add("registryOnly");
        else
          fns.add(GROUPS[entry.operationId.slice(0, entry.operationId.indexOf(".")) as Group].fn);
      }
      const metaFns = [...fns].filter((fn) => fn !== "registryOnly").sort();
      const imports = [
        ...(fns.has("registryOnly") ? [`import { registryOnly } from "../builders.js";`] : []),
        ...(metaFns.length > 0 ? [`import { ${metaFns.join(", ")} } from "../meta-only.js";`] : []),
      ];
      const content = [
        `// ${title} · ${file}（docs/api/${doc}.md）。由 routemap.json 接管（W0-10），之后以本文件为准：`,
        `// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。`,
        ...imports,
        "",
        entries.map(renderEntry).join("\n\n"),
        "",
      ].join("\n");
      writeFileSync(join(ROUTES_DIR, doc, `${file}.ts`), content);
      fileCount += 1;
    }
    const index = [
      `// ${title}（docs/api/${doc}.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。`,
      `// 加资源文件时在这里加一行 import，并放进下面的数组。`,
      `import { defineRouteDoc } from "../doc.js";`,
      "",
      ...files.map(([file]) => `import * as ${camel(file)} from "./${file}.js";`),
      "",
      `export const ${constName(doc)} = defineRouteDoc(${str(doc)}, [`,
      ...files.map(([file]) => `  ${camel(file)},`),
      `]);`,
      "",
    ].join("\n");
    writeFileSync(join(ROUTES_DIR, doc, "index.ts"), index);
  }

  const docsFile = [
    `// 全部接口文档的路由，一份文档一个目录。顺序：商家端、后台、下载页、回调与探活（07 第 1 节）。`,
    `// 加一份接口文档：建目录与 index.ts，在这里加一行 import，并放进下面的数组。`,
    ...docs.map((doc) => `import { ${constName(doc)} } from "./${doc}/index.js";`),
    "",
    `export const ROUTE_DOCS = [`,
    ...docs.map((doc) => `  ${constName(doc)},`),
    `] as const;`,
    "",
  ].join("\n");
  writeFileSync(join(ROUTES_DIR, "docs.ts"), docsFile);

  console.log(
    `接管完成：${routemap.length} 条，${docs.length} 份文档，${fileCount} 个资源文件。接着跑 prettier 与 pnpm contract:generate。`,
  );
}

main(process.argv.slice(2));
