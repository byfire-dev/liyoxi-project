// 中文换行：把一段文字切成“不可拆的小段”，段与段之间才允许换行。
//
// 为什么不用 D6 第 3.5.3 节写的 `word => Array.from(word)`：
// @react-pdf/textkit 7.0.1 把回调返回的相邻两段之间当成“连字点”，在那里换行时会在行尾补一个 “-”。
// 实测每一行中文的行尾都多出一个连字符（见 test/linebreak.test.ts 与 ADR）。
// 做法：段与段之间插一个空串。空串被排版引擎当成宽度为 0 的间隔，在间隔处换行不补连字符。
//
// 另做三件事：
// 1. 行首禁则：句号、逗号、顿号、右引号、右括号等并进前一段，不会落在行首。
// 2. 行尾禁则：左引号、左括号、左书名号并进后一段，不会落在行尾。
// 3. 西文与数字：24 个字符以内的一串不拆（金额、日期、短编号保持完整）；
//    更长的先在分隔符之后拆，仍然过长的逐字拆，避免溢出页边。

/** 不换行空格（U+00A0）与全角空格（U+3000）。用码位写出来，源码里不留看不见的字符 */
export const NBSP = String.fromCodePoint(0x00a0);
export const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);

/** 不能出现在行首的全角字符（并进前一段）。不换行空格与全角空格也算：空格不落在行首 */
const NO_LINE_START = new Set([
  ...Array.from("，。、；：？！）》」』】〕〉〗”’…—～·％‰℃"),
  NBSP,
  IDEOGRAPHIC_SPACE,
]);

/** 不能出现在行尾的全角字符（并进后一段） */
const NO_LINE_END = new Set(Array.from("（《「『【〔〈〖“‘￥"));

/** 整串都是这些字符的西文串，按“不能出现在行首”处理 */
const ASCII_CLOSE = new Set(Array.from(",.;:?!)]}%"));

/** 整串都是这些字符的西文串，按“不能出现在行尾”处理 */
const ASCII_OPEN = new Set(Array.from("([{$"));

/** 西文与数字一串不拆的最大长度 */
export const MAX_LATIN_RUN = 24;

/** 过长的西文串在这些分隔符之后可以拆 */
const SPLIT_AFTER = /(?<=[/?&=._\-:#+@~|\\,;])/;

function isAsciiPrintable(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code > 0x20 && code < 0x7f;
}

function everyCharIn(text: string, set: Set<string>): boolean {
  return Array.from(text).every((char) => set.has(char));
}

/** 第一步：切成最小单位。汉字与全角标点一字一个；西文与数字连成一串，过长的再拆 */
function units(text: string): string[] {
  const out: string[] = [];
  let run = "";
  const flush = () => {
    if (run === "") return;
    if (run.length <= MAX_LATIN_RUN) {
      out.push(run);
    } else {
      for (const part of run.split(SPLIT_AFTER)) {
        if (part.length <= MAX_LATIN_RUN) out.push(part);
        else out.push(...Array.from(part));
      }
    }
    run = "";
  };
  for (const char of Array.from(text)) {
    if (isAsciiPrintable(char)) {
      run += char;
    } else {
      flush();
      out.push(char);
    }
  }
  flush();
  return out;
}

/** 第二步：按禁则并段。返回的每一段内部不换行 */
export function segment(text: string): string[] {
  const clusters: string[] = [];
  let pendingOpen = "";
  for (const unit of units(text)) {
    const ascii = isAsciiPrintable(unit);
    const closes = ascii ? everyCharIn(unit, ASCII_CLOSE) : NO_LINE_START.has(unit);
    const opens = ascii ? everyCharIn(unit, ASCII_OPEN) : NO_LINE_END.has(unit);
    if (closes) {
      if (pendingOpen !== "") pendingOpen += unit;
      else if (clusters.length > 0) clusters[clusters.length - 1] += unit;
      else clusters.push(unit);
    } else if (opens) {
      pendingOpen += unit;
    } else {
      clusters.push(pendingOpen + unit);
      pendingOpen = "";
    }
  }
  if (pendingOpen !== "") {
    if (clusters.length > 0) clusters[clusters.length - 1] += pendingOpen;
    else clusters.push(pendingOpen);
  }
  return clusters;
}

/**
 * 交给 Font.registerHyphenationCallback 的回调。
 * 每一段后面都跟一个空串（含最后一段）：同一个 Text 里换字重时，两个片段的交界也是合法的换行点，
 * 不跟空串的话引擎会在交界处补连字符。
 */
export function hyphenationCallback(word: string): string[] {
  const out: string[] = [];
  for (const cluster of segment(word)) out.push(cluster, "");
  return out;
}

/**
 * 普通空格换成不换行空格。
 * 排版引擎先按普通空格把文字切成“词”，再对每个词调回调；它的兜底算法优先在普通空格处换行，
 * 一行里只要有空格就会提前折行，右边留下大块空白。换成不换行空格后，换行点全部由上面的并段决定。
 */
export function noBreakSpaces(text: string): string {
  return text.replaceAll(" ", NBSP);
}
