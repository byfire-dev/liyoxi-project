#!/usr/bin/env node
// W4-19：沿既有顺序执行器，独立会话、90秒上限、失败即停与收尾均保持。
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, runRound, runRepeated, runRepeatCli } from "./e2e-repeat.mjs";

const DEFAULT_OUT = fileURLToPath(new URL("../../apps/api/dist/m4-e2e-repeat", import.meta.url));
export function parseM4Args(argv) {
  const options = parseArgs(argv);
  return { ...options, out: argv.includes("--out") ? options.out : DEFAULT_OUT };
}
export function runM4Round(options) {
  return runRound({ ...options, script: "e2e:m4" });
}
export function runM4Repeated({ out = DEFAULT_OUT, runOnce = runM4Round, ...options } = {}) {
  return runRepeated({ ...options, out, runOnce });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await runRepeatCli({ label: "M4", parse: parseM4Args, run: runM4Repeated });
