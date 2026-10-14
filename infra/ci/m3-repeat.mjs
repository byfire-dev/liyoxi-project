#!/usr/bin/env node
// W3-19: reuse the original sequential sessions, deadline, logs and failure accounting.
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, runRound, runRepeated, runRepeatCli } from "./e2e-repeat.mjs";

const DEFAULT_OUT = fileURLToPath(new URL("../../apps/api/dist/m3-e2e-repeat", import.meta.url));
export function parseM3Args(argv) {
  const options = parseArgs(argv);
  return { ...options, out: argv.includes("--out") ? options.out : DEFAULT_OUT };
}
export function runM3Round(options) {
  return runRound({ ...options, script: "e2e:m3" });
}
export function runM3Repeated({ out = DEFAULT_OUT, runOnce = runM3Round, ...options } = {}) {
  return runRepeated({ ...options, out, runOnce });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await runRepeatCli({ label: "M3", parse: parseM3Args, run: runM3Repeated });
