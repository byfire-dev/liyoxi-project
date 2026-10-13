import { join } from "node:path";
import { expect, it } from "vitest";
import { repoRoot, run } from "./helpers.js";

it("W214同源六页夹具与实际输入产物符合正式schema，端侧保持不触达Zod", () => {
  // NodeNext infra不递归编译端侧；脚本静态import同源数据，CLI只按现有weapp配置加载。
  const result = run(
    process.execPath,
    [
      join(repoRoot, "packages/services/node_modules/tsx/dist/cli.mjs"),
      "--tsconfig",
      join(repoRoot, "apps/weapp/tsconfig.json"),
      join(repoRoot, "infra/ci/weapp-tenant-fixtures.mjs"),
    ],
    repoRoot,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    checked: "W214六页同源契约",
    invitationStates: 4,
  });
});
