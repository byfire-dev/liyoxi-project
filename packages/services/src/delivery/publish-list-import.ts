import { AppError } from "../kernel/index.js";

export interface PublishListImportRow {
  /** 原文本的物理起始行；带引号的单元格可以跨行。 */
  rowNo: number;
  episodeNo: number;
  highlight?: string | null;
  title?: string | null;
  topics?: string[];
  intro?: string | null;
}

export interface PublishListImportIssue {
  rowNo: number;
  episodeNo: number | null;
  column: string;
  message: string;
}

interface RecordRow {
  rowNo: number;
  cells: string[];
}

const columns = ["集号", "看点", "标题", "话题", "简介"] as const;
const textColumns = [
  ["看点", "highlight", 30],
  ["标题", "title", 100],
  ["简介", "intro", 200],
] as const;

function fail(rows: PublishListImportIssue[]): never {
  throw new AppError("PUBLISH_LIST_IMPORT_INVALID", {
    details: { rows: rows.sort((a, b) => a.rowNo - b.rowNo) },
  });
}

/** 只解析文本，不访问库；CSV 与表格复制的 TSV 使用相同的引号转义规则。 */
function records(content: string, separator: string): RecordRow[] {
  const result: RecordRow[] = [];
  let cells: string[] = [];
  let value = "";
  let mode: "start" | "plain" | "quoted" | "closed" = "start";
  let line = 1;
  let rowNo = 1;
  const finishCell = () => {
    cells.push(value);
    value = "";
    mode = "start";
  };
  const malformed = (message: string): never =>
    fail([{ rowNo, episodeNo: null, column: "content", message }]);
  for (let i = 0; i < content.length; i++) {
    const char = content[i]!;
    if (mode === "quoted") {
      if (char === '"') {
        if (content[i + 1] === '"') {
          value += '"';
          i++;
        } else mode = "closed";
      } else if (char === "\r") {
        value += char;
        if (content[i + 1] === "\n") value += content[++i]!;
        line++;
      } else {
        value += char;
        if (char === "\n") line++;
      }
      continue;
    }
    if (char === separator) {
      finishCell();
    } else if (char === "\r" || char === "\n") {
      finishCell();
      result.push({ rowNo, cells });
      cells = [];
      if (char === "\r" && content[i + 1] === "\n") i++;
      line++;
      rowNo = line;
    } else if (char === '"' && mode === "start") {
      mode = "quoted";
    } else {
      if (char === '"' || mode === "closed") {
        malformed("引号必须包住整个单元格，内部引号须写成两个引号");
      }
      value += char;
      mode = "plain";
    }
  }
  if (mode === "quoted") malformed("单元格的引号未闭合");
  // 文件末尾的换行不是额外数据行；中间的空行仍参与校验。
  if (cells.length || value.length || mode !== "start") {
    finishCell();
    result.push({ rowNo, cells });
  }
  return result;
}

/** 全部行校验成功后才返回可写入的补丁；未出现的表头不会产生对应属性。 */
export function parsePublishListImport(
  content: string,
  format: "csv" | "tsv",
  episodeCount: number,
): { rows: PublishListImportRow[] } {
  if (new TextEncoder().encode(content).byteLength > 200 * 1024) {
    fail([{ rowNo: 1, episodeNo: null, column: "content", message: "导入文本不能超过 200 KB" }]);
  }
  const table = records(content.replace(/^\uFEFF/, ""), format === "csv" ? "," : "\t");
  const header = table.shift()?.cells.map((v) => v.trim()) ?? [];
  const issues: PublishListImportIssue[] = [];
  const headerIssue = (column: string, message: string) =>
    issues.push({ rowNo: 1, episodeNo: null, column, message });
  const headerCounts = new Map<string, number>();
  for (const name of header) headerCounts.set(name, (headerCounts.get(name) ?? 0) + 1);
  for (const [name, count] of headerCounts) {
    if (!columns.some((column) => column === name)) headerIssue(name, "表头不认识");
    if (count > 1) headerIssue(name, "表头不能重复");
  }
  if (!header.includes("集号")) headerIssue("集号", "必须包含集号列");
  if (!header.some((name) => name !== "集号" && columns.some((column) => column === name))) {
    headerIssue("header", "至少包含看点、标题、话题、简介中的一列");
  }
  if (issues.length) fail(issues);
  if (table.length < 1 || table.length > episodeCount) {
    issues.push({
      rowNo: 1,
      episodeNo: null,
      column: "content",
      message: `数据行数须为 1 到 ${episodeCount}`,
    });
  }
  const rows: PublishListImportRow[] = [];
  const episodeRows = new Map<number, number[]>();
  for (const record of table) {
    const rawEpisode = record.cells[header.indexOf("集号")]?.trim() ?? "";
    const number = /^\d+$/.test(rawEpisode) ? Number(rawEpisode) : NaN;
    const episodeNo = Number.isSafeInteger(number) ? number : null;
    const issue = (column: string, message: string) =>
      issues.push({ rowNo: record.rowNo, episodeNo, column, message });
    if (record.cells.length !== header.length) issue("content", "单元格数量与表头不一致");
    if (episodeNo === null || episodeNo < 1 || episodeNo > episodeCount) {
      issue("集号", `集号须为 1 到 ${episodeCount} 的整数`);
    }
    if (episodeNo !== null) {
      const seen = episodeRows.get(episodeNo) ?? [];
      seen.push(record.rowNo);
      episodeRows.set(episodeNo, seen);
    }
    const row: PublishListImportRow = { rowNo: record.rowNo, episodeNo: episodeNo ?? 0 };
    for (const [name, property, max] of textColumns) {
      const index = header.indexOf(name);
      if (index < 0) continue;
      const value = record.cells[index] ?? "";
      if (value.length > max) issue(name, `不能超过 ${max} 字`);
      row[property] = value === "" ? null : value;
    }
    const topicsIndex = header.indexOf("话题");
    if (topicsIndex >= 0) {
      const topics = (record.cells[topicsIndex] ?? "").split(/[\s#]+/u).filter(Boolean);
      if (topics.length > 10) issue("话题", "话题不能超过 10 个");
      if (topics.some((topic) => topic.length > 20)) issue("话题", "每个话题不能超过 20 字");
      if (new Set(topics).size !== topics.length) issue("话题", "话题不能重复");
      row.topics = topics;
    }
    rows.push(row);
  }
  for (const [episodeNo, rowNos] of episodeRows) {
    if (rowNos.length < 2) continue;
    for (const rowNo of rowNos) {
      issues.push({ rowNo, episodeNo, column: "集号", message: "集号不能重复" });
    }
  }
  if (issues.length) fail(issues);
  return { rows };
}
