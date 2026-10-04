import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildGenerated, buildPreview, paths } from "./generate.js";
import { GENERATED_BANNER } from "./lib/tokens.js";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));

/** 色值的写法：十六进制、rgb()、rgba()、hsl()、hsla()。与 infra/ci/check-colors.mjs 同一口径 */
const COLOR_LITERAL = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\b(?:rgb|hsl)a?\(/;

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory() ? listFiles(join(dir, item.name)) : [join(dir, item.name)],
  );
}

describe("生成物无差异", () => {
  it("同一输入两次生成，字节相同", () => {
    const first = buildGenerated();
    const second = buildGenerated();
    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [name, content] of first) {
      expect(Buffer.from(second.get(name) ?? "").equals(Buffer.from(content)), name).toBe(true);
    }
    expect(buildPreview()).toBe(buildPreview());
  });

  it("入库的生成物与重新生成的逐字节相同；目录里没有别的文件", () => {
    const fresh = buildGenerated();
    expect(readdirSync(paths.generated).sort()).toEqual([...fresh.keys()].sort());
    for (const [name, content] of fresh) {
      expect(readFileSync(join(paths.generated, name), "utf8"), name).toBe(content);
    }
  });

  it("每个生成物带“勿手改”的文件头，不带时间戳", () => {
    for (const [name, content] of buildGenerated()) {
      expect(content.startsWith(`// ${GENERATED_BANNER}`), name).toBe(true);
      expect(content, name).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(content.endsWith("\n"), name).toBe(true);
    }
  });
});

describe("生成脚本里没有写死的色值", () => {
  const sources = listFiles(scriptsDir).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );

  it("脚本找得到", () => {
    expect(sources.map((file) => file.slice(scriptsDir.length)).sort()).toContain("generate.ts");
  });

  it.each(sources.map((file) => [file.slice(scriptsDir.length), file]))("%s", (_name, file) => {
    const hits = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => COLOR_LITERAL.test(line));
    expect(hits).toEqual([]);
  });
});

describe("预览页", () => {
  const html = buildPreview();

  it("含两端色板、字号、全部图标（带名字）、状态标签两端各一列", () => {
    for (const heading of ["色板", "字号", "图标", "状态标签"])
      expect(html).toContain(`<h2>${heading}`);
    for (const title of ["两端共用", "仅商家端", "仅后台"]) expect(html).toContain(title);
    expect(html).toContain("<th>商家端</th><th>后台</th>");
    expect(html).toContain("tag--merchant tag--warning");
    expect(html).toContain("tag--admin tag--info");
  });
});
