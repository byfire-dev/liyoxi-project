#!/usr/bin/env node
// W5-15：沿已合五阶段白名单执行器；每轮独立、90秒、失败即停。
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, runRound, runRepeated, runRepeatCli } from "./e2e-repeat.mjs";

const DEFAULT_OUT = fileURLToPath(new URL("../../apps/api/dist/m5-e2e-repeat", import.meta.url));
export function parseM5Args(argv) {
  const options = parseArgs(argv);
  return { ...options, out: argv.includes("--out") ? options.out : DEFAULT_OUT };
}
export function runM5Round(options) {
  return runRound({ ...options, script: "e2e:m5" });
}
export function runM5Repeated({ out = DEFAULT_OUT, runOnce = runM5Round, ...options } = {}) {
  return runRepeated({ ...options, out, runOnce });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await runRepeatCli({ label: "M5", parse: parseM5Args, run: runM5Repeated });
