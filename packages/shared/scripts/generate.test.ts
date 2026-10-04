import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildGenerated, buildPreview, extraFiles, paths } from "./generate.js";
import { GENERATED_BANNER } from "./lib/tokens.js";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));

/** 色值的写法：十六进制与颜色函数。认哪些函数与 infra/ci/check-colors.mjs 一致（color() 这里不分参数，一律算） */
const COLOR_LITERAL =
  /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\b(?:(?:rgb|hsl)a?|hwb|lab|lch|oklab|oklch|color)\(/;

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

  it("目录里不是脚本写的文件认得出来（生成时据此拒绝，不靠 git）", () => {
    const fresh = buildGenerated();
    const [first = "", ...rest] = [...fresh.keys()];
    expect(extraFiles(paths.generated, fresh)).toEqual([]);
    expect(extraFiles(paths.generated, new Map(rest.map((name) => [name, ""])))).toEqual([first]);
    expect(extraFiles(join(paths.generated, "no-such-dir"), fresh)).toEqual([]);
  });

  it("每个生成物带“勿手改”的文件头，不带时间戳", () => {
    for (const [name, content] of buildGenerated()) {
      expect(content.startsWith(`// ${GENERATED_BANNER}`), name).toBe(true);
      expect(content, name).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(content.endsWith("\n"), name).toBe(true);
    }
  });
});

describe("生成物之外不写色值：生成脚本与设计地基手写的源文件", () => {
  const packageDir = join(scriptsDir, "..");
  // 只扫设计地基自己的目录；shared 里别的纯函数不归这条管
  const own = ["src/design", "src/mask", "src/format"].map((dir) => join(packageDir, dir));
  const sources = [...listFiles(scriptsDir), ...own.flatMap(listFiles)]
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .filter((file) => !file.includes("/format/") || /\/(?:datetime|duration)\.ts$/.test(file))
    .filter((file) => !file.includes("/generated/"))
    .map((file) => [file.slice(packageDir.length + 1), file] as const);

  it("脚本与手写的源文件都扫到了", () => {
    const names = sources.map(([name]) => name);
    expect(names).toContain("scripts/generate.ts");
    expect(names).toContain("scripts/lib/antd-theme.ts");
    expect(names).toContain("src/design/status-tone/index.ts");
    expect(names).toContain("src/mask/index.ts");
  });

  it.each(sources)("%s", (_name, file) => {
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
