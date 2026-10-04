// 字体收了哪些字：直接读 TTF 的 cmap 表（格式 12；没有就读格式 4），不引库。
//
// 为什么要查：字体没收的字，@react-pdf/renderer 会悄悄换成不嵌入的 Helvetica 来画，
// 显示成错误的拉丁符号并压住后面的字（见 test/render.test.ts “缺字” 一组）。
// 所以渲染前先查，没收的字换成 “〓” 并记下来。
import { readFileSync } from "node:fs";

export interface Coverage {
  has(codePoint: number): boolean;
  readonly size: number;
}

type Range = readonly [start: number, end: number];

function tableOffset(font: Buffer, tag: string): number {
  const numTables = font.readUInt16BE(4);
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    if (font.toString("latin1", record, record + 4) === tag) return font.readUInt32BE(record + 8);
  }
  throw new Error(`字体里没有 ${tag} 表`);
}

function readFormat12(font: Buffer, offset: number): Range[] {
  const numGroups = font.readUInt32BE(offset + 12);
  const ranges: Range[] = [];
  for (let i = 0; i < numGroups; i += 1) {
    const group = offset + 16 + i * 12;
    ranges.push([font.readUInt32BE(group), font.readUInt32BE(group + 4)]);
  }
  return ranges;
}

function readFormat4(font: Buffer, offset: number): Range[] {
  const segCount = font.readUInt16BE(offset + 6) / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const ranges: Range[] = [];
  for (let i = 0; i < segCount; i += 1) {
    const end = font.readUInt16BE(endCodes + i * 2);
    const start = font.readUInt16BE(startCodes + i * 2);
    if (start !== 0xffff) ranges.push([start, end]);
  }
  return ranges;
}

/** 读一个 TTF 文件的码位范围，按起点排序 */
export function readCmapRanges(fontPath: string): Range[] {
  const font = readFileSync(fontPath);
  const cmap = tableOffset(font, "cmap");
  const numSubtables = font.readUInt16BE(cmap + 2);
  let format4: number | null = null;
  for (let i = 0; i < numSubtables; i += 1) {
    const subtable = cmap + font.readUInt32BE(cmap + 4 + i * 8 + 4);
    const format = font.readUInt16BE(subtable);
    if (format === 12) return readFormat12(font, subtable).sort((a, b) => a[0] - b[0]);
    if (format === 4) format4 = subtable;
  }
  if (format4 === null) throw new Error(`${fontPath} 的 cmap 没有格式 12 或格式 4 的子表`);
  return readFormat4(font, format4).sort((a, b) => a[0] - b[0]);
}

function inRanges(ranges: Range[], codePoint: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (range === undefined) return false;
    if (codePoint < range[0]) high = middle - 1;
    else if (codePoint > range[1]) low = middle + 1;
    else return true;
  }
  return false;
}

/** 多个字体的交集：一个字要每个字体都收了才算收了（正文、加粗、标题三个字体都可能画它） */
export function loadCoverage(fontPaths: string[]): Coverage {
  const all = fontPaths.map(readCmapRanges);
  const first = all[0] ?? [];
  let size = 0;
  for (const [start, end] of first) {
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      if (all.every((ranges) => inRanges(ranges, codePoint))) size += 1;
    }
  }
  return {
    size,
    has: (codePoint) => all.every((ranges) => inRanges(ranges, codePoint)),
  };
}

/** 缺字时印的替代符号（下驮记号，排版里“此处缺字”的惯用符号；三个字体都收了它） */
export const MISSING_MARK = "〓";

/** 换行符与制表符不用字形 */
function needsGlyph(codePoint: number): boolean {
  return codePoint !== 0x0a && codePoint !== 0x0d && codePoint !== 0x09;
}

/** 把字体没收的字换成替代符号，并把它们记进 missing */
export function replaceUncovered(text: string, coverage: Coverage, missing: Set<string>): string {
  let out = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (!needsGlyph(codePoint) || coverage.has(codePoint)) {
      out += char;
    } else {
      missing.add(char);
      out += MISSING_MARK;
    }
  }
  return out;
}

/** “𠮷 U+20BB7” 这样的写法，给报告用 */
export function describeChar(char: string): string {
  const hex = (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
  return `${char} U+${hex}`;
}
