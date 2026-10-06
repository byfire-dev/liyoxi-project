import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { makeTempDir, repoRoot, run, writeFiles } from "./helpers.js";

type PagesCase = {
  reason: RegExp;
  run(ctx: {
    repoRoot: string;
    tempDir(): string;
    writeFiles: typeof writeFiles;
    node(script: string, args: string[]): { status: number; output: string };
  }): { status: number; output: string };
};

const generator = join(repoRoot, "infra/ci/pages/generate.mjs");
const definition = (
  (await import(pathToFileURL(join(repoRoot, "infra/ci/selftest/cases/pages-stale.mjs")).href)) as {
    default: PagesCase;
  }
).default;

describe("页面清单反例不随页面交付失效", () => {
  it.each([false, true])("资质审核 implemented=%s：真生成器拦住翻转后的清单", (implemented) => {
    const fixture = makeTempDir("lyx-pages-stale-");
    try {
      writeFiles(fixture.dir, {
        "apps/admin/src/lib/menu/_base.ts": "export default { pages: [] };\n",
        "apps/admin/src/lib/menu/merchant.ts": `export default {
          key: "merchant", title: "商家", order: 1,
          pages: [{ key: "review", module: "merchant", title: "资质审核",
            path: "/merchant/review", kind: "board", skeleton: "queue-workbench",
            milestone: "M1", workPackage: "W1-09", implemented: ${implemented} }]
        };\n`,
        "apps/portal/src/pages.ts": "export const PORTAL_PAGES = [];\n",
        "apps/weapp/src/pages.ts": "export const WEAPP_PAGES = [];\n",
      });
      const pages = join(fixture.dir, "docs/plan/pages.md");
      writeFiles(fixture.dir, { "docs/plan/pages.md": "" });
      const generated = run(process.execPath, [generator, "--root", fixture.dir], repoRoot);
      expect(generated.status, generated.output).toBe(0);
      const clean = run(process.execPath, [generator, "--root", fixture.dir, "--check"], repoRoot);
      expect(clean.status, clean.output).toBe(0);

      const result = definition.run({
        repoRoot: fixture.dir,
        tempDir: () => join(fixture.dir, "mutated"),
        writeFiles,
        node: (script, args) =>
          run(process.execPath, [join(repoRoot, script), ...args, "--root", fixture.dir], repoRoot),
      });
      expect(result.status, result.output).toBe(1);
      expect(definition.reason.test(result.output), result.output).toBe(true);
      const stored = implemented ? "否" : "是";
      const expected = implemented ? "是" : "否";
      expect(result.output).toMatch(new RegExp(`入库的：[^\\n]*资质审核[^\\n]*\\| ${stored} \\|`));
      expect(result.output).toMatch(
        new RegExp(`应该是：[^\\n]*资质审核[^\\n]*\\| ${expected} \\|`),
      );
      // 输出仅在两个相反值之间才匹配；同值或不相关失败原因不可蒙混过关。
      expect(
        definition.reason.test(
          result.output.replace(/(入库的：[^\n]*)\| (是|否) \|(?=\r?\n)/, `$1| ${expected} |`),
        ),
      ).toBe(false);
      expect(definition.reason.test("登记有问题，生成不了。")).toBe(false);
      // 反例写在独立文件，正常登记与清单仍然通过。
      const unchanged = run(
        process.execPath,
        [generator, "--root", fixture.dir, "--out", pages, "--check"],
        repoRoot,
      );
      expect(unchanged.status, unchanged.output).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });
});
