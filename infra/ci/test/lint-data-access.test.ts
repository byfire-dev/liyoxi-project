import { join } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { repoRoot } from "./helpers.js";

// D7 第 2.2 节 D3 的 ESLint 片段：应用层源码不得引数据包与数据库驱动。
// 反例不入库：代码写在字符串里，用 lintText 按“假装的路径”过一遍根 eslint.config.js。
const eslint = new ESLint({ cwd: repoRoot });

async function lint(code: string, relativePath: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath: join(repoRoot, relativePath) });
  const messages = results.flatMap((result) => result.messages);
  return messages.map((message) => message.ruleId ?? `解析失败：${message.message}`);
}

const importOf = (specifier: string) =>
  `import { thing } from "${specifier}";\n\nexport const value = thing;\n`;

const appSources = [
  "apps/api/src/routes/orders.ts",
  "apps/worker/src/jobs/relay.ts",
  "apps/weapp/src/pages/index/index.tsx",
  "apps/admin/src/pages/orders.tsx",
  "apps/portal/src/main.tsx",
];

describe("应用层源码：禁引数据包与数据库驱动", () => {
  it.each(appSources)("%s 引 @liyoxi/db 被判错，报出 no-restricted-imports", async (path) => {
    expect(await lint(importOf("@liyoxi/db"), path)).toEqual(["no-restricted-imports"]);
  });

  it.each(["@prisma/client", "pg", "@liyoxi/db/client", "@prisma/client/runtime", "pg/lib/x"])(
    "api 的源码引 %s 被判错",
    async (specifier) => {
      expect(await lint(importOf(specifier), "apps/api/src/routes/orders.ts")).toEqual([
        "no-restricted-imports",
      ]);
    },
  );

  it("只引类型（import type）同样被判错", async () => {
    const code = 'import type { Thing } from "@liyoxi/db";\n\nexport type Value = Thing;\n';
    expect(await lint(code, "apps/worker/src/jobs/relay.ts")).toEqual(["no-restricted-imports"]);
  });

  it("引 @liyoxi/services 不误报；名字相近的包不误报", async () => {
    expect(await lint(importOf("@liyoxi/services"), "apps/api/src/routes/orders.ts")).toEqual([]);
    expect(await lint(importOf("pg-format"), "apps/api/src/routes/orders.ts")).toEqual([]);
  });

  it("全仓的 axios 禁用项在应用层源码里仍然生效（没被这一片段盖掉）", async () => {
    expect(await lint(importOf("axios"), "apps/api/src/routes/orders.ts")).toEqual([
      "no-restricted-imports",
    ]);
    expect(await lint(importOf("axios/lib/x.js"), "apps/admin/src/api.ts")).toEqual([
      "no-restricted-imports",
    ]);
  });

  it("services 与 db 自己引数据包不受这一片段约束", async () => {
    expect(await lint(importOf("@liyoxi/db"), "packages/services/src/kernel/tx.ts")).toEqual([]);
    expect(await lint(importOf("pg"), "packages/db/src/client.ts")).toEqual([]);
  });
});
