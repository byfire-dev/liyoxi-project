// 任务进程的构建（W0-23）：node scripts/build.mjs。产物在 dist/：index.js（任务进程）、redis-compat.js（兼容脚本）、
// seed.js（播种的镜像内入口，W1-22）、staff-bootstrap.js（建第一位超级管理员的引导命令，W1-01a）。
// 工作区的包都是源码包，连同第三方依赖一起打进产物；下面列出的包保留运行时模块边界或要读自己包里的文件，
// 不能打进去，所以也写在本包的 dependencies 里，产物从 apps/worker/node_modules 解析得到。
// 02 第 3.3 节定的构建工具是 tsup，它就是包了一层 esbuild；tsup 8.5.1 的依赖 chokidar@4.0.3 过不了
// 可信级别检查（pnpm-workspace.yaml 的 trustPolicy），装不上，这里直接用锁文件里已有的 esbuild。
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isBuiltin } from "node:module";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const EXTERNAL = [
  "bullmq",
  "ioredis",
  "mammoth",
  "sanitize-html",
  "pdfjs-dist",
  "@napi-rs/canvas",
  "tencentcloud-sdk-nodejs-ocr",
];

function version() {
  if (process.env.LYX_BUILD_VERSION) return process.env.LYX_BUILD_VERSION;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { outdir: { type: "string", default: "dist" } } });
const outdir = relative(root, resolve(root, values.outdir));
if (!outdir || outdir.startsWith("..")) throw new Error("--outdir must remain inside apps/worker");
mkdirSync(`${root}${outdir}`, { recursive: true });
for (const entry of readdirSync(`${root}${outdir}`, { withFileTypes: true })) {
  if (entry.isFile() && /\.js(\.map)?$/.test(entry.name)) rmSync(`${root}${outdir}/${entry.name}`);
}
const options = {
  absWorkingDir: root,
  entryPoints: {
    index: "src/index.ts",
    "redis-compat": "src/cli/redis-compat.ts",
    seed: "src/cli/seed.ts",
    "staff-bootstrap": "src/cli/staff-bootstrap.ts",
    "staff-reissue-activation": "src/cli/staff-reissue-activation.ts",
    "sms-init": "src/cli/sms-init.ts",
    "alerts-ack": "src/cli/alerts-ack.ts",
    "refund-abandon-txn": "src/cli/refund-abandon-txn.ts",
    "staging-pay-qr": "src/cli/staging-pay-qr.ts",
    "analytics-repartition": "src/cli/analytics-repartition.ts",
    "sample-watermark": "src/cli/sample-watermark.ts",
    "q9-local-sample-recovery": "src/cli/q9-local-sample-recovery.ts",
  },
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: "external",
  external: EXTERNAL,
  define: { __LYX_VERSION__: JSON.stringify(version()) },
  // 打进来的 CommonJS 依赖（pg 等）要用 require 取 Node 内置模块（做法借自参考工程 apps/worker/tsup.config.ts）
  banner: {
    js: 'import { createRequire as __lyxCreateRequire } from "node:module"; const require = __lyxCreateRequire(import.meta.url);',
  },
  logLevel: "warning",
  metafile: true,
};
const result = await build(options);

// Preserve the normal app bundle. Only the separate CPU entry follows its verified public binding.
function assertExports(path, target, names) {
  const exports = [
    ...readFileSync(path, "utf8").matchAll(/export\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g),
  ];
  if (
    names.some(
      (name) =>
        !exports.some(
          (entry) =>
            entry[2] === target &&
            entry[1]
              .split(",")
              .map((item) => item.trim())
              .includes(name),
        ),
    )
  )
    throw new Error("document public export binding changed");
}
const services = resolve(root, "../../packages/services/src");
const names = ["createDocumentConverter", "runDocumentConversionWorker"];
assertExports(`${services}/index.ts`, "./kernel/index.js", names);
assertExports(`${services}/kernel/index.ts`, "./document-conversion/index.js", names);
assertExports(`${services}/kernel/document-conversion/index.ts`, "./host.js", [names[0]]);
assertExports(`${services}/kernel/document-conversion/index.ts`, "./worker.js", [names[1]]);
const converter = await build({
  ...options,
  entryPoints: { "document-converter": "src/cli/document-converter.ts" },
  plugins: [
    {
      name: "isolated-public-document-entry",
      setup(context) {
        context.onResolve({ filter: /^@liyoxi\/services$/ }, (args) => {
          if (args.importer !== resolve(root, "src/cli/document-converter.ts"))
            throw new Error("unexpected isolated public import");
          return { path: `${services}/kernel/document-conversion/index.ts` };
        });
      },
    },
  ],
});
for (const [file, meta] of [
  ...Object.entries(result.metafile.outputs),
  ...Object.entries(converter.metafile.outputs),
]) {
  if (file.endsWith(".js")) console.log(`${file}  ${(meta.bytes / 1024).toFixed(0)} KB`);
}

// Deliberately external packages must resolve from this app; pg's pre-existing optional pg-native stays unchanged.
const manifest = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
const converterExternal = new Set(
  Object.values(converter.metafile.outputs).flatMap((output) =>
    output.imports
      .filter((item) => item.external)
      .map((item) => item.path.split("/", item.path.startsWith("@") ? 2 : 1).join("/")),
  ),
);
for (const name of ["mammoth", "sanitize-html", "pdfjs-dist", "@napi-rs/canvas"]) {
  if (!converterExternal.has(name) || !(name in manifest.dependencies))
    throw new Error(`document production dependency missing: ${name}`);
}
if (
  Object.keys(converter.metafile.inputs).some((path) =>
    /packages\/(?:db\/|services\/src\/(?:providers\/|runtime\.ts|assembly\.ts))/.test(path),
  )
)
  throw new Error("document CPU build included business assembly");
for (const output of [
  ...Object.values(result.metafile.outputs),
  ...Object.values(converter.metafile.outputs),
]) {
  for (const { path, external } of output.imports) {
    const name = path.split("/", path.startsWith("@") ? 2 : 1).join("/");
    if (external && EXTERNAL.includes(name) && !isBuiltin(path) && !(name in manifest.dependencies))
      throw new Error(`undeclared production import: ${name}`);
  }
}
