// 用例对账用：从设计规范（design/design-spec.md）里取某一节的表格。
// 规范是依据，用例直接读它，不在用例里另抄一份取值。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const specFile = `${repoRoot}design/design-spec.md`;

/** 取一个标题（如 "### 5.4 Ant Design 主题"）到下一个同级或更高级标题之间的行 */
export function specSection(heading: string): string[] {
  const lines = readFileSync(specFile, "utf8").split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`规范里找不到标题：${heading}`);
  const level = heading.indexOf(" ");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6} /.test(line) && line.indexOf(" ") <= level);
  return end < 0 ? rest : rest.slice(0, end);
}

/** 取这些行里的第一张表：返回表头之后的各行，每行拆成单元格（去掉首尾空白） */
export function firstTable(lines: readonly string[]): string[][] {
  const start = lines.findIndex((line) => line.startsWith("|"));
  if (start < 0) throw new Error("这一节里没有表格");
  const rows: string[][] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, line.lastIndexOf("|"))
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  // 去掉表头与分隔行
  return rows.slice(2);
}
