#!/usr/bin/env node
// W2-30：沿既有顺序执行器，独立会话、90秒上限与遇红即停均保持。
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, runRound, runRepeated, runRepeatCli } from "./e2e-repeat.mjs";

const DEFAULT_OUT = fileURLToPath(new URL("../../apps/api/dist/m2-e2e-repeat", import.meta.url));
export function parseM2Args(argv) {
  const options = parseArgs(argv);
  return { ...options, out: argv.includes("--out") ? options.out : DEFAULT_OUT };
}
export function runM2Round(options) {
  return runRound({ ...options, script: "e2e:m2" });
}
export function runM2Repeated({ out = DEFAULT_OUT, runOnce = runM2Round, ...options } = {}) {
  return runRepeated({ ...options, out, runOnce });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await runRepeatCli({ label: "M2", parse: parseM2Args, run: runM2Repeated });
