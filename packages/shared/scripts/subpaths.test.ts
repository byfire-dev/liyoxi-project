import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
  exports: Record<string, string | { default: string }>;
};

/** 设计地基（W0-26）加的子路径：设计变量、图标、状态字典、时间与时长格式化、脱敏 */
const OWN = /^\.\/(?:design\/|format\/(?:datetime|duration)$|mask$)/;
const own = Object.entries(manifest.exports)
  .filter(([subpath]) => OWN.test(subpath))
  .map(([subpath, target]) => ({
    subpath,
    file: resolve(packageDir, typeof target === "string" ? target : target.default),
  }));

// 三种写法：带 from 的 import / export、没有 from 的 import "x"（只为副作用引入）、动态 import("x")。
// 本包的全部子路径另由 src/index.test.ts（W0-11）按语法树扫一遍；这里是设计地基自己的一道，按文本认
const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|(?:^|\n)\s*import\s+"([^"]+)"|import\("([^"]+)"\)/g;
/** 小程序里没有的东西：Node 内置模块、React、Zod 运行时 */
const FORBIDDEN_IMPORT = /^(?:node:|react(?:-dom)?(?:\/|$)|zod(?:\/|$)|@hono\/zod-openapi)/;
const NODE_BUILTIN = /^(?:fs|path|os|url|crypto|child_process|buffer|util|stream|events)(?:\/|$)/;
/** 小程序里没有的全局对象 */
const FORBIDDEN_GLOBAL = /\b(?:process\.|Buffer\b|require\(|__dirname|window\.|document\.|Intl\.)/;

/** 从入口出发，沿相对 import 走到的全部源文件 */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    const text = readFileSync(file, "utf8");
    const specifiers = [...text.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
    seen.set(file, specifiers);
    for (const specifier of specifiers) {
      if (specifier.startsWith("."))
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return seen;
}

describe("本包新增的子路径", () => {
  it("十个子路径都在，各自指到存在的文件", () => {
    expect(own.map((item) => item.subpath).sort()).toEqual(
      [
        "./design/admin.scss",
        "./design/antd-theme",
        "./design/icons",
        "./design/icons-mask.scss",
        "./design/merchant.scss",
        "./design/status-tone",
        "./design/tokens",
        "./format/datetime",
        "./format/duration",
        "./mask",
      ].sort(),
    );
    for (const { subpath, file } of own) expect(existsSync(file), subpath).toBe(true);
  });

  const modules = own.filter((item) => item.file.endsWith(".ts"));

  it.each(modules.map((item) => [item.subpath, item.file]))(
    "%s：可达的源文件不 import node:、react、zod，不用小程序里没有的全局对象",
    (_subpath, file) => {
      for (const [source, specifiers] of reachable(file)) {
        for (const specifier of specifiers) {
          expect(FORBIDDEN_IMPORT.test(specifier), `${source} 引了 ${specifier}`).toBe(false);
          expect(NODE_BUILTIN.test(specifier), `${source} 引了 ${specifier}`).toBe(false);
          // 只走相对路径，不引别的包：纯子路径不带进任何依赖
          expect(specifier.startsWith("."), `${source} 引了包 ${specifier}`).toBe(true);
        }
        const code = readFileSync(source, "utf8")
          .split("\n")
          .filter(
            (line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"),
          );
        const hits = code.filter((line) => FORBIDDEN_GLOBAL.test(line));
        expect(hits, source).toEqual([]);
      }
    },
  );

  it.each(modules.map((item) => [item.subpath]))("%s：按包名能引到", async (subpath) => {
    const loaded: unknown = await import(`@liyoxi/shared${subpath.slice(1)}`);
    expect(Object.keys(loaded as object).length).toBeGreaterThan(0);
  });

  it("扫描本身有效：喂一个引了 node:fs 的文件能认出来", () => {
    expect(FORBIDDEN_IMPORT.test("node:fs")).toBe(true);
    expect(FORBIDDEN_IMPORT.test("react/jsx-runtime")).toBe(true);
    expect(FORBIDDEN_IMPORT.test("zod")).toBe(true);
    expect([...'import { readFileSync } from "node:fs";'.matchAll(IMPORT)][0]?.[1]).toBe("node:fs");
    expect([...'import "node:fs";'.matchAll(IMPORT)][0]?.[2]).toBe("node:fs");
    expect([...'const fs = await import("node:fs");'.matchAll(IMPORT)][0]?.[3]).toBe("node:fs");
    expect(FORBIDDEN_GLOBAL.test("const tz = process.env.TZ;")).toBe(true);
  });
});
