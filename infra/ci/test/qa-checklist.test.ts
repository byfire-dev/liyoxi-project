import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

const source = readFileSync(join(repoRoot, "docs/plan/qa-checklist.md"), "utf8");
it("九组真机清单编号唯一、每组5–10条、每条可执行且首屏4G两秒为P0", () => {
  const rows = source
    .split("\n")
    .filter((line) => /^\| QA-/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((v) => v.trim()),
    );
  expect(new Set(rows.map((r) => r[0])).size).toBe(rows.length);
  for (let group = 1; group <= 9; group++) {
    const entries = rows.filter((r) => r[0]?.startsWith(`QA-${group}-`));
    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect(entries.length).toBeLessThanOrEqual(10);
  }
  for (const row of rows) {
    expect(row).toHaveLength(7);
    expect(row[0]).toMatch(/^QA-[1-9]-\d{2}$/);
    expect(row[1]).toMatch(/^P[01]$/);
    for (const cell of row.slice(2)) expect(cell).not.toMatch(/^\s*$|待填|出第一版/);
  }
  expect(rows.find((r) => r[0] === "QA-1-01")).toEqual(
    expect.arrayContaining(["P0", expect.stringContaining("4G"), expect.stringContaining("≤2 秒")]),
  );
  expect(source).toContain("| 代号 | 设备 | 型号 | 系统版本 | 微信版本 | 基础库 | 备注 |");
});
