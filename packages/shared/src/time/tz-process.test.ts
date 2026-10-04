// 结果不随运行机器的时区变化：把时间、周期、工作日、金额格式化的用例放到两个不同的进程时区下各跑一次。
// 时区由环境变量 TZ 在子进程启动时给定；子进程里的探针用例（time.test.ts）确认时区确实生效。

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const vitestCli = join(
  dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);

/** 在子进程里重跑的用例文件。不含本文件，免得套娃 */
const FILES = [
  "src/time/time.test.ts",
  "src/period/period.test.ts",
  "src/workcal/workcal.test.ts",
  "src/format/money.test.ts",
  "src/pricing/prd-2-9.test.ts",
];
const PROBE = "本进程的时区确实是父进程指定的那个";

/** offset 是该时区 2026-01-15 正午的 getTimezoneOffset()：西正东负 */
const ZONES = [
  { tz: "America/New_York", offset: 300 },
  { tz: "Pacific/Kiritimati", offset: -840 },
];

interface JsonReport {
  success: boolean;
  numTotalTests: number;
  numFailedTests: number;
  testResults: { assertionResults: { title: string; status: string }[] }[];
}

// 子进程里不再往下套：探针变量在，说明自己就是被拉起来的那个
describe.skipIf(process.env.LYX_TZ_PROBE_OFFSET !== undefined)("进程时区无关", () => {
  it.each(ZONES)(
    "在进程时区 $tz 下重跑时间、周期、工作日、金额的用例，全过",
    ({ tz, offset }) => {
      const env: Record<string, string | undefined> = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith("VITEST")) delete env[key];
      // 子进程是来验时区的，不是来跑大轮次的：轮次回到默认值，种子照常继承
      delete env.LYX_FC_RUNS;
      const result = spawnSync(process.execPath, [vitestCli, "run", "--reporter=json", ...FILES], {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...env, TZ: tz, LYX_TZ_PROBE_OFFSET: String(offset) },
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);

      const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as JsonReport;
      expect(report.success, output).toBe(true);
      expect(report.numFailedTests).toBe(0);
      expect(report.testResults).toHaveLength(FILES.length);
      const probe = report.testResults
        .flatMap((file) => file.assertionResults)
        .find((test) => test.title === PROBE);
      // 探针没被跳过：子进程的时区确实换成了 tz
      expect(probe?.status).toBe("passed");
    },
    120_000,
  );
});
