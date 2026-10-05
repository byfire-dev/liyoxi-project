// 菜单角标键与 a02 第 5 节 NavBadgeKey 一行对账：取值与顺序相同。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NAV_BADGE_KEYS, isNavBadgeKey } from "./index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("菜单角标键（NavBadgeKey）", () => {
  it("与 a02 第 5 节登记的取值、顺序相同", () => {
    const doc = readFileSync(resolve(repoRoot, "docs/api/a02-workbench-report.md"), "utf8");
    const row = doc.split("\n").find((line) => line.startsWith("| `NavBadgeKey` |"));
    expect(row, "a02 里找不到 NavBadgeKey 那一行").toBeDefined();
    const values = [...(row?.split("|")[2] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    expect(values.length).toBeGreaterThan(0);
    expect([...NAV_BADGE_KEYS]).toEqual(values);
  });

  it("不重复；认得出登记过的键", () => {
    expect(new Set(NAV_BADGE_KEYS).size).toBe(NAV_BADGE_KEYS.length);
    expect(isNavBadgeKey(NAV_BADGE_KEYS[0])).toBe(true);
    expect(isNavBadgeKey("merchant.nope")).toBe(false);
  });
});
