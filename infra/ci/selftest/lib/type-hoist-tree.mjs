// “类型解析不靠提升”检查（infra/ci/check-type-hoist.mjs）的反例与用例共用的一棵小树。
// 照 pnpm 装出来的样子手工摆，不真的安装：
//   node_modules/.pnpm/@types+react@18.0.0/node_modules/@types/react/   类型包，装了两份
//   node_modules/.pnpm/@types+react@19.0.0/node_modules/@types/react/
//   node_modules/.pnpm/ui-kit@1.0.0/node_modules/ui-kit/                组件库：类型里写 import "react"，自己不带 @types/react
//   node_modules/.pnpm/node_modules/@types/react                        私有提升目录：链到其中一份（hoisted）
//   apps/web/                                                           被查的应用：装着自己的那一份（own）与 ui-kit
//   apps/mini/                                                          另一个工程：装着另一份（没有 tsconfig，不被查）
// 两份类型包与真的一样不相容（19 的 ReactNode 多一个 bigint）：ui-kit 解析到 18、应用自己用 19 时 tsc 会报错。

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const REACT_NODE = {
  "18.0.0": "string | number | boolean | null | undefined",
  "19.0.0": "string | number | bigint | boolean | null | undefined",
};

/** 虚拟仓库里某一份类型包的目录（相对树根） */
export const typesCopy = (version) =>
  `node_modules/.pnpm/@types+react@${version}/node_modules/@types/react`;

/**
 * 在 dir 下摆出这棵树。
 *   tsconfig  apps/web/tsconfig.json 的内容（对象）
 *   own       应用自己装的那一份的版本
 *   hoisted   提升目录里放的那一份的版本
 *   sibling   要不要 apps/mini（缺省要）。不要时，另一份类型包只躺在虚拟仓库里，没有哪个工程直接装它
 */
export function buildTree(dir, { tsconfig, own, hoisted, sibling = true }) {
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const link = (path, target) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    symlinkSync(relative(dirname(join(dir, path)), join(dir, target)), join(dir, path), "dir");
  };
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

  write("pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n');
  for (const [version, node] of Object.entries(REACT_NODE)) {
    write(
      `${typesCopy(version)}/package.json`,
      json({ name: "@types/react", version, types: "index.d.ts" }),
    );
    write(`${typesCopy(version)}/index.d.ts`, `export type ReactNode = ${node};\n`);
  }
  const uiKit = "node_modules/.pnpm/ui-kit@1.0.0/node_modules/ui-kit";
  write(
    `${uiKit}/package.json`,
    json({
      name: "ui-kit",
      version: "1.0.0",
      types: "index.d.ts",
      peerDependencies: { react: "*" },
    }),
  );
  write(
    `${uiKit}/index.d.ts`,
    'import type { ReactNode } from "react";\nexport declare function show(node: ReactNode): void;\n',
  );
  link("node_modules/.pnpm/node_modules/@types/react", typesCopy(hoisted));

  write(
    "apps/web/package.json",
    json({
      name: "web",
      private: true,
      type: "module",
      dependencies: { "ui-kit": "1.0.0" },
      devDependencies: { "@types/react": own },
    }),
  );
  write("apps/web/tsconfig.json", json(tsconfig));
  write(
    "apps/web/src/main.ts",
    [
      'import type { ReactNode } from "react";',
      'import { show } from "ui-kit";',
      "",
      "export function render(node: ReactNode): void {",
      "  show(node);",
      "}",
      "",
    ].join("\n"),
  );
  link("apps/web/node_modules/@types/react", typesCopy(own));
  link("apps/web/node_modules/ui-kit", uiKit);

  if (!sibling) return;
  const other = Object.keys(REACT_NODE).find((version) => version !== own);
  write(
    "apps/mini/package.json",
    json({
      name: "mini",
      private: true,
      type: "module",
      devDependencies: { "@types/react": other },
    }),
  );
  link("apps/mini/node_modules/@types/react", typesCopy(other));
}
