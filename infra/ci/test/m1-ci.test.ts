import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repoRoot } from "./helpers.js";
const read = (name: string) => readFileSync(join(repoRoot, ".github/workflows", name), "utf8");

describe("M1 新增 CI 验收边界", () => {
  it.each(["ci.yml", "nightly.yml"])(
    "%s 包含真实主路径、留桩、额外严格覆盖和 M0/M1 清零",
    (name) => {
      const source = read(name);
      for (const command of [
        "pnpm e2e",
        "node infra/ci/check-stubs.mjs",
        "pnpm machines:coverage -- --strict --contract",
        "node infra/ci/landed.mjs --check --require M0,M1",
        "node infra/ci/four-counts.mjs --require M0,M1",
      ])
        expect(
          source.split("\n").some((line) => line.trim() === `run: ${command}`),
          command,
        ).toBe(true);
      expect(source.indexOf("apps/api/test/probes.test.ts")).toBeLessThan(
        source.indexOf("landed.mjs --check --require M0,M1"),
      );
    },
  );
  it("重复验收只手动 main，不读业务凭据，失败仍上传部分结果", () => {
    const source = read("e2e-repeat.yml");
    expect(source).toMatch(/on:\n {2}workflow_dispatch:\n/);
    expect(source).not.toMatch(/^ {2}(push|pull_request|schedule|workflow_call):/m);
    expect(source).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
    expect(source).not.toMatch(/secrets\./);
    expect(source).toContain("run: node infra/ci/e2e-repeat.mjs --times 10");
    expect(source).toMatch(/- name: 保存连续运行结果\n {8}if: always\(\)/);
    expect(source).toContain("path: apps/api/dist/e2e-repeat/");
    expect(source).toContain("persist-credentials: false");
  });
});
