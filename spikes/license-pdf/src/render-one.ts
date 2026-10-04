// 子进程入口：渲染一份样张两次，把 PDF 写到指定位置，把度量打到标准输出（一行 JSON）。
// 一份样张一个进程，才量得出各自的内存峰值与冷启动耗时。
// 用法：node src/render-one.ts <snapshot.json> <输出.pdf>
import { readFileSync, writeFileSync } from "node:fs";

import { footersPrinted, renderLetter } from "./render.ts";
import type { LicenseSnapshot } from "./snapshot.ts";

export interface SampleMetrics {
  letterNo: string;
  revNo: number;
  contentFingerprint: string;
  pages: number;
  pagesSecondRender: number;
  pageObjects: number;
  /** 页脚真的印出来了的页数（从文件里读回来核对） */
  pagesWithFooter: number;
  bytes: number;
  bytesSecondRender: number;
  /** 第一次渲染：含读字体、解析字体 */
  coldRenderMs: number;
  /** 同一进程里第二次渲染：字体已在内存里 */
  warmRenderMs: number;
  /** 进程的常驻内存峰值，单位 MB（process.resourceUsage().maxRSS） */
  peakRssMb: number;
  baseFonts: string[];
  uncovered: string[];
}

const [snapshotPath, outputPath] = process.argv.slice(2);
if (snapshotPath === undefined || outputPath === undefined) {
  console.error("用法：node src/render-one.ts <snapshot.json> <输出.pdf>");
  process.exit(2);
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as LicenseSnapshot;
const first = await renderLetter(snapshot);
const second = await renderLetter(snapshot);
writeFileSync(outputPath, first.pdf);

// maxRSS 的单位：Linux 与 macOS 上 Node 都换算成 KB
const peakRssMb = Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10;

// 内存峰值量完之后再把文字读回来核对页脚，免得读取的开销算进峰值
const pagesWithFooter = footersPrinted(first).filter(Boolean).length;

const metrics: SampleMetrics = {
  letterNo: snapshot.letterNo,
  revNo: snapshot.revNo,
  contentFingerprint: first.fingerprint,
  pages: first.pages,
  pagesSecondRender: second.pages,
  pageObjects: first.pageObjects,
  pagesWithFooter,
  bytes: first.pdf.length,
  bytesSecondRender: second.pdf.length,
  coldRenderMs: first.ms,
  warmRenderMs: second.ms,
  peakRssMb,
  baseFonts: first.baseFonts,
  uncovered: first.uncovered,
};
process.stdout.write(`${JSON.stringify(metrics)}\n`);
