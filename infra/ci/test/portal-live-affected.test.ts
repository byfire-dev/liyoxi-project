import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { repoRoot } from "./helpers.js";

const script = join(repoRoot, "apps/portal/scripts/e2e-affected.mjs");

it("Portal单独改动、会话后端、契约或运行工具变更都触发，不借后台范围", () => {
  const source = `
    const { affectsPortalLive, portalLiveDecision } = await import(process.argv[1]);
    const files = JSON.parse(process.argv[2]);
    console.log(JSON.stringify({
      affected: files.map(file => affectsPortalLive([file])),
      main: portalLiveDecision('', () => { throw new Error('unused'); }),
      uncertain: portalLiveDecision('missing-base', () => { throw new Error('unavailable'); }),
    }));
  `;
  const files = [
    "apps/portal/src/features/session/model.ts",
    "apps/api/src/http/portal-auth.ts",
    "packages/services/src/identity/portal-sessions.ts",
    "packages/db/prisma/schema.prisma",
    "packages/contract/generated/portal.d.ts",
    "packages/shared/src/telemetry/index.ts",
    "packages/config/tsconfig/web-react19.json",
    "pnpm-lock.yaml",
    ".github/workflows/ci.yml",
    "docs/plan/status/W6-10.md",
    "apps/admin/src/App.tsx",
    "apps/portal-extra/src/App.tsx",
  ];
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source, pathToFileURL(script).href, JSON.stringify(files)],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    affected: [...Array<boolean>(9).fill(true), false, false, false],
    main: true,
    uncertain: true,
  });
});

it("真实CLI在无法解析基线时输出run=true；用法错误不产生跳过结果", () => {
  const root = mkdtempSync(join(tmpdir(), "lyx-portal-affected-"));
  try {
    const output = join(root, "output");
    const result = spawnSync(process.execPath, [script, "--base", "unknown-base"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("run=true\n");
    const invalid = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    expect(invalid.status).toBe(2);
    expect(readFileSync(output, "utf8")).toBe("run=true\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
