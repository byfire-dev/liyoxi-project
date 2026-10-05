import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, repoRoot, run, writeFiles } from "./helpers.js";

interface TreeOptions {
  /** apps/web/tsconfig.json 的内容 */
  tsconfig: unknown;
  /** 应用自己装的那一份 */
  own: string;
  /** 提升目录里放的那一份 */
  hoisted: string;
  /** 要不要另一个装着另一份的工程 apps/mini；缺省要 */
  sibling?: boolean;
}
interface TreeLib {
  buildTree(dir: string, options: TreeOptions): void;
  typesCopy(version: string): string;
}
// 照 pnpm 装出来的样子摆的小树，与门禁自测的反例共用
const tree = (await import(
  pathToFileURL(join(repoRoot, "infra/ci/selftest/lib/type-hoist-tree.mjs")).href
)) as TreeLib;

const script = join(repoRoot, "infra/ci/check-type-hoist.mjs");
const presetsDir = join(repoRoot, "packages/config/tsconfig");
/** 写 JSX 的预设：从预设目录现取，以后加一份预设不用改这里 */
const jsxPresets = readdirSync(presetsDir)
  .filter((name) => name.endsWith(".json"))
  .filter((name) => readFileSync(join(presetsDir, name), "utf8").includes('"jsx"'))
  .sort();

const viaHoist = (hoisted: string) =>
  `apps/web: @types/react 经私有提升目录解析，而各工程自己装的不是同一份（@types+react@18.0.0：apps/mini；@types+react@19.0.0：apps/web）；这一次提升的是 @types+react@${hoisted}`;
const FOREIGN =
  "apps/web: 程序里出现了不是它自己装的 @types/react：@types+react@18.0.0（它自己装的是 @types+react@19.0.0）";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const temp = makeTempDir("lyx-type-hoist-");
  cleanups.push(temp.cleanup);
  return temp.dir;
}

/** 摆一棵树，对它跑检查 */
function check(options: TreeOptions, args: string[] = []) {
  const dir = tempDir();
  tree.buildTree(dir, options);
  return run("node", [script, "--root", dir, ...args], repoRoot);
}

// 对本仓库跑检查是 CI 里单独的一步（pnpm check:type-hoist），这里不重复跑：用例只摆小树
describe("预设里的钉法", () => {
  it("写 JSX 的预设都在查的范围里", () => {
    expect(jsxPresets.length).toBeGreaterThan(0);
  });

  it.each(jsxPresets)(
    "%s：提升目录里放的是另一个大版本，组件库的 react 类型也只落在应用自己装的那一份上",
    (preset) => {
      const result = check({
        tsconfig: { extends: join(presetsDir, preset) },
        own: "19.0.0",
        hoisted: "18.0.0",
      });
      expect(result.output).toContain("查了 1 个工程（apps/web）");
      expect(result.status).toBe(0);
    },
  );
});

describe("反例", () => {
  // 应用自己写 paths 会整体顶掉预设里的 paths：钉 React 类型的几行没了，组件库的 import "react" 又得到提升目录里找
  function overridden() {
    const [preset] = jsxPresets;
    if (preset === undefined) throw new Error("没有写 JSX 的预设");
    return {
      extends: join(presetsDir, preset),
      compilerOptions: { paths: { "@/*": ["./src/*"] } },
    };
  }

  it("预设的 paths 被应用顶掉：提升的是另一个大版本时两条都拦", () => {
    const result = check({ tsconfig: overridden(), own: "19.0.0", hoisted: "18.0.0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("共 2 处");
    expect(result.stderr).toContain(viaHoist("18.0.0"));
    expect(result.stderr).toContain(FOREIGN);
  });

  it("提升的恰好是应用自己的那个大版本（这时 tsc 是绿的）也拦：要拦的是取决于提升", () => {
    const result = check({ tsconfig: overridden(), own: "19.0.0", hoisted: "19.0.0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("共 1 处");
    expect(result.stderr).toContain(viaHoist("19.0.0"));
  });

  it("paths 钉到了别的那一份：没经提升目录，第 2 条照样拦", () => {
    const result = check({
      tsconfig: {
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          noEmit: true,
          types: [],
          paths: { react: [`../../${tree.typesCopy("18.0.0")}`] },
        },
        include: ["src"],
      },
      own: "19.0.0",
      hoisted: "19.0.0",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("共 1 处");
    expect(result.stderr).toContain(FOREIGN);
  });
});

describe("不判的", () => {
  // 另一份只躺在虚拟仓库里、没有哪个工程直接装它（纯传递依赖）：提升哪一份不随项目的次序变，判了是误伤
  it("经提升目录解析到的包只有一个工程直接装：通过", () => {
    const [preset] = jsxPresets;
    if (preset === undefined) throw new Error("没有写 JSX 的预设");
    const result = check({
      tsconfig: {
        extends: join(presetsDir, preset),
        compilerOptions: { paths: { "@/*": ["./src/*"] } },
      },
      own: "19.0.0",
      hoisted: "19.0.0",
      sibling: false,
    });
    expect(result.output).toContain("经私有提升目录解析到的包 1 个（@types/react）");
    expect(result.status).toBe(0);
  });
});

describe("查哪些工程", () => {
  const plain = {
    compilerOptions: { module: "ESNext", moduleResolution: "Bundler", noEmit: true, types: [] },
    include: ["src"],
  };

  it("不写 JSX 的工程缺省不查；一个工程都没查到不算通过", () => {
    const result = check({ tsconfig: plain, own: "19.0.0", hoisted: "18.0.0" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("没有写 JSX 的工程");
  });

  it("--all 时照查", () => {
    const result = check({ tsconfig: plain, own: "19.0.0", hoisted: "18.0.0" }, ["--all"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(viaHoist("18.0.0"));
  });
});

describe("用法与环境", () => {
  it("不认识的参数、--root 后面没有值：退出码 2", () => {
    for (const args of [["--fix"], ["--root"]]) {
      const result = run("node", [script, ...args], repoRoot);
      expect(result.status, args.join(" ")).toBe(2);
    }
  });

  it("--root 下没有工作区清单、依赖没装：退出码 2，并说明要做什么", () => {
    const dir = tempDir();
    const missing = run("node", [script, "--root", dir], repoRoot);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("pnpm-workspace.yaml");

    writeFiles(dir, { "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n' });
    const notInstalled = run("node", [script, "--root", dir], repoRoot);
    expect(notInstalled.status).toBe(2);
    expect(notInstalled.stderr).toContain("先 pnpm install --frozen-lockfile");
  });

  it("工作区清单里有不认的匹配式：退出码 2，不猜", () => {
    const dir = tempDir();
    writeFiles(dir, { "pnpm-workspace.yaml": 'packages:\n  - "apps/**"\n' });
    const result = run("node", [script, "--root", dir], repoRoot);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("不认的匹配式：apps/**");
  });
});
