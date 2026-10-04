import { join } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { repoRoot } from "./helpers.js";

// 反例不入库：代码写在字符串里，用 lintText 按“假装的路径”过一遍根 eslint.config.js。
const eslint = new ESLint({ cwd: repoRoot });

async function lint(code: string, relativePath: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath: join(repoRoot, relativePath) });
  const messages = results.flatMap((result) => result.messages);
  // 解析失败时 ruleId 为 null：当成错误暴露出来，免得“没报规则名”被误读成通过
  return messages.map((message) => message.ruleId ?? `解析失败：${message.message}`);
}

describe("全仓：禁 axios", () => {
  it("引 axios 被判错，报出 no-restricted-imports", async () => {
    const code = 'import axios from "axios";\n\nexport const get = axios.get;\n';
    expect(await lint(code, "packages/shared/src/http.ts")).toEqual(["no-restricted-imports"]);
  });

  it("引 axios 的子路径同样被判错", async () => {
    const code = 'import settle from "axios/lib/core/settle.js";\n\nexport default settle;\n';
    expect(await lint(code, "apps/admin/src/api.ts")).toEqual(["no-restricted-imports"]);
  });

  it("引别的包不误报", async () => {
    const code = 'import { join } from "node:path";\n\nexport const p = join("a", "b");\n';
    expect(await lint(code, "packages/shared/src/path.ts")).toEqual([]);
  });
});

describe("服务端：禁 console.log", () => {
  const code = 'export function ping(): string {\n  console.log("pong");\n  return "pong";\n}\n';

  it.each([
    "apps/api/src/routes/ping.ts",
    "apps/worker/src/jobs/ping.ts",
    "packages/services/src/kernel/ping.ts",
    "packages/db/src/client.ts",
  ])("%s 里的 console.log 被判错，报出 no-console", async (path) => {
    expect(await lint(code, path)).toEqual(["no-console"]);
  });

  it("console.warn 与 console.error 放行", async () => {
    const allowed =
      'export function warn(): void {\n  console.warn("w");\n  console.error("e");\n}\n';
    expect(await lint(allowed, "apps/api/src/routes/warn.ts")).toEqual([]);
  });

  it("脚本与配置文件放宽 console", async () => {
    expect(await lint(code, "apps/api/scripts/ping.ts")).toEqual([]);
    expect(await lint(code, "apps/api/tsup.config.ts")).toEqual([]);
  });
});

describe("小程序：禁浏览器全局对象", () => {
  it("小程序路径下用 window 被判错，报出 no-restricted-globals", async () => {
    const code = "export function href(): string {\n  return window.location.href;\n}\n";
    expect(await lint(code, "apps/weapp/src/pages/index/index.tsx")).toEqual([
      "no-restricted-globals",
    ]);
  });

  it.each(["document.title", 'localStorage.getItem("k")', 'fetch("/api")'])(
    "小程序路径下用 %s 被判错",
    async (expression) => {
      const code = `export const value = ${expression};\n`;
      expect(await lint(code, "apps/weapp/src/utils/value.ts")).toEqual(["no-restricted-globals"]);
    },
  );

  it("小程序自带的全局对象放行", async () => {
    const code = "export const pages = getCurrentPages().length;\n";
    expect(await lint(code, "apps/weapp/src/utils/pages.ts")).toEqual([]);
  });

  it("后台与下载页可以用 window", async () => {
    const code = "export function href(): string {\n  return window.location.href;\n}\n";
    expect(await lint(code, "apps/admin/src/main.tsx")).toEqual([]);
    expect(await lint(code, "apps/portal/src/main.tsx")).toEqual([]);
  });
});

describe("三个前端：hooks 规则在 ESLint 10 下可用", () => {
  const code = [
    'import { useState } from "react";',
    "",
    "export function Counter(props: { on: boolean }) {",
    "  if (props.on) {",
    "    const [count] = useState(0);",
    "    return <span>{count}</span>;",
    "  }",
    "  return null;",
    "}",
    "",
  ].join("\n");

  it.each([
    "apps/weapp/src/components/counter.tsx",
    "apps/admin/src/components/counter.tsx",
    "apps/portal/src/components/counter.tsx",
  ])("%s 里条件调用 hook 被判错，报出 react-hooks/rules-of-hooks", async (path) => {
    expect(await lint(code, path)).toEqual(["react-hooks/rules-of-hooks"]);
  });
});
