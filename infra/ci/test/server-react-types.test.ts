import { cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, repoRoot, writeFiles } from "./helpers.js";

const entries = ["packages/services", "apps/api", "apps/worker"] as const;
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function link(target: string, path: string) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(relative(dirname(path), target), path, "dir");
}

/** 真声明复制进临时虚拟仓库；其余类型依赖只读链接，不改安装树。 */
function copyReactTypes(root: string, project: string) {
  const source = realpathSync(join(repoRoot, project, "node_modules/@types/react"));
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as {
    version: string;
    dependencies: Record<string, string>;
  };
  const target = join(
    root,
    `node_modules/.pnpm/@types+react@${manifest.version}/node_modules/@types/react`,
  );
  cpSync(source, target, { recursive: true });
  for (const name of Object.keys(manifest.dependencies)) {
    link(realpathSync(resolve(source, "../..", name)), resolve(target, "../..", name));
  }
  return target;
}

function fixture() {
  const { dir: temporaryDir, cleanup } = makeTempDir("lyx-server-react-types-");
  const dir = realpathSync(temporaryDir);
  cleanups.push(cleanup);
  for (const file of ["base.json", "node-lib.json", "node-app.json"]) {
    const path = `packages/config/tsconfig/${file}`;
    writeFiles(dir, { [path]: readFileSync(join(repoRoot, path), "utf8") });
  }
  for (const entry of entries) {
    for (const file of ["tsconfig.json", "package.json"]) {
      const path = `${entry}/${file}`;
      writeFiles(dir, { [path]: readFileSync(join(repoRoot, path), "utf8") });
    }
  }

  const react19 = copyReactTypes(dir, "packages/services");
  const react18 = copyReactTypes(dir, "apps/weapp");
  link(react19, join(dir, "packages/services/node_modules/@types/react"));
  link(react18, join(dir, "node_modules/.pnpm/node_modules/@types/react"));
  link(
    realpathSync(join(repoRoot, "node_modules/@types/node")),
    join(dir, "node_modules/@types/node"),
  );

  const originalRenderer = realpathSync(
    join(repoRoot, "packages/services/node_modules/@react-pdf/renderer"),
  );
  const renderer = join(dir, "node_modules/.pnpm/renderer/node_modules/@react-pdf/renderer");
  // 不链接 renderer 本身：realpath 回到真实安装树就无法固定它看见的提升版本。
  for (const file of ["index.d.ts", "package.json"]) {
    writeFiles(renderer, { [file]: readFileSync(join(originalRenderer, file), "utf8") });
  }
  link(
    realpathSync(resolve(originalRenderer, "../..", "@react-pdf/types")),
    resolve(renderer, "../..", "@react-pdf/types"),
  );
  const runtimeReact = realpathSync(join(repoRoot, "packages/services/node_modules/react"));
  link(runtimeReact, resolve(renderer, "../..", "react"));
  for (const entry of entries) {
    link(renderer, join(dir, entry, "node_modules/@react-pdf/renderer"));
    link(runtimeReact, join(dir, entry, "node_modules/react"));
  }
  for (const app of ["apps/api", "apps/worker"]) {
    link(join(dir, "packages/services"), join(dir, app, "node_modules/@liyoxi/services"));
    writeFiles(dir, {
      [`${app}/src/index.ts`]: 'export { render } from "@liyoxi/services";\n',
    });
  }
  writeFiles(dir, {
    "packages/services/src/index.ts": [
      'import { createElement } from "react";',
      'import { Document, Page, Text, renderToBuffer } from "@react-pdf/renderer";',
      "export const render = () => renderToBuffer(",
      "  createElement(Document, null,",
      '    createElement(Page, null, createElement(Text, null, "PDF type probe"))),',
      ");",
      "",
    ].join("\n"),
  });
  return { dir, react18, react19, rendererDeclaration: join(renderer, "index.d.ts") };
}

function parseEntry(root: string, entry: string) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(root, entry, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!parsed) throw new Error(`Cannot parse ${entry}`);
  expect(parsed.errors).toEqual([]);
  return parsed;
}

function diagnostics(config: ts.ParsedCommandLine, options: ts.CompilerOptions) {
  return ts.getPreEmitDiagnostics(ts.createProgram({ rootNames: config.fileNames, options }));
}

describe("服务端 PDF 的 React 类型不依赖私有提升", () => {
  it.each(entries)("%s：真实声明提升为 18 时，入口 paths 仍统一使用 19", (entry) => {
    const input = fixture();
    const config = parseEntry(input.dir, entry);
    const withoutPaths = { ...config.options, paths: undefined };
    // renderer 的 package.json 是 type:module，实际 Program 用 NodeNext ESM。
    // 省略 resolutionMode 会按 CJS 解析，错误地允许目录/隐式扩展名映射通过此断言。
    const resolved = (specifier: string, options: ts.CompilerOptions) =>
      ts.resolveModuleName(
        specifier,
        input.rendererDeclaration,
        options,
        ts.sys,
        undefined,
        undefined,
        ts.ModuleKind.ESNext,
      ).resolvedModule?.resolvedFileName;

    // 先证实同一输入在旧配置下真的读到 18，并重现 createElement 的 contextType 冲突。
    expect(resolved("react", withoutPaths)).toBe(join(input.react18, "index.d.ts"));
    const original = diagnostics(config, withoutPaths);
    expect(original.some((diagnostic) => diagnostic.code === 2769)).toBe(true);
    expect(
      original
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
        .join("\n"),
    ).toContain("contextType");

    expect(resolved("react", config.options)).toBe(join(input.react19, "index.d.ts"));
    expect(resolved("react/jsx-runtime", config.options)).toBe(
      join(input.react19, "jsx-runtime.d.ts"),
    );
    expect(
      diagnostics(config, config.options).map((diagnostic) => ({
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      })),
    ).toEqual([]);
  });
});
