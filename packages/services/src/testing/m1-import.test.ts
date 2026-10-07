import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

it("公共测试入口在无 Vitest 的进程可纯导入，钩子与非测试 M1 明确拒绝", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, APP_ENV: "prod" };
  delete env.VITEST;
  const source = `
    import assert from 'node:assert/strict';
    import {createM1Support, useTestDatabase, useTestRedis} from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    assert.equal(process.env.VITEST, undefined);
    assert.throws(() => useTestDatabase('api'), /Vitest worker/);
    assert.throws(() => useTestRedis(), /Vitest worker/);
    await assert.rejects(createM1Support(), /APP_ENV=test/);
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      "--input-type=module",
      "--eval",
      source,
    ],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  // 不把进程环境/完整子进程输出带入失败报告；预期进程无 I/O 与输出。
  expect(result.status, "无 Vitest 公共入口与拒绝探针退出码").toBe(0);
  expect(result.stdout).toBe("");
}, 15_000);
