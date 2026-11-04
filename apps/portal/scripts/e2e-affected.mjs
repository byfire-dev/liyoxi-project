#!/usr/bin/env node
// Portal owns its affected scope; API/services changes must also exercise the real session chain.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const scopes = [
  "apps/portal/",
  "apps/api/",
  "packages/services/",
  "packages/db/",
  "packages/shared/",
  "packages/contract/",
  "packages/config/",
  "infra/compose/",
  "infra/ci/test/portal-live-affected.test.ts",
  "design/tokens.json",
  "pnpm-lock.yaml",
  "package.json",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  ".github/workflows/ci.yml",
];

export function affectsPortalLive(files) {
  return files.some((file) =>
    scopes.some((scope) => (scope.endsWith("/") ? file.startsWith(scope) : file === scope)),
  );
}

export function portalLiveDecision(base, readChanges) {
  if (!base) return true;
  try {
    return affectsPortalLive(readChanges(base));
  } catch {
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--base") {
    console.error("Portal 验收范围：须给 --base <基线>；非PR给空串");
    process.exitCode = 2;
  } else {
    const run = portalLiveDecision(args[1].trim(), (base) => {
      if (base.startsWith("-")) throw new Error("Invalid base");
      return execFileSync("git", ["diff", "--name-only", `${base}...HEAD`, "--"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .filter(Boolean);
    });
    console.info(`Portal 真实验收：${run ? "执行" : "本次改动不涉及"}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  }
}
