// 渲染命令：把 samples/ 下的三份 snapshot 渲染成 PDF，写出 report.json。
// 用法：pnpm render（即 node src/cli.ts）
// 环境变量：LYX_PDF_FONT_DIR 字体目录（默认仓库的 infra/docker/server/fonts）；
//           LYX_PDF_OUT_DIR  输出目录（默认本工程的 out/）。
// 退出码：0 成功；1 有样张渲染失败、超过体积上限、用了随附字体之外的字体，或两次渲染页数不同。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MISSING_MARK } from "./coverage.ts";
import { describeFonts, FONT_FILES, fontDir, registerFonts } from "./fonts.ts";
import { MAX_BYTES } from "./limits.ts";
import type { SampleMetrics } from "./render-one.ts";
import { TEMPLATE_VERSION } from "./template.ts";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, "..");
const repoDir = resolve(projectDir, "../..");

const SAMPLES = [
  { name: "short", label: "短" },
  { name: "long", label: "长" },
  { name: "extreme", label: "极端" },
] as const;

function packageVersion(name: string): string {
  const path = join(projectDir, "node_modules", name, "package.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

function repoRelative(path: string): string {
  const rel = relative(repoDir, path);
  return rel.startsWith("..") ? path : rel;
}

const outDir = resolve(process.env.LYX_PDF_OUT_DIR ?? join(projectDir, "out"));
mkdirSync(outDir, { recursive: true });

const coverage = registerFonts();
const allowedFonts = new Set(FONT_FILES.map((font) => font.file.replace(/\.ttf$/, "")));
const problems: string[] = [];

const samples = SAMPLES.map(({ name, label }) => {
  const file = `${name}.pdf`;
  const startedAt = performance.now();
  const stdout = execFileSync(
    process.execPath,
    [join(here, "render-one.ts"), join(projectDir, "samples", `${name}.json`), join(outDir, file)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const metrics = JSON.parse(stdout) as SampleMetrics;
  const processMs = Math.round(performance.now() - startedAt);

  const strayFonts = metrics.baseFonts.filter((font) => !allowedFonts.has(font));
  if (metrics.bytes > MAX_BYTES) problems.push(`${file} 有 ${metrics.bytes} 字节，超过 1MB`);
  if (strayFonts.length > 0)
    problems.push(`${file} 用了随附字体之外的字体：${strayFonts.join("、")}`);
  if (metrics.pages !== metrics.pagesSecondRender) problems.push(`${file} 两次渲染页数不同`);
  if (metrics.pages !== metrics.pageObjects) problems.push(`${file} 页脚回调的页数与页对象数不同`);
  if (metrics.pages !== metrics.pagesWithFooter) problems.push(`${file} 有的页没有页脚`);

  console.log(
    `${label}样张 ${file}：${metrics.pages} 页，${metrics.bytes} 字节，` +
      `首次 ${metrics.coldRenderMs} ms，再次 ${metrics.warmRenderMs} ms，内存峰值 ${metrics.peakRssMb} MB`,
  );

  // 数组都拼成一个字符串：report.json 要过根目录的 Prettier 检查，短数组会被它并成一行
  return {
    name,
    label,
    file,
    letterNo: metrics.letterNo,
    revNo: metrics.revNo,
    contentFingerprint: metrics.contentFingerprint,
    pages: metrics.pages,
    pagesSecondRender: metrics.pagesSecondRender,
    pageObjectsInFile: metrics.pageObjects,
    pagesWithFooter: metrics.pagesWithFooter,
    bytes: metrics.bytes,
    withinSizeLimit: metrics.bytes <= MAX_BYTES,
    coldRenderMs: metrics.coldRenderMs,
    warmRenderMs: metrics.warmRenderMs,
    // 整个子进程从启动到退出：启动 Node、加载渲染库、渲染两次、写文件
    processMs,
    peakRssMb: metrics.peakRssMb,
    fontsInFile: metrics.baseFonts.join("、"),
    onlyBundledFonts: strayFonts.length === 0,
    uncoveredChars: metrics.uncovered.join("、"),
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    renderer: `@react-pdf/renderer ${packageVersion("@react-pdf/renderer")}`,
    react: packageVersion("react"),
    templateVersion: TEMPLATE_VERSION,
  },
  fonts: {
    dir: repoRelative(fontDir()),
    sharedCodePoints: coverage.size,
    files: describeFonts(),
  },
  limits: { maxBytes: MAX_BYTES },
  samples,
  missingGlyph: {
    behaviourWithoutGuard:
      "字体没收的字不报错：@react-pdf/renderer 换用不嵌入的 Helvetica 来画，显示成错误的拉丁符号并压住后面的字，文件里多出 /BaseFont /Helvetica",
    guard: `渲染前按随附字体的 cmap 逐字检查，没收的字换成“${MISSING_MARK}”，并列在各样张的 uncoveredChars 里`,
    howToDetectInFile: "文件里的字体名只应是随附的三个；onlyBundledFonts 为 false 即说明有字回退",
  },
  problems: problems.join("；"),
};

writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`报告：${repoRelative(join(outDir, "report.json"))}`);

if (problems.length > 0) {
  for (const problem of problems) console.error(`不通过：${problem}`);
  process.exit(1);
}
