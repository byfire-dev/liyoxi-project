// 状态机与状态列取值清单的自测（任务书 W0-12 第 7 节第 2、3 条里契约这一半）。
// 它与 shared 的迁移表、01 分组 第 3.2 节的表是否一致，由 pnpm machines:check 核对（脚本在 packages/shared/scripts）。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { enumByColumn } from "../enums/index.js";

import { STATE_MACHINES, STATE_MACHINE_NAMES } from "./index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("状态机与状态列的取值清单（01 分组 第 3.2 节；06 第 3.2 节 M52、M53）", () => {
  const pairs = STATE_MACHINE_NAMES.flatMap((machine) =>
    STATE_MACHINES[machine].map((stateField) => `${machine}.${stateField}`),
  );

  it("状态机就是 catalogue.json 里 state_machine = true 的表", () => {
    const { tables } = JSON.parse(
      readFileSync(join(repoRoot, "docs/data-model/working/catalogue.json"), "utf8"),
    ) as { tables: { name: string; state_machine?: boolean }[] };
    const expected = tables.filter((table) => table.state_machine).map((table) => table.name);
    expect(expected.length).toBeGreaterThan(0);
    expect([...STATE_MACHINE_NAMES].sort()).toEqual(expected.sort());
  });

  it("表名与状态列名合库里的写法（ck_status_transition_machine、ck_status_transition_state_field）", () => {
    for (const pair of pairs) expect(pair).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    expect(pairs.filter((pair, index) => pairs.indexOf(pair) !== index)).toEqual([]);
  });

  it("每个状态列都有绑定“表.列”的枚举：状态取值的来源在 ./enums", () => {
    expect(pairs.filter((pair) => enumByColumn(pair) === undefined)).toEqual([]);
  });
});
