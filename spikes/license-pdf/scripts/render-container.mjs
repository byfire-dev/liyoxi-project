#!/usr/bin/env node
// 在 node:24-slim 容器里跑同一条渲染命令，核对“只靠随附字体”（任务书 第 7 节第 3 条）。
//
// 用法：pnpm render:container（先跑过 pnpm render，本机的 out/report.json 要在）
// 做什么：
//   1. 把本工程的源码、样张与锁文件只读挂进容器，字体目录只读挂到 /fonts；
//   2. 容器里先数一遍系统里的字体文件（应为 0），再按锁文件只装生产依赖，跑 pnpm render；
//   3. 回到本机，把容器里的页数与本机 out/report.json 的页数逐份比对，写出 out/report.container.json。
// 环境变量（都可不设）：
//   LYX_PDF_FONT_DIR            字体目录，默认仓库的 infra/docker/server/fonts
//   LYX_PDF_CONTAINER_IMAGE     镜像，默认 node:24-slim
//   LYX_PDF_CONTAINER_PLATFORM  传给 docker run --platform，如 linux/amd64
//   LYX_PDF_NPM_REGISTRY        容器里装依赖用的 registry；不设用 npm 官方源
//   LYX_PDF_CONTAINER_KEEP      设为 1 时保留容器输出目录（里面有容器渲染出的三份 PDF），并打印路径
// 退出码：0 通过；1 渲染失败、容器里有系统字体、或页数与本机不一致；2 环境不满足（没有 docker、没有本机报告）。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, "..");
const repoDir = resolve(projectDir, "../..");
const fontDir = resolve(process.env.LYX_PDF_FONT_DIR ?? join(repoDir, "infra/docker/server/fonts"));
const image = process.env.LYX_PDF_CONTAINER_IMAGE ?? "node:24-slim";
const platform = process.env.LYX_PDF_CONTAINER_PLATFORM;
const registry = process.env.LYX_PDF_NPM_REGISTRY;
const keep = process.env.LYX_PDF_CONTAINER_KEEP === "1";

function stop(code, message) {
  console.error(`容器复跑：${message}`);
  process.exit(code);
}

const hostReportPath = join(projectDir, "out", "report.json");
if (!existsSync(hostReportPath)) stop(2, "本机还没有 out/report.json，先跑 pnpm render");
if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0) {
  stop(2, "docker 不可用（没装，或守护进程没起）");
}

// 容器里跑的脚本。系统字体只数容器自己文件系统里的（-xdev 不进挂载点）
const inside = `
set -eu
count=$(find / -xdev -type f \\( -iname '*.ttf' -o -iname '*.otf' -o -iname '*.ttc' -o -iname '*.woff' \\
  -o -iname '*.woff2' -o -iname '*.pfb' -o -iname '*.pcf' -o -iname '*.pcf.gz' \\) 2>/dev/null | wc -l)
echo "LYX_SYSTEM_FONT_FILES=$count"
mkdir -p /work && cd /work
cp -R /src/package.json /src/pnpm-lock.yaml /src/pnpm-workspace.yaml /src/.npmrc /src/src /src/samples .
corepack enable
pnpm install --frozen-lockfile --prod
LYX_PDF_FONT_DIR=/fonts LYX_PDF_OUT_DIR=/out pnpm render
`;

const outDir = mkdtempSync(join(tmpdir(), "lyx-license-pdf-"));
const args = ["run", "--rm"];
if (platform) args.push("--platform", platform);
args.push(
  "-v",
  `${projectDir}:/src:ro`,
  "-v",
  `${fontDir}:/fonts:ro`,
  "-v",
  `${outDir}:/out`,
  "-e",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
  "-e",
  "CI=true",
);
if (registry)
  args.push("-e", `npm_config_registry=${registry}`, "-e", `COREPACK_NPM_REGISTRY=${registry}`);
args.push(image, "bash", "-c", inside);

console.log(`容器复跑：镜像 ${image}${platform ? `（${platform}）` : ""}，字体目录 ${fontDir}`);
const run = spawnSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
process.stdout.write(run.stdout ?? "");

function finish(code) {
  if (keep) console.log(`容器输出目录：${outDir}`);
  else rmSync(outDir, { recursive: true, force: true });
  process.exit(code);
}

if (run.status !== 0) {
  console.error(`容器复跑：容器里的渲染失败，退出码 ${run.status}`);
  finish(1);
}

const systemFontFiles = Number(/LYX_SYSTEM_FONT_FILES=(\d+)/.exec(run.stdout ?? "")?.[1] ?? NaN);
const host = JSON.parse(readFileSync(hostReportPath, "utf8"));
const container = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8"));

/** 镜像的摘要，记进报告；取不到就留空 */
function imageDigests() {
  try {
    return execFileSync(
      "docker",
      ["image", "inspect", "--format", "{{json .RepoDigests}}", image],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
}
const digest = imageDigests();

const samples = host.samples.map((hostSample) => {
  const inContainer = container.samples.find((sample) => sample.name === hostSample.name);
  return {
    name: hostSample.name,
    pagesOnHost: hostSample.pages,
    pagesInContainer: inContainer?.pages ?? null,
    samePages: inContainer?.pages === hostSample.pages,
    bytesInContainer: inContainer?.bytes ?? null,
    coldRenderMs: inContainer?.coldRenderMs ?? null,
    warmRenderMs: inContainer?.warmRenderMs ?? null,
    peakRssMb: inContainer?.peakRssMb ?? null,
    fontsInFile: inContainer?.fontsInFile ?? "",
    onlyBundledFonts: inContainer?.onlyBundledFonts ?? false,
    uncoveredChars: inContainer?.uncoveredChars ?? "",
  };
});

const problems = [];
if (systemFontFiles !== 0) problems.push(`容器里有 ${systemFontFiles} 个系统字体文件，应为 0`);
for (const sample of samples) {
  if (!sample.samePages) {
    problems.push(
      `${sample.name}：本机 ${sample.pagesOnHost} 页，容器里 ${sample.pagesInContainer} 页`,
    );
  }
  if (!sample.onlyBundledFonts) problems.push(`${sample.name}：容器里用了随附字体之外的字体`);
}

const report = {
  generatedAt: new Date().toISOString(),
  image,
  imageDigests: digest,
  environment: container.environment,
  systemFontFilesInContainer: systemFontFiles,
  fontDirInContainer: "/fonts（只读挂载仓库的 infra/docker/server/fonts）",
  install: "pnpm install --frozen-lockfile --prod",
  samples,
  problems: problems.join("；"),
};
writeFileSync(
  join(projectDir, "out", "report.container.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(`容器里的系统字体文件数：${systemFontFiles}`);
for (const sample of samples) {
  console.log(
    `${sample.name}：本机 ${sample.pagesOnHost} 页，容器里 ${sample.pagesInContainer} 页，` +
      `${sample.samePages ? "一致" : "不一致"}；文件里的字体：${sample.fontsInFile}`,
  );
}
console.log("报告：spikes/license-pdf/out/report.container.json");

if (problems.length > 0) {
  for (const problem of problems) console.error(`不通过：${problem}`);
  finish(1);
}
finish(0);
