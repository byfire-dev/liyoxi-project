// 从渲染出来的 PDF 里把每页的文字按行读回来：只给用例与报告用，不进生产。
//
// 为什么要自己读：页脚回调被调用不等于页脚真的印出来了（实测遇到过回调每页都调、文字却没画上去的情况，
// 见 ADR“已知限制”）。任务书不许装解析 PDF 的库，所以这里只认 @react-pdf/renderer（pdfkit）写出的这一种
// 结构：对象字典是明文、流用 Flate 压缩、文字是十六进制字形编号、每个字体带一张 ToUnicode 表。
// 别的工具生成的 PDF 不保证读得对。
import { inflateSync } from "node:zlib";

export interface TextRun {
  text: string;
  /** 左端横坐标，单位 pt，从页面左边量 */
  x: number;
  /** 基线纵坐标，单位 pt，从页面顶边量 */
  y: number;
  width: number;
  fontSize: number;
  font: string;
}

export interface TextLine {
  text: string;
  x: number;
  y: number;
  /** 这一行最右端的横坐标 */
  right: number;
}

export interface PageText {
  width: number;
  height: number;
  runs: TextRun[];
  lines: TextLine[];
}

interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** ToUnicode 表里查不到的字形，读回来记成替换字符 U+FFFD */
const UNKNOWN_CHAR = String.fromCodePoint(0xfffd);

/** m 先作用，再作用 n */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function readObjects(pdf: Buffer): Map<number, PdfObject> {
  const raw = pdf.toString("latin1");
  const objects = new Map<number, PdfObject>();
  const header = /(\d+) 0 obj\n/g;
  for (let match = header.exec(raw); match !== null; match = header.exec(raw)) {
    const start = header.lastIndex;
    const endObj = raw.indexOf("endobj", start);
    const streamAt = raw.indexOf("stream\n", start);
    if (streamAt !== -1 && streamAt < endObj) {
      const dict = raw.slice(start, streamAt);
      const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? 0);
      const dataStart = streamAt + "stream\n".length;
      const data = pdf.subarray(dataStart, dataStart + length);
      const stream = dict.includes("/FlateDecode") ? inflateSync(data) : Buffer.from(data);
      objects.set(Number(match[1]), { dict, stream });
      header.lastIndex = dataStart + length;
    } else {
      objects.set(Number(match[1]), { dict: raw.slice(start, endObj), stream: null });
    }
  }
  return objects;
}

function refAfter(dict: string, key: string): number | null {
  const match = new RegExp(`${key}\\s+(\\d+) 0 R`).exec(dict);
  return match ? Number(match[1]) : null;
}

/** UTF-16BE 的十六进制（可能带空格，如代理对 “d870 df17”）→ 字符串 */
function utf16Hex(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
  }
  return out;
}

function readToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? "";
    const entry = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F\s]+>)/g;
    for (const [, from, to, target] of body.matchAll(entry)) {
      const start = parseInt(from ?? "0", 16);
      const end = parseInt(to ?? "0", 16);
      if (target?.startsWith("[")) {
        const values = [...target.matchAll(/<([0-9a-fA-F\s]*)>/g)].map((m) => utf16Hex(m[1] ?? ""));
        for (let code = start; code <= end; code += 1) map.set(code, values[code - start] ?? "");
      } else {
        const base = utf16Hex((target ?? "").slice(1, -1)).codePointAt(0) ?? 0;
        for (let code = start; code <= end; code += 1) {
          map.set(code, String.fromCodePoint(base + code - start));
        }
      }
    }
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, code, value] of (block[1] ?? "").matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g,
    )) {
      map.set(parseInt(code ?? "0", 16), utf16Hex(value ?? ""));
    }
  }
  return map;
}

interface FontInfo {
  name: string;
  toUnicode: Map<number, string> | null;
  /** 字形宽度，单位是千分之一字号；下标是字形编号 */
  widths: number[];
}

function readFont(objects: Map<number, PdfObject>, id: number): FontInfo {
  const font = objects.get(id);
  const name = (/\/BaseFont\s*\/([^\s/]+)/.exec(font?.dict ?? "")?.[1] ?? "").replace(
    /^[A-Z]{6}\+/,
    "",
  );
  const toUnicodeId = refAfter(font?.dict ?? "", "/ToUnicode");
  const cmap =
    toUnicodeId === null ? null : (objects.get(toUnicodeId)?.stream?.toString("latin1") ?? null);
  const descendantId = Number(
    /\/DescendantFonts\s*\[(\d+) 0 R\]/.exec(font?.dict ?? "")?.[1] ?? NaN,
  );
  const widthsText = /\/W\s*\[\s*0\s*\[([^\]]*)\]/.exec(objects.get(descendantId)?.dict ?? "")?.[1];
  return {
    name,
    toUnicode: cmap === null ? null : readToUnicode(cmap),
    widths: widthsText === undefined ? [] : widthsText.trim().split(/\s+/).map(Number),
  };
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "name"; value: string }
  | { kind: "hex"; value: string }
  | { kind: "literal"; value: string }
  | { kind: "array"; value: Token[] }
  | { kind: "op"; value: string };

function tokenize(content: string): Token[] {
  const tokens: Token[] = [];
  const stack: Token[][] = [tokens];
  const push = (token: Token) => stack[stack.length - 1]?.push(token);
  let i = 0;
  while (i < content.length) {
    const char = content[i] ?? "";
    if (/\s/.test(char)) {
      i += 1;
    } else if (char === "[") {
      const array: Token = { kind: "array", value: [] };
      push(array);
      stack.push(array.value);
      i += 1;
    } else if (char === "]") {
      if (stack.length > 1) stack.pop();
      i += 1;
    } else if (char === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i);
      push({ kind: "hex", value: content.slice(i + 1, end) });
      i = end + 1;
    } else if (char === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < content.length && depth > 0) {
        if (content[j] === "\\") j += 1;
        else if (content[j] === "(") depth += 1;
        else if (content[j] === ")") depth -= 1;
        j += 1;
      }
      push({ kind: "literal", value: content.slice(i + 1, j - 1) });
      i = j;
    } else {
      const match = /^[^\s[\]()<>]+|^<<|^>>/.exec(content.slice(i, i + 64));
      const word = match?.[0] ?? char;
      if (word.startsWith("/")) push({ kind: "name", value: word.slice(1) });
      else if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) push({ kind: "number", value: Number(word) });
      else push({ kind: "op", value: word });
      i += word.length;
    }
  }
  return tokens;
}

function readRuns(content: string, fonts: Map<string, FontInfo>, pageHeight: number): TextRun[] {
  const runs: TextRun[] = [];
  const ctmStack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let textMatrix: Matrix = IDENTITY;
  let font: FontInfo | undefined;
  let fontSize = 0;
  let operands: Token[] = [];
  const numbers = () => operands.map((token) => (token.kind === "number" ? token.value : 0));

  const show = (parts: Token[]) => {
    let text = "";
    let width = 0;
    for (const part of parts) {
      if (part.kind === "hex") {
        for (let i = 0; i + 4 <= part.value.length; i += 4) {
          const glyph = parseInt(part.value.slice(i, i + 4), 16);
          text += font?.toUnicode?.get(glyph) ?? UNKNOWN_CHAR;
          width += ((font?.widths[glyph] ?? 1000) / 1000) * fontSize;
        }
      } else if (part.kind === "literal") {
        text += part.value;
        width += part.value.length * 0.5 * fontSize;
      } else if (part.kind === "number") {
        width -= (part.value / 1000) * fontSize;
      }
    }
    const [a, , , , e, f] = multiply(textMatrix, ctm);
    runs.push({
      text,
      x: e,
      y: pageHeight - f,
      width: width * Math.abs(a),
      fontSize,
      font: font?.name ?? "",
    });
  };

  for (const token of tokenize(content)) {
    if (token.kind !== "op") {
      operands.push(token);
      continue;
    }
    const args = numbers();
    switch (token.value) {
      case "q":
        ctmStack.push(ctm);
        break;
      case "Q":
        ctm = ctmStack.pop() ?? IDENTITY;
        break;
      case "cm":
        if (args.length === 6) ctm = multiply(args as Matrix, ctm);
        break;
      case "BT":
        textMatrix = IDENTITY;
        break;
      case "Tm":
        if (args.length === 6) textMatrix = args as Matrix;
        break;
      case "Td":
        textMatrix = multiply([1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0], textMatrix);
        break;
      case "Tf": {
        const name = operands.find((operand) => operand.kind === "name");
        font = name ? fonts.get(name.value) : undefined;
        fontSize = args[args.length - 1] ?? 0;
        break;
      }
      case "TJ": {
        const array = operands.find((operand) => operand.kind === "array");
        if (array) show(array.value);
        break;
      }
      case "Tj":
        show(operands);
        break;
      default:
        break;
    }
    operands = [];
  }
  return runs;
}

/** 同一条基线上的片段并成一行，按横坐标排 */
function toLines(runs: TextRun[]): TextLine[] {
  const byBaseline = new Map<number, TextRun[]>();
  for (const run of runs) {
    if (run.text === "") continue;
    const key = Math.round(run.y * 2) / 2;
    const group = byBaseline.get(key);
    if (group) group.push(run);
    else byBaseline.set(key, [run]);
  }
  return [...byBaseline.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, group]) => {
      const sorted = group.sort((a, b) => a.x - b.x);
      return {
        text: sorted.map((run) => run.text).join(""),
        x: sorted[0]?.x ?? 0,
        y,
        right: Math.max(...sorted.map((run) => run.x + run.width)),
      };
    });
}

/** 按页读出文字。页的先后取页树的 Kids 顺序 */
export function extractPages(pdf: Buffer): PageText[] {
  const objects = readObjects(pdf);
  const pagesRoot = [...objects.values()].find((object) => /\/Type\s*\/Pages\b/.test(object.dict));
  const kids = [
    ...(/\/Kids\s*\[([^\]]*)\]/.exec(pagesRoot?.dict ?? "")?.[1] ?? "").matchAll(/(\d+) 0 R/g),
  ];

  return kids.map((kid) => {
    const page = objects.get(Number(kid[1]));
    const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(
      page?.dict ?? "",
    );
    const width = Number(box?.[3] ?? 0);
    const height = Number(box?.[4] ?? 0);

    const resourcesId = refAfter(page?.dict ?? "", "/Resources");
    const resources = resourcesId === null ? "" : (objects.get(resourcesId)?.dict ?? "");
    const fonts = new Map<string, FontInfo>();
    const fontDict = /\/Font\s*<<([^>]*)>>/.exec(resources)?.[1] ?? "";
    for (const [, name, id] of fontDict.matchAll(/\/(\S+)\s+(\d+) 0 R/g)) {
      if (name !== undefined) fonts.set(name, readFont(objects, Number(id)));
    }

    const contentsId = refAfter(page?.dict ?? "", "/Contents");
    const content =
      contentsId === null ? "" : (objects.get(contentsId)?.stream?.toString("latin1") ?? "");
    const runs = readRuns(content, fonts, height);
    return { width, height, runs, lines: toLines(runs) };
  });
}
