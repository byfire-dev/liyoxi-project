/**
 * 状态机迁移表对照（任务书 W0-12 第 7 节第 1–3 条；计划 第 5.7 节“状态机”行）：
 * 拿 packages/shared 的迁移表（src/machines）与数据模型分组文档的状态机表逐行对照，一处不符即非 0 退出。
 *
 * 用法（在仓库根目录）：pnpm machines:check。直接跑：tsx scripts/machines-check.ts，不带参数。只读文件，不连库。
 *
 * 核对五样：
 *   1. 清单四方一致：迁移表的（状态机, 状态列）= 契约登记（@liyoxi/contract/registry 的 STATE_MACHINES）
 *      = 01 分组 第 3.2 节的表；状态机 = catalogue.json 里 state_machine = true 的表。
 *   2. 状态取值：每条链的状态就是契约里绑定“表.列”的枚举；没被任何一行用到的取值只列出、不算差异。
 *   3. 逐行：迁移表每一行的 ref（“分组:行号”）指到分组文档的一行。那一行所在的表格整张都要被认领——
 *      迁移行与迁移表的当前状态、事件码、新状态、有无守卫相同；终态声明的状态在迁移表里确实没有出路；
 *      写明“不写状态历史”的行在迁移表里没有对应。文档多一行、迁移表多一行都算差异。
 *   4. 表外行：ref 指的不是表格行时，那一行必须写着这个事件码。
 *   5. 文档里写明归某条链的状态机表（表格前面、同一小节里写着 machine = … 与 state_field = …）每一张都被那条链认领。
 *
 * 怎么从散文表里读（机械规则，没有人工映射表）：
 *   - 表头认四栏：“当前状态 / 当前阶段 / 当前步骤”“事件”“新状态 / 新阶段 / 新步骤”“守卫…”。
 *     另一种版面是“触发”“可能的变化”两栏（订购单的推导表）：“→”左边是当前状态，右边是新状态，不比守卫。
 *   - 状态 = 那一格里反引号括起、且属于本状态列枚举的记号。当前状态格是“—”即新建；新状态格以“不变”开头即不改状态。
 *   - 事件码 = 事件格里反引号括起、形如小写点分名的记号（结尾的括号参数去掉）；有带点的就只取带点的。
 *   - 事件格是“任何”的行是终态声明。没有事件码的行必须写着“不写状态历史”。
 *   - 守卫 = 守卫格不是“—”。
 *   - 人工纠偏（事件码 admin.force）的行：文档格里没有反引号状态的不比状态集合（更正白名单以迁移表为准），有的照比；
 *     迁移表里可以按白名单拆成几行，按并集比。
 *
 * 本脚本不写死数量：有几张表、几条链、几行，都从契约登记、分组文档与迁移表现取。
 * 退出码：0 通过；1 有差异；2 环境错误（文件读不了）。
 */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { enumByColumn } from "@liyoxi/contract/enums";
import { STATE_MACHINES, STATE_MACHINE_NAMES } from "@liyoxi/contract/registry";

import {
  ADMIN_FORCE_EVENT,
  CHAINS,
  SAME,
  terminalStates,
  type Chain,
  type TransitionRow,
} from "../src/machines/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DATA_MODEL_DIR = join(repoRoot, "docs/data-model");
/** 01 分组：status_transition 的表定义与第 3.2 节的清单在这份文档里 */
const KERNEL_DOC_PREFIX = "01";
/** 写在行里表示“这一行不是迁移” */
export const NO_HISTORY_MARK = "不写状态历史";
/** 终态声明行的事件格 */
const ANY_EVENT = "任何";

// ---------- 读分组文档 ----------

export interface DocSources {
  /** 分组编号（文件名开头的两位数字）→ 文件名与按行拆开的正文 */
  groups: ReadonlyMap<string, { file: string; lines: readonly string[] }>;
  /** catalogue.json 里 state_machine = true 的表名 */
  catalogueMachines: readonly string[];
}

export function loadDocSources(dir: string = DATA_MODEL_DIR): DocSources {
  const groups = new Map<string, { file: string; lines: string[] }>();
  for (const file of readdirSync(dir).sort()) {
    const match = /^(\d{2})-.+\.md$/.exec(file);
    if (!match) continue;
    if (groups.has(match[1]!)) throw new Error(`${dir} 下有两份 ${match[1]} 开头的分组文档`);
    groups.set(match[1]!, { file, lines: readFileSync(join(dir, file), "utf8").split("\n") });
  }
  const catalogue = JSON.parse(readFileSync(join(dir, "working/catalogue.json"), "utf8")) as {
    tables: { name: string; state_machine?: boolean }[];
  };
  return {
    groups,
    catalogueMachines: catalogue.tables.filter((t) => t.state_machine).map((t) => t.name),
  };
}

// ---------- 解析：单元格 ----------

const isTableLine = (line: string | undefined): line is string =>
  line !== undefined && line.trimStart().startsWith("|");
const isSeparatorLine = (line: string | undefined): boolean =>
  line !== undefined && /^\|[\s:|-]+\|$/.test(line.trim()) && line.includes("-");

/** 拆一行表格：去掉首尾的竖线，按没有转义的竖线拆开 */
export function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** 一格里反引号括起的记号，按出现的先后 */
export const backticked = (cell: string): string[] =>
  [...cell.matchAll(/`([^`]*)`/g)].map((match) => match[1]!);

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

/** 一格里的状态：反引号括起、且属于本状态列枚举的记号 */
export function statesIn(cell: string, states: readonly string[]): string[] {
  return unique(backticked(cell).filter((token) => states.includes(token)));
}

const EVENT_CODE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** 事件格里的事件码：形如小写点分名（结尾的括号参数去掉）；有带点的只取带点的 */
export function eventCodesIn(cell: string): string[] {
  const codes = unique(
    backticked(cell)
      .map((token) => token.replace(/\(.*\)$/, ""))
      .filter((token) => EVENT_CODE.test(token)),
  );
  const dotted = codes.filter((code) => code.includes("."));
  return dotted.length > 0 ? dotted : codes;
}

// ---------- 解析：表格 ----------

type Layout =
  | { kind: "columns"; from: number; event: number; to: number; guard: number | null }
  | { kind: "derived"; event: number; change: number };

const FROM_HEADERS = ["当前状态", "当前阶段", "当前步骤"];
const TO_HEADERS = ["新状态", "新阶段", "新步骤"];

/** 表头是不是状态机表：认得出就给出各栏的位置 */
export function layoutOf(header: readonly string[]): Layout | null {
  const from = header.findIndex((cell) => FROM_HEADERS.includes(cell));
  const event = header.indexOf("事件");
  const to = header.findIndex((cell) => TO_HEADERS.includes(cell));
  if (from >= 0 && event >= 0 && to >= 0) {
    const guard = header.findIndex((cell) => cell.startsWith("守卫"));
    return { kind: "columns", from, event, to, guard: guard >= 0 ? guard : null };
  }
  if (header[0] === "触发" && header[1] === "可能的变化") {
    return { kind: "derived", event: 0, change: 1 };
  }
  return null;
}

/** 一张表格在文档里的位置：行号都从 1 起 */
interface TableBlock {
  headerLine: number;
  /** 数据行的行号：表头与分隔行之后，到表格结束 */
  dataLines: number[];
}

/** 第 line 行所在的表格；不在表格的数据行上返回 null */
export function tableAround(lines: readonly string[], line: number): TableBlock | null {
  if (!isTableLine(lines[line - 1])) return null;
  let top = line;
  while (top > 1 && isTableLine(lines[top - 2])) top -= 1;
  if (!isSeparatorLine(lines[top])) return null;
  if (line < top + 2) return null;
  const dataLines: number[] = [];
  for (let current = top + 2; isTableLine(lines[current - 1]); current += 1)
    dataLines.push(current);
  return { headerLine: top, dataLines };
}

/**
 * 从第 line 行往上，最近一处写着“<键> = 值”的值（值可以带反引号或单引号）。只在同一小节里找：
 * 碰到二、三级标题还没找到就返回 null（别的小节写的是别的表）。
 */
export function nearestAssignment(
  lines: readonly string[],
  line: number,
  key: string,
): string | null {
  const pattern = new RegExp(`${key} = [\`']*([a-z][a-z0-9_]*)`, "g");
  for (let current = line; current >= 1; current -= 1) {
    const text = lines[current - 1] ?? "";
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 0) return matches.at(-1)![1]!;
    if (/^#{2,3} /.test(text)) return null;
  }
  return null;
}

/** 文档里一张写明了归属的状态机表 */
export interface DeclaredTable {
  /** “表.列”：表格前面（同一小节里）写的 machine 与 state_field */
  column: string;
  /** 表头的位置，“分组:行号” */
  at: string;
}

/** 分组文档里全部写明了 machine 与 state_field 的状态机表（表头认得出的才算） */
export function declaredTables(sources: DocSources): DeclaredTable[] {
  const found: DeclaredTable[] = [];
  for (const [groupId, { lines }] of sources.groups) {
    for (let line = 1; line < lines.length; line += 1) {
      const isHeader =
        isTableLine(lines[line - 1]) &&
        !isTableLine(lines[line - 2]) &&
        isSeparatorLine(lines[line]);
      if (!isHeader || layoutOf(splitRow(lines[line - 1]!)) === null) continue;
      const machine = nearestAssignment(lines, line, "machine");
      const stateField = nearestAssignment(lines, line, "state_field");
      if (machine === null || stateField === null) continue;
      found.push({ column: `${machine}.${stateField}`, at: `${groupId}:${line}` });
    }
  }
  return found;
}

/** 分组文档状态机表里读出来的一行 */
export type DocRow =
  | {
      kind: "transition";
      line: number;
      /** null 是新建；空数组是这一格没有反引号状态（散文） */
      from: string[] | null;
      events: string[];
      /** 空数组是这一格没有反引号状态（散文） */
      to: string[] | typeof SAME;
      /** null 是这种版面没有守卫一栏 */
      guard: boolean | null;
    }
  | { kind: "terminal"; line: number; states: string[] }
  | { kind: "no_history"; line: number };

/** 解析一行；读不出来时抛错，错误信息不带位置（由调用方补） */
export function parseDocRow(
  layout: Layout,
  header: readonly string[],
  text: string,
  line: number,
  states: readonly string[],
): DocRow {
  const cells = splitRow(text);
  if (cells.length !== header.length) {
    throw new Error(`这一行有 ${cells.length} 格，表头有 ${header.length} 格`);
  }
  const eventCell = cells[layout.event]!;
  if (layout.kind === "columns" && eventCell === ANY_EVENT) {
    return { kind: "terminal", line, states: statesIn(cells[layout.from]!, states) };
  }
  const events = eventCodesIn(eventCell);
  if (events.length === 0) {
    if (text.includes(NO_HISTORY_MARK)) return { kind: "no_history", line };
    throw new Error(`这一行没有事件码，也没有写明“${NO_HISTORY_MARK}”`);
  }
  if (layout.kind === "derived") {
    const sides = cells[layout.change]!.split("→");
    if (sides.length !== 2) throw new Error("“可能的变化”一格要恰好有一个“→”");
    const [left, right] = sides as [string, string];
    return {
      kind: "transition",
      line,
      from: left.trim().startsWith("—") ? null : statesIn(left, states),
      events,
      to: statesIn(right, states),
      guard: null,
    };
  }
  const fromCell = cells[layout.from]!;
  const toCell = cells[layout.to]!;
  return {
    kind: "transition",
    line,
    from: fromCell === "—" ? null : statesIn(fromCell, states),
    events,
    to: toCell.startsWith("不变") ? SAME : statesIn(toCell, states),
    guard: layout.guard === null ? null : cells[layout.guard] !== "—",
  };
}

// ---------- 对照：一条链 ----------

export interface ChainReport {
  problems: string[];
  /** 认领的表格（表头的位置，“分组:行号”）与各类行数 */
  tables: string[];
  transitionRows: number;
  terminalRows: number;
  noHistoryRows: number;
  /** 表外行：ref 指向表格之外的说明 */
  outsideRows: string[];
  /** 枚举里没被任何一行用到的取值 */
  unusedStates: string[];
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
const list = (values: readonly string[] | null | typeof SAME): string =>
  values === null ? "（新建）" : values === SAME ? "不变" : values.join("、") || "（没有写出状态）";
const describeTo = (to: TransitionRow["to"]): string => list(to === SAME ? SAME : [...to]);

/** 拿一条链与它所在的分组文档对照 */
export function compareChain(chain: Chain, sources: DocSources): ChainReport {
  const report: ChainReport = {
    problems: [],
    tables: [],
    transitionRows: 0,
    terminalRows: 0,
    noHistoryRows: 0,
    outsideRows: [],
    unusedStates: [],
  };
  const fail = (message: string) => report.problems.push(`${chain.column}：${message}`);

  const used = new Set<string>();
  for (const row of chain.rows) {
    for (const state of row.from ?? []) used.add(state);
    if (row.to !== SAME) for (const state of row.to) used.add(state);
  }
  report.unusedStates = chain.states.filter((state) => !used.has(state));

  // 按 ref 分组；ref 的写法与所在分组先查
  const byRef = new Map<string, TransitionRow[]>();
  for (const row of chain.rows) {
    if (!/^\d{2}:\d+$/.test(row.ref)) {
      fail(`ref 的写法不对（应为“分组:行号”）：${row.ref}`);
      continue;
    }
    byRef.set(row.ref, [...(byRef.get(row.ref) ?? []), row]);
  }
  const groupIds = unique([...byRef.keys()].map((ref) => ref.slice(0, 2)));
  if (groupIds.length !== 1) {
    fail(`各行的 ref 应在同一份分组文档里，现在是 ${groupIds.join("、") || "（没有行）"}`);
    return report;
  }
  const groupId = groupIds[0]!;
  const group = sources.groups.get(groupId);
  if (!group) {
    fail(`docs/data-model 下没有 ${groupId} 开头的分组文档`);
    return report;
  }
  const { lines } = group;
  const at = (line: number) => `${groupId}:${line}`;

  // 认领表格：ref 落在哪张表格里，那张表格整张归这条链
  const claimed = new Map<number, TableBlock>();
  const outside: [string, TransitionRow[]][] = [];
  for (const [ref, rows] of byRef) {
    const line = Number(ref.slice(3));
    if (line < 1 || line > lines.length) {
      fail(`${ref} 超出了 ${group.file} 的行数`);
      continue;
    }
    const block = tableAround(lines, line);
    if (block === null) outside.push([ref, rows]);
    else claimed.set(block.headerLine, block);
  }

  const docRows = new Map<string, DocRow>();
  for (const block of claimed.values()) {
    const header = splitRow(lines[block.headerLine - 1]!);
    const layout = layoutOf(header);
    if (layout === null) {
      fail(`${at(block.headerLine)} 的表格不是状态机表（表头：${header.join(" | ")}）`);
      continue;
    }
    report.tables.push(at(block.headerLine));
    const machine = nearestAssignment(lines, block.headerLine, "machine");
    const stateField = nearestAssignment(lines, block.headerLine, "state_field");
    if (machine !== chain.machine || stateField !== chain.stateField) {
      fail(
        `${at(block.headerLine)} 的表格前面写的是 machine = ${machine ?? "（没写）"}、state_field = ${stateField ?? "（没写）"}，不是这条链`,
      );
      continue;
    }
    for (const line of block.dataLines) {
      try {
        docRows.set(at(line), parseDocRow(layout, header, lines[line - 1]!, line, chain.states));
      } catch (error) {
        fail(`${at(line)} 读不出来：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // 文档的每一行
  const terminal = new Set(terminalStates(chain));
  for (const [ref, doc] of docRows) {
    const rows = byRef.get(ref) ?? [];
    if (doc.kind === "terminal") {
      report.terminalRows += 1;
      if (rows.length > 0) fail(`${ref} 是终态声明（事件“${ANY_EVENT}”），迁移表里不该有它的行`);
      if (doc.states.length === 0) fail(`${ref} 是终态声明，但没有用反引号写出是哪些状态`);
      const leaving = doc.states.filter((state) => !terminal.has(state));
      if (leaving.length > 0) {
        fail(`${ref} 声明 ${leaving.join("、")} 是终态，迁移表里它还有改变状态的迁移`);
      }
      continue;
    }
    if (doc.kind === "no_history") {
      report.noHistoryRows += 1;
      if (rows.length > 0) fail(`${ref} 写着“${NO_HISTORY_MARK}”，迁移表里不该有它的行`);
      continue;
    }
    report.transitionRows += 1;
    if (rows.length === 0) {
      fail(`文档有而迁移表没有：${ref}（事件码 ${doc.events.join("、")}）`);
      continue;
    }
    const events = unique(rows.map((row) => row.event));
    if (!sameSet(events, doc.events)) {
      fail(`${ref} 的事件码：文档 ${doc.events.join("、")}，迁移表 ${events.join("、")}`);
      continue;
    }
    if (doc.events.includes(ADMIN_FORCE_EVENT)) {
      // 人工纠偏：迁移表按白名单拆成几行，按并集比；文档写的是散文时不比
      const from = unique(rows.flatMap((row) => row.from ?? []));
      const to = unique(rows.flatMap((row) => (row.to === SAME ? [] : row.to)));
      if (doc.from !== null && doc.from.length > 0 && !sameSet(from, doc.from)) {
        fail(`${ref} 的当前状态：文档 ${list(doc.from)}，迁移表 ${list(from)}`);
      }
      if (doc.to !== SAME && doc.to.length > 0 && !sameSet(to, doc.to)) {
        fail(`${ref} 的新状态：文档 ${list(doc.to)}，迁移表 ${list(to)}`);
      }
    } else {
      if (rows.length !== doc.events.length) {
        fail(
          `${ref} 在迁移表里有 ${rows.length} 行，应是一个事件码一行（${doc.events.length} 行）`,
        );
      }
      if (doc.from !== null && doc.from.length === 0) {
        fail(`${ref} 的当前状态一格没有用反引号写出状态`);
      }
      if (doc.to !== SAME && doc.to.length === 0) {
        fail(`${ref} 的新状态一格没有用反引号写出状态`);
      }
      for (const row of rows) {
        const fromOk =
          doc.from === null ? row.from === null : row.from !== null && sameSet(row.from, doc.from);
        if (!fromOk) {
          fail(
            `${ref} ${row.event} 的当前状态：文档 ${list(doc.from)}，迁移表 ${list(row.from ? [...row.from] : null)}`,
          );
        }
        const toOk = doc.to === SAME ? row.to === SAME : row.to !== SAME && sameSet(row.to, doc.to);
        if (!toOk) {
          fail(`${ref} ${row.event} 的新状态：文档 ${list(doc.to)}，迁移表 ${describeTo(row.to)}`);
        }
      }
    }
    if (doc.guard !== null) {
      for (const row of rows.filter((item) => item.guard !== doc.guard)) {
        fail(
          `${ref} ${row.event} 的守卫：文档${doc.guard ? "写了守卫" : "是“—”"}，迁移表标的是${row.guard ? "有" : "没有"}`,
        );
      }
    }
  }

  // 表外行：那一行要写着这个事件码
  for (const [ref, rows] of outside) {
    const text = lines[Number(ref.slice(3)) - 1] ?? "";
    for (const row of rows) {
      if (backticked(text).includes(row.event)) report.outsideRows.push(`${ref} ${row.event}`);
      else fail(`${ref} 不是状态机表的行，那一行也没有写事件码 \`${row.event}\``);
    }
  }

  if (report.tables.length === 0 && report.problems.length === 0) {
    fail("没有一行指到分组文档的状态机表");
  }
  return report;
}

// ---------- 对照：清单 ----------

/** 01 分组 第 3.2 节的表：每行是“分组 | machine（可以并列几个）| state_field（可以并列几个，括号里是说明）” */
export function parseKernelMachineTable(lines: readonly string[]): string[] {
  const start = lines.findIndex((line) => /^### 3\.2 /.test(line));
  const end = lines.findIndex((line, index) => index > start && /^#{2,3} /.test(line));
  if (start < 0 || end < 0) throw new Error("01 分组里找不到第 3.2 节");
  const pairs: string[] = [];
  let header: string[] | null = null;
  for (const line of lines.slice(start, end)) {
    if (!isTableLine(line) || isSeparatorLine(line)) continue;
    const cells = splitRow(line);
    if (header === null) {
      header = cells;
      continue;
    }
    const machineCell = cells[header.indexOf("`machine`")] ?? "";
    // 括号里的是说明（会提到别的列名），先去掉
    const fieldCell = (cells[header.indexOf("`state_field`")] ?? "").replace(/（[^（）]*）/g, "");
    for (const machine of backticked(machineCell)) {
      for (const stateField of backticked(fieldCell)) pairs.push(`${machine}.${stateField}`);
    }
  }
  if (pairs.length === 0) throw new Error("01 分组 第 3.2 节的表读不出内容");
  return pairs;
}

const difference = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((item) => !b.includes(item)).sort();

function setProblems(
  leftName: string,
  left: readonly string[],
  rightName: string,
  right: readonly string[],
): string[] {
  const problems: string[] = [];
  const onlyLeft = difference(left, right);
  const onlyRight = difference(right, left);
  if (onlyLeft.length > 0) problems.push(`${leftName}有而${rightName}没有：${onlyLeft.join("、")}`);
  if (onlyRight.length > 0)
    problems.push(`${rightName}有而${leftName}没有：${onlyRight.join("、")}`);
  return problems;
}

/** 1、2：清单四方一致；状态取值就是契约的枚举 */
export function registryProblems(
  chains: readonly Chain[] = CHAINS,
  sources: DocSources = loadDocSources(),
): string[] {
  const ours = chains.map((item) => item.column);
  const duplicated = ours.filter((column, index) => ours.indexOf(column) !== index);
  const contract = STATE_MACHINE_NAMES.flatMap((machine) =>
    STATE_MACHINES[machine].map((stateField) => `${machine}.${stateField}`),
  );
  const kernel = sources.groups.get(KERNEL_DOC_PREFIX);
  if (!kernel) throw new Error("docs/data-model 下没有 01 开头的分组文档");
  const problems = [
    ...duplicated.map((column) => `迁移表里 ${column} 声明了不止一次`),
    ...setProblems("迁移表", ours, "契约登记（STATE_MACHINES）", contract),
    ...setProblems(
      "契约登记（STATE_MACHINES）",
      contract,
      "01 分组 第 3.2 节的表",
      parseKernelMachineTable(kernel.lines),
    ),
    ...setProblems(
      "契约登记的状态机",
      STATE_MACHINE_NAMES,
      "catalogue.json 里 state_machine = true 的表",
      sources.catalogueMachines,
    ),
  ];
  for (const item of chains) {
    const bound = enumByColumn(item.column);
    if (!bound) problems.push(`${item.column}：契约里没有绑定这一列的枚举`);
    else if (!sameSet(bound.values, item.states)) {
      problems.push(`${item.column}：状态取值与契约枚举 ${bound.name} 不同`);
    }
  }
  return problems;
}

export interface CheckResult {
  problems: string[];
  reports: Map<string, ChainReport>;
}

/** 全部核对 */
export function checkMachines(
  chains: readonly Chain[] = CHAINS,
  sources: DocSources = loadDocSources(),
): CheckResult {
  const reports = new Map(chains.map((item) => [item.column, compareChain(item, sources)]));
  // 文档里写明归某条链的状态机表，每一张都要被那条链认领：同一条链另起一张表、表里的行没人对，也算差异
  const unclaimed = declaredTables(sources)
    .filter((table) => {
      const report = reports.get(table.column);
      return report !== undefined && !report.tables.includes(table.at);
    })
    .map((table) => `${table.column}：${table.at} 的状态机表没有被迁移表的任何一行认领`);
  return {
    problems: [
      ...registryProblems(chains, sources),
      ...[...reports.values()].flatMap((report) => report.problems),
      ...unclaimed,
    ],
    reports,
  };
}

function main(): void {
  let result: CheckResult;
  try {
    result = checkMachines();
  } catch (error) {
    console.error(
      `状态机迁移表对照：没跑成。${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
  const reports = [...result.reports.values()];
  const sum = (pick: (report: ChainReport) => number) =>
    reports.reduce((total, report) => total + pick(report), 0);
  const outside = reports.flatMap((report) => report.outsideRows);
  const unused = [...result.reports].flatMap(([column, report]) =>
    report.unusedStates.map((state) => `${column} 的 ${state}`),
  );
  console.log(
    [
      "状态机迁移表对照（packages/shared/src/machines ↔ docs/data-model 分组文档的状态机表）",
      `  状态机 ${new Set(CHAINS.map((item) => item.machine)).size} 张表，状态列（链）${CHAINS.length} 条；迁移表 ${CHAINS.reduce((total, item) => total + item.rows.length, 0)} 行`,
      `  分组文档：认领表格 ${sum((r) => r.tables.length)} 张；迁移行 ${sum((r) => r.transitionRows)}、终态声明 ${sum((r) => r.terminalRows)}、写明“${NO_HISTORY_MARK}”的 ${sum((r) => r.noHistoryRows)}`,
      `  表外行 ${outside.length}${outside.length > 0 ? `：${outside.join("；")}` : ""}`,
      `  枚举里没被任何一行用到的取值 ${unused.length}${unused.length > 0 ? `：${unused.join("；")}` : ""}`,
    ].join("\n"),
  );
  if (result.problems.length > 0) {
    console.error(`\n状态机迁移表对照未通过：差异 ${result.problems.length}`);
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("\n状态机迁移表对照通过：清单、状态取值、逐行，差异 0");
}

// 只在被直接执行时跑；被用例 import 时不跑
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
