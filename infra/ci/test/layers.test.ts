import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, repoRoot, run, writeFiles } from "./helpers.js";

// 依赖方向与分层门禁的用例（W0-02 任务书 第 7 节第 3–7 条）。
// 反例是 infra/ci/fixtures/layers/ 下的小树，一个反例一个夹具；进到夹具目录里跑
// dependency-cruiser，用的是仓库根的那份规则，所以改规则不必改夹具。
// 跑夹具时给解析设了界（resolve-in-tree.mjs），夹具的结果不随检出位置与外面装了什么而变。

const depcruiseBin = join(repoRoot, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");
const configPath = join(repoRoot, ".dependency-cruiser.cjs");
const resolveInTreePath = join(repoRoot, "infra/ci/test/resolve-in-tree.mjs");
const fixturesDir = join(repoRoot, "infra/ci/fixtures/layers");
const checkLayersScript = join(repoRoot, "infra/ci/check-layers.mjs");
const layersPath = join(repoRoot, "infra/ci/layers.json");

const S = "packages/services/src";
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

interface CruiseResult {
  status: number;
  /** “规则名: 起点 → 终点”，已排序。成环的违规终点为空 */
  violations: string[];
  /** 报出的规则名，去重后排序 */
  rules: string[];
  output: string;
}

/** 对一个目录跑 dependency-cruiser，报告格式与 pnpm depcheck 相同。extraArgs 是另加的命令行参数 */
function cruiseDir(
  dir: string,
  targets: readonly string[],
  extraArgs: readonly string[] = [],
): CruiseResult {
  const result = run(
    process.execPath,
    [depcruiseBin, ...targets, "--config", configPath, ...extraArgs],
    dir,
  );
  const output = result.output.replace(ANSI, "");
  const matches = [...output.matchAll(/^\s*error ([\w-]+): (\S+) → ?(\S*)$/gm)];
  const violations = matches.map(([, rule, from, to]) => `${rule}: ${from} → ${to}`).sort();
  const rules = [...new Set(matches.map(([, rule]) => rule ?? ""))].sort();
  return { status: result.status, violations, rules, output };
}

/**
 * 跑一个夹具。夹具自成一棵树：默认给解析设界，落在夹具目录之外的一律当作解析不了，
 * 按包名写的引用留下的就总是包名本身。bounded 传 false 只给对照用例用，看不设界时会怎样
 */
function cruiseFixture(dir: string, bounded = true): CruiseResult {
  const targets = ["apps", "packages"].filter((name) => existsSync(join(dir, name)));
  return cruiseDir(dir, targets, bounded ? ["--webpack-config", resolveInTreePath] : []);
}

function cruise(fixture: string): CruiseResult {
  return cruiseFixture(join(fixturesDir, fixture));
}

/** 夹具 → 期望的全部违规。空数组 = 应当通过。成环的夹具另测（终点不稳定，只比规则名） */
const expected: Record<string, string[]> = {
  // ---- packages/services 内部 ----
  "cross-layer": [`layer-L2-no-upward: ${S}/billing/index.ts → ${S}/order/index.ts`],
  "upward-each-layer": [
    `layer-L0-no-upward: ${S}/kernel/index.ts → ${S}/identity/index.ts`,
    `layer-L1-no-upward: ${S}/identity/index.ts → ${S}/billing/index.ts`,
    `layer-L2-no-upward: ${S}/billing/index.ts → ${S}/order/index.ts`,
    `layer-L3-no-upward: ${S}/order/index.ts → ${S}/workbench/index.ts`,
  ],
  "upward-type-only": [`layer-L0-no-upward: ${S}/flow/index.ts → ${S}/order/index.ts`],
  "downward-ok": [],
  "same-layer-allowed": [],
  "same-layer-denied": [
    `layer-L1-same-layer-whitelist: ${S}/media/index.ts → ${S}/notify/index.ts`,
    `layer-L1-same-layer-whitelist: ${S}/tenant/index.ts → ${S}/identity/index.ts`,
    `layer-L3-same-layer-whitelist: ${S}/ad/index.ts → ${S}/order/index.ts`,
  ],
  "module-internal": [
    `module-public-api: ${S}/index.ts → ${S}/ad/pricing.ts`,
    `module-public-api: ${S}/order/index.ts → ${S}/ad/pricing.ts`,
    `module-public-api: ${S}/order/index.ts → ${S}/billing/ledger.ts`,
  ],
  "providers-driver": [`providers-via-types: ${S}/billing/index.ts → ${S}/providers/index.ts`],
  "unregistered-module": [
    `services-unregistered-module: ${S}/order/index.ts → ${S}/partner/index.ts`,
  ],
  // ---- 包间方向 ----
  "fe-imports-db": [
    "db-only-from-services: apps/weapp/src/by-path.ts → packages/db/src/index.ts",
    "db-only-from-services: apps/weapp/src/index.ts → @liyoxi/db",
    "fe-no-server: apps/weapp/src/by-path.ts → packages/db/src/index.ts",
    "fe-no-server: apps/weapp/src/index.ts → @liyoxi/db",
  ],
  "fe-imports-services": [
    "fe-no-server: apps/admin/src/index.ts → @liyoxi/services",
    "fe-no-server: apps/portal/src/index.ts → packages/services/src/index.ts",
  ],
  "contract-imports-workspace": [
    "contract-is-leaf: packages/contract/src/index.ts → @liyoxi/config/eslint",
    "contract-is-leaf: packages/contract/src/index.ts → @liyoxi/services",
    "contract-is-leaf: packages/contract/src/index.ts → @liyoxi/shared",
    "contract-is-leaf: packages/contract/src/index.ts → packages/shared/src/index.ts",
  ],
  "contract-imports-react-prisma": [
    "contract-no-react-prisma: packages/contract/src/index.ts → @prisma/client",
    "contract-no-react-prisma: packages/contract/src/index.ts → react",
    "db-only-from-services: packages/contract/src/index.ts → @prisma/client",
  ],
  "shared-imports-services-db": [
    "db-only-from-services: packages/shared/src/index.ts → @liyoxi/db",
    "shared-only-contract: packages/shared/src/index.ts → @liyoxi/db",
    "shared-only-contract: packages/shared/src/index.ts → @liyoxi/services",
    "shared-only-contract: packages/shared/src/index.ts → packages/services/src/index.ts",
  ],
  "shared-impure": [
    "shared-no-node: packages/shared/src/index.ts → fs",
    "shared-no-node: packages/shared/src/index.ts → path",
    "shared-no-react: packages/shared/src/index.ts → react",
  ],
  "shared-reaches-zod": [
    "shared-no-zod: packages/shared/src/index.ts → zod",
    "shared-no-zod: packages/shared/src/money.ts → zod",
  ],
  "weapp-reaches-zod": [
    "weapp-no-zod: apps/weapp/src/api.ts → @hono/zod-openapi",
    "weapp-no-zod: apps/weapp/src/api.ts → zod",
    "weapp-no-zod: apps/weapp/src/index.ts → @hono/zod-openapi",
    "weapp-no-zod: apps/weapp/src/index.ts → zod",
  ],
  "db-imports-shared": [
    "db-only-contract: packages/db/src/index.ts → @liyoxi/shared",
    "db-only-contract: packages/db/src/index.ts → packages/shared/src/index.ts",
  ],
  "app-imports-db": [
    "db-only-from-services: apps/api/src/index.ts → @liyoxi/db",
    "db-only-from-services: apps/api/src/index.ts → @prisma/client",
    "db-only-from-services: apps/api/src/index.ts → pg",
    "db-only-from-services: apps/worker/src/index.ts → packages/db/src/index.ts",
  ],
  "package-imports-app": [`packages-not-to-apps: ${S}/kernel/index.ts → apps/api/src/index.ts`],
  "app-imports-app": [
    "apps-not-to-apps: apps/worker/src/index.ts → @liyoxi/admin",
    "apps-not-to-apps: apps/worker/src/index.ts → apps/api/src/index.ts",
  ],
  "app-deep-imports-services": [
    `apps-via-services-entry: apps/api/src/index.ts → ${S}/billing/index.ts`,
  ],
  // ---- 正例：允许的方向全部走一遍 ----
  allowed: [],
};

/** root 是夹具所在的目录；默认是仓库里的那份，证明“结果不随位置而变”的用例传仓库外的副本 */
function expectViolations(fixture: string, root = fixturesDir): CruiseResult {
  const result = cruiseFixture(join(root, fixture));
  const wanted = expected[fixture] ?? [];
  expect(result.violations, result.output).toEqual([...wanted].sort());
  if (wanted.length === 0) expect(result.status, result.output).toBe(0);
  else expect(result.status, result.output).not.toBe(0);
  return result;
}

describe("干净树无违规", () => {
  it("pnpm depcheck 跑的就是下面两步", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.depcheck).toBe(
      "node infra/ci/check-layers.mjs && depcruise apps packages infra --config .dependency-cruiser.cjs",
    );
  });

  it("本仓库：分层登记核对通过", () => {
    const result = run(process.execPath, [checkLayersScript], repoRoot);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("本仓库：dependency-cruiser 违规 0 条", () => {
    const result = cruiseDir(repoRoot, ["apps", "packages", "infra"]);
    expect(result.violations).toEqual([]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("no dependency violations found");
  });
});

describe("三个反例各使检查失败（验收第 4 条）", () => {
  it("越层：billing 引 order，报出 layer-L2-no-upward", () => {
    const result = expectViolations("cross-layer");
    expect(result.rules).toEqual(["layer-L2-no-upward"]);
  });

  it("成环：两个模块互引，报出 no-circular", () => {
    const result = cruise("circular");
    expect(result.status, result.output).not.toBe(0);
    // events 与 audit 同在 L0，同层可互引，所以只有成环这一条
    expect(result.rules).toEqual(["no-circular"]);
    expect(result.output).toContain(`${S}/events/index.ts`);
    expect(result.output).toContain(`${S}/audit/index.ts`);
  });

  it("前端引数据包：apps/weapp 引 @liyoxi/db，按包名与按路径两种写法都报出 fe-no-server", () => {
    const result = expectViolations("fe-imports-db");
    expect(result.rules).toEqual(["db-only-from-services", "fe-no-server"]);
  });
});

describe("分层：同步调用只能向下", () => {
  it("每一层引更高的层都失败，各报出自己那层的规则名", () => {
    expectViolations("upward-each-layer");
  });

  it("只在类型上引上层（import type）同样失败", () => {
    expectViolations("upward-type-only");
  });

  it("向下引、跨层向下引都通过", () => {
    expectViolations("downward-ok");
  });
});

describe("同层白名单（验收第 5 条）", () => {
  it("白名单里的通过：order 引 ad，以及 L1、L3 白名单的全部 18 条；L0、L4 同层可互引", () => {
    expectViolations("same-layer-allowed");
  });

  it("白名单外的失败：ad 引 order，报出 layer-L3-same-layer-whitelist", () => {
    const result = expectViolations("same-layer-denied");
    expect(result.rules).toEqual([
      "layer-L1-same-layer-whitelist",
      "layer-L3-same-layer-whitelist",
    ]);
  });

  it("引对方 index.ts 以外的文件失败，报出 module-public-api；引自己模块里的文件不算", () => {
    expectViolations("module-internal");
  });
});

describe("Q4 的方向（验收第 6 条）", () => {
  it("contract 引任一工作区包失败，报出 contract-is-leaf", () => {
    expectViolations("contract-imports-workspace");
  });

  it("shared 引 services 或 db 失败，报出 shared-only-contract", () => {
    expectViolations("shared-imports-services-db");
  });

  it("shared 经 contract 的入口可达 zod 失败，报出 shared-no-zod", () => {
    const result = expectViolations("shared-reaches-zod");
    // 报告里带出到达 zod 的路径
    expect(result.output).toContain("packages/contract/src/schemas.ts");
  });

  it("apps/weapp 经两跳可达 zod 或 @hono/zod-openapi 失败，报出 weapp-no-zod", () => {
    expectViolations("weapp-reaches-zod");
  });
});

describe("其余包间规则各有反例", () => {
  it.each([
    ["contract 引 react、@prisma/client", "contract-imports-react-prisma"],
    ["shared 的源码引 Node 内置模块与 react；测试文件引 node:fs 不算", "shared-impure"],
    ["db 引 shared", "db-imports-shared"],
    ["api、worker 引 @liyoxi/db、@prisma/client、pg", "app-imports-db"],
    ["包引应用", "package-imports-app"],
    ["应用引应用", "app-imports-app"],
    ["api 绕过 services 的入口引模块", "app-deep-imports-services"],
    ["后台、下载页引 services", "fe-imports-services"],
    ["领域模块引 providers 的 types 以外的文件；kernel 引不算", "providers-driver"],
    ["引一个没登记的模块目录", "unregistered-module"],
  ])("%s：失败并报出对应规则名", (_label, fixture) => {
    const result = expectViolations(fixture);
    expect(result.status).not.toBe(0);
  });

  it("正例：允许的方向全部走一遍，违规 0 条", () => {
    expectViolations("allowed");
  });
});

describe("夹具的结果不随检出位置与外面装了什么而变", () => {
  // 模块解析会沿目录一直往上找 node_modules。检出放在家目录之下、家目录里又有 node_modules/zod 时，
  // 夹具里的 import "zod" 被解析到了那里：终点成了 ../../…/node_modules/zod/index.d.cts，与 expected
  // 里的包名对不上。有的违规还会整条不见，改写报出来的路径救不回来，所以办法是给解析设界。
  // 这里在仓库外照那个样子造一棵树：<根>/node_modules/<包>/ 与 <根>/checkout/<夹具>/。

  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  /** 夹具的全部文件：相对路径 → 内容 */
  function readFixture(fixture: string): Record<string, string> {
    const dir = join(fixturesDir, fixture);
    return Object.fromEntries(
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .map((file) => [file.slice(dir.length + 1), readFileSync(file, "utf8")]),
    );
  }

  /** 夹具里按包名写的引用，如 zod、@liyoxi/config/eslint。Node 内置模块不算 */
  function bareSpecifiers(fixture: string): string[] {
    const found = Object.values(readFixture(fixture)).flatMap((source) =>
      [...source.matchAll(/(?:import|from)\s+"([^".][^"]*)"/g)].map(([, name]) => name ?? ""),
    );
    return [...new Set(found)].filter((name) => process.getBuiltinModule(name) === undefined);
  }

  /** 在 root/node_modules 下装一个假包；引用带子路径的（@liyoxi/config/eslint）子路径也解析得到 */
  function installAbove(root: string, specifier: string): void {
    const name = specifier
      .split("/")
      .slice(0, specifier.startsWith("@") ? 2 : 1)
      .join("/");
    const subpath = specifier.slice(name.length + 1);
    // 类型包没有 main，入口是 types 指的声明文件
    const [field, entry] = name.startsWith("@types/")
      ? ["types", "index.d.ts"]
      : ["main", "index.js"];
    writeFiles(join(root, "node_modules", name), {
      "package.json": JSON.stringify({ name, version: "0.0.0", [field]: entry }),
      [entry]: "export {};\n",
      ...(subpath === "" ? {} : { [`${subpath}.js`]: "export {};\n" }),
    });
  }

  /** 造一棵树：packages 装在 <根>/node_modules 下，fixtures 拷到 <根>/checkout 下。返回 <根>/checkout */
  function checkoutBelow(packages: readonly string[], fixtures: readonly string[]): string {
    const temp = makeTempDir("lyx-layers-above-");
    cleanups.push(temp.cleanup);
    for (const specifier of packages) installAbove(temp.dir, specifier);
    const checkout = join(temp.dir, "checkout");
    for (const fixture of fixtures) writeFiles(join(checkout, fixture), readFixture(fixture));
    return checkout;
  }

  const sorted = (fixture: string): string[] => [...(expected[fixture] ?? [])].sort();
  const zodFixtures = ["shared-reaches-zod", "weapp-reaches-zod"];

  it("上层目录有 node_modules/zod：两条 zod 规则照样报出，终点仍是包名", () => {
    const checkout = checkoutBelow(["zod"], zodFixtures);
    expect(expectViolations("shared-reaches-zod", checkout).rules).toEqual(["shared-no-zod"]);
    expect(expectViolations("weapp-reaches-zod", checkout).rules).toEqual(["weapp-no-zod"]);
  });

  it("对照：同一棵树不设界，zod 被解析到上层去，终点与 expected 对不上", () => {
    const checkout = checkoutBelow(["zod"], zodFixtures);
    for (const fixture of zodFixtures) {
      const result = cruiseFixture(join(checkout, fixture), false);
      expect(result.output).toContain("→ ../../node_modules/zod/index.js");
      expect(result.violations, fixture).not.toEqual(sorted(fixture));
    }
  });

  it("夹具按包名引用的包在上层全都装着：凡有这类引用的夹具，结果都与 expected 逐字相同", () => {
    const fixtures = Object.keys(expected).filter((fixture) => bareSpecifiers(fixture).length > 0);
    const packages = [...new Set(fixtures.flatMap(bareSpecifiers))];
    // 扫得出东西：两条 zod 规则的终点，以及工作区包、数据库驱动、react 都在里面
    expect(packages).toEqual(
      expect.arrayContaining([
        "zod",
        "@hono/zod-openapi",
        "react",
        "pg",
        "@prisma/client",
        "@liyoxi/db",
        "@liyoxi/config/eslint",
      ]),
    );

    const checkout = checkoutBelow(packages, fixtures);
    for (const fixture of fixtures) expectViolations(fixture, checkout);
    // 对照：不设界时 @liyoxi/db 被解析到上层去，按包名引用的那两条不再与 expected 相同
    expect(cruiseFixture(join(checkout, "fe-imports-db"), false).violations).not.toEqual(
      sorted("fe-imports-db"),
    );
  });

  it("上层只有类型包 @types/react（react 会被解析成它）：react 的两条规则照样报出", () => {
    const fixtures = ["shared-impure", "contract-imports-react-prisma"];
    const checkout = checkoutBelow(["@types/react"], fixtures);
    for (const fixture of fixtures) expectViolations(fixture, checkout);
    // 对照：不设界时 react 被解析成 ../../node_modules/@types/react/index.d.ts，结果与 expected 不同
    //（眼下的规则认不出这个路径，react 那一条整条不见）
    for (const fixture of fixtures) {
      const result = cruiseFixture(join(checkout, fixture), false);
      expect(result.violations, fixture).not.toEqual(sorted(fixture));
    }
  });
});

describe("规则与夹具对得上", () => {
  interface Rule {
    name: string;
    severity: string;
    to: { path?: string };
  }

  async function loadRules(): Promise<Rule[]> {
    const loaded = (await import(pathToFileURL(configPath).href)) as {
      default: { forbidden: Rule[] };
    };
    return loaded.default.forbidden;
  }

  it("每个夹具都有用例，每个用例都有夹具", () => {
    const dirs = readdirSync(fixturesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs).toEqual([...Object.keys(expected), "circular"].sort());
  });

  it("规则全是 error 级；夹具里报出过的规则名都在规则清单里", async () => {
    const rules = await loadRules();
    expect(rules.filter((rule) => rule.severity !== "error")).toEqual([]);
    const names = new Set(rules.map((rule) => rule.name));
    const reported = Object.values(expected)
      .flat()
      .map((violation) => violation.split(":")[0] ?? "");
    expect([...new Set([...reported, "no-circular"])].filter((name) => !names.has(name))).toEqual(
      [],
    );
  });

  it("规则清单里的每条规则都有夹具报出过", async () => {
    const rules = await loadRules();
    const reported = new Set(
      Object.values(expected)
        .flat()
        .map((violation) => violation.split(":")[0] ?? ""),
    );
    reported.add("no-circular");
    expect(
      [...new Set(rules.map((rule) => rule.name))].filter((name) => !reported.has(name)),
    ).toEqual([]);
  });

  it("第三方包装上之后（pnpm 的真实路径）同样命中", async () => {
    const rules = await loadRules();
    const pattern = (name: string): RegExp => {
      const rule = rules.find((candidate) => candidate.name === name);
      return new RegExp(rule?.to.path ?? "(?!)");
    };
    const pnpm = (store: string, pkg: string, file: string) =>
      `node_modules/.pnpm/${store}/node_modules/${pkg}/${file}`;

    for (const name of ["weapp-no-zod", "shared-no-zod"]) {
      expect(pattern(name).test(pnpm("zod@4.6.5", "zod", "index.js"))).toBe(true);
      expect(
        pattern(name).test(
          pnpm(
            "@hono+zod-openapi@1.6.3_hono@4.13.9_zod@4.6.5",
            "@hono/zod-openapi",
            "dist/index.js",
          ),
        ),
      ).toBe(true);
      // 名字以 zod 开头的别的包、把 zod 当对等依赖的别的包：不误报
      expect(pattern(name).test(pnpm("zod-to-x@1.0.0", "zod-to-x", "index.js"))).toBe(false);
      expect(pattern(name).test(pnpm("other@1.0.0_zod@4.6.5", "other", "index.js"))).toBe(false);
    }
    expect(pattern("shared-no-react").test(pnpm("react@18.3.1", "react", "index.js"))).toBe(true);
    expect(pattern("shared-no-react").test(pnpm("react-is@18.3.1", "react-is", "index.js"))).toBe(
      false,
    );
    expect(
      pattern("contract-no-react-prisma").test(
        pnpm("@prisma+client@7.10.0", "@prisma/client", "x.js"),
      ),
    ).toBe(true);
    expect(pattern("db-only-from-services").test(pnpm("pg@8.23.0", "pg", "lib/index.js"))).toBe(
      true,
    );
    expect(
      pattern("db-only-from-services").test(pnpm("pg-pool@3.0.0", "pg-pool", "index.js")),
    ).toBe(false);
  });
});

describe("第三方包的入口在 dist/ 下也拦得住", () => {
  // exclude 比的是解析后的路径。夹具里没有 node_modules，第三方包解析不了、留下的是包名，
  // 测不到“装上之后入口落在 dist/ 下”的情形：那时路径里带 /dist/，被排除构建产物的那一条滤掉过，
  // 以第三方包为终点的规则就看不见它。这里按 pnpm 的摆法在仓库外造一棵装好了的树来验。

  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  /**
   * 按 pnpm 的摆法装一个假包：实体在根的 node_modules/.pnpm/<store>/node_modules/<包>/，入口在 dist/ 下；
   * 声明它的工作区包下面放一个指过去的软链接。返回解析后的路径
   */
  function installFake(root: string, owner: string, pkg: string, store: string): string {
    const location = `node_modules/.pnpm/${store}/node_modules/${pkg}`;
    writeFiles(join(root, location), {
      "package.json": JSON.stringify({ name: pkg, version: "0.0.0", main: "dist/index.js" }),
      "dist/index.js": "export {};\n",
    });
    const link = join(root, owner, "node_modules", pkg);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(root, location), link, "dir");
    return `${location}/dist/index.js`;
  }

  async function loadExclude(): Promise<RegExp> {
    const loaded = (await import(pathToFileURL(configPath).href)) as {
      default: { options: { exclude: { path: string[] } } };
    };
    // dependency-cruiser 把数组里的几条用 | 接成一条正则
    return new RegExp(loaded.default.options.exclude.path.join("|"));
  }

  it("装好的树里，五条以第三方包为终点的规则各报出一条，终点都在 node_modules/…/dist/ 下", () => {
    const temp = makeTempDir("lyx-layers-dist-");
    cleanups.push(temp.cleanup);
    // 临时目录在 macOS 上是软链接；解析结果按真实路径算，起点也得是真实路径
    const root = realpathSync(temp.dir);

    writeFiles(root, {
      "apps/weapp/src/index.ts":
        'import "../../../packages/contract/src/index.js";\n\nexport {};\n',
      "apps/api/src/index.ts": 'import "pg";\n\nexport {};\n',
      "packages/contract/src/index.ts": 'import "./routes.js";\n\nexport {};\n',
      "packages/contract/src/routes.ts": 'import "@hono/zod-openapi";\n\nexport {};\n',
      "packages/contract/src/client.ts": 'import "@prisma/adapter-pg";\n\nexport {};\n',
      "packages/shared/src/index.ts": 'import "../../contract/src/index.js";\n\nexport {};\n',
      "packages/shared/src/view.ts": 'import "react";\n\nexport {};\n',
      // 对照：仓库自己的构建产物照旧不扫，这一条不该报出来
      "packages/contract/dist/index.js": 'import "react";\n\nexport {};\n',
    });
    const zodOpenapi = installFake(
      root,
      "packages/contract",
      "@hono/zod-openapi",
      "@hono+zod-openapi@1.6.3_hono@4.13.9_zod@4.6.5",
    );
    const adapter = installFake(
      root,
      "packages/contract",
      "@prisma/adapter-pg",
      "@prisma+adapter-pg@7.10.0",
    );
    const react = installFake(root, "packages/shared", "react", "react@18.3.1");
    const pg = installFake(root, "apps/api", "pg", "pg@8.23.0");

    const result = cruiseDir(root, ["apps", "packages"]);
    expect(result.violations, result.output).toEqual(
      [
        `contract-no-react-prisma: packages/contract/src/client.ts → ${adapter}`,
        `db-only-from-services: apps/api/src/index.ts → ${pg}`,
        `shared-no-react: packages/shared/src/view.ts → ${react}`,
        `shared-no-zod: packages/shared/src/index.ts → ${zodOpenapi}`,
        `weapp-no-zod: apps/weapp/src/index.ts → ${zodOpenapi}`,
      ].sort(),
    );
    expect(result.status, result.output).not.toBe(0);
    // 小程序没有直接引它：是经 contract 转了两手到的，报告里带出这条路
    expect(result.output).toContain("packages/contract/src/routes.ts");
  });

  it("本仓库：入口在 node_modules/…/dist/ 下的第三方包留在图里", () => {
    // 用例文件都引 vitest，它的入口在 dist/ 下。这条边在，说明真实安装下 exclude 没有把这类包滤掉
    const result = run(
      process.execPath,
      [depcruiseBin, "infra/ci/test", "--config", configPath, "--output-type", "json"],
      repoRoot,
    );
    expect(result.status, result.output).toBe(0);
    const graph = JSON.parse(result.stdout) as {
      modules: Array<{ dependencies: Array<{ module: string; resolved: string }> }>;
    };
    const intoDist = graph.modules
      .flatMap((module) => module.dependencies)
      .filter((dependency) => /(?:^|\/)node_modules\/.+\/dist\//.test(dependency.resolved));
    expect(intoDist.map((dependency) => dependency.module)).toContain("vitest");
  });

  it("exclude 只排除仓库自己的构建与覆盖率产物，不排除 node_modules 里的路径", async () => {
    const exclude = await loadExclude();
    const pnpm = (store: string, pkg: string, file: string) =>
      `node_modules/.pnpm/${store}/node_modules/${pkg}/${file}`;

    for (const path of [
      "dist/index.js",
      "packages/contract/dist/index.js",
      "apps/api/dist/main.js",
      "coverage/lcov-report/index.html",
      "packages/shared/coverage/lcov.info",
      "infra/ci/fixtures/layers/allowed/apps/api/src/index.ts",
    ]) {
      expect(exclude.test(path), path).toBe(true);
    }
    for (const path of [
      pnpm("@hono+zod-openapi@1.6.3_hono@4.13.9_zod@4.6.5", "@hono/zod-openapi", "dist/index.mjs"),
      pnpm("hono@4.13.9", "hono", "dist/index.js"),
      pnpm("@vitest+coverage-v8@4.1.11", "@vitest/coverage-v8", "dist/index.js"),
      // 没跟着软链接走到 .pnpm 时，路径是工作区包自己的 node_modules
      "packages/contract/node_modules/@hono/zod-openapi/dist/index.mjs",
      // 在夹具目录里跑时，仓库根的 node_modules 在起点之外
      `../../../../${pnpm("vitest@4.1.11", "vitest", "dist/index.d.ts")}`,
      // 名字里带 dist、coverage 的源码不是产物
      "packages/shared/src/dist.ts",
      "packages/services/src/reports/coverage.ts",
      "packages/contract/src/index.ts",
    ]) {
      expect(exclude.test(path), path).toBe(false);
    }
  });
});

describe("31 个模块已登记（验收第 7 条）", () => {
  interface Registry {
    servicesDir: string;
    layers: string[];
    modules: Record<string, string>;
    sameLayer: Record<string, { policy: string; allow?: Record<string, string[]>; note?: string }>;
    nonModuleDirs: string[];
  }

  const registry = JSON.parse(readFileSync(layersPath, "utf8")) as Registry;
  const moduleNames = Object.keys(registry.modules);

  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  /** 在仓库外造一个模块目录：登记表里的模块各一个目录，各带 index.ts */
  function makeServicesDir(): string {
    const temp = makeTempDir("lyx-layers-");
    cleanups.push(temp.cleanup);
    for (const name of moduleNames) {
      mkdirSync(join(temp.dir, name), { recursive: true });
      writeFileSync(join(temp.dir, name, "index.ts"), "export {};\n");
    }
    return temp.dir;
  }

  /** 改一份登记表放到仓库外，配上一个与之对应的模块目录，跑核对脚本 */
  function checkMutated(mutate: (draft: Registry) => void) {
    const draft = structuredClone(registry);
    mutate(draft);
    const temp = makeTempDir("lyx-layers-json-");
    cleanups.push(temp.cleanup);
    const file = join(temp.dir, "layers.json");
    writeFileSync(file, JSON.stringify(draft, null, 2));
    const servicesDir = join(temp.dir, "src");
    for (const name of Object.keys(draft.modules)) {
      mkdirSync(join(servicesDir, name), { recursive: true });
      writeFileSync(join(servicesDir, name, "index.ts"), "export {};\n");
    }
    return run(
      process.execPath,
      [checkLayersScript, "--layers", file, "--services-dir", servicesDir],
      repoRoot,
    );
  }

  it("登记表恰 31 个模块，层与 01 第 5 节一致", () => {
    const byLayer = Object.fromEntries(
      registry.layers.map((layer) => [
        layer,
        moduleNames.filter((name) => registry.modules[name] === layer),
      ]),
    );
    expect(byLayer).toEqual({
      L0: [
        "kernel",
        "events",
        "timers",
        "flow",
        "sla",
        "authz",
        "audit",
        "security",
        "config",
        "providers",
      ],
      L1: [
        "identity",
        "tenant",
        "profile",
        "staff",
        "approval",
        "content",
        "media",
        "notify",
        "docs",
        "portal",
      ],
      L2: ["billing"],
      L3: ["order", "ad", "delivery", "publish", "support"],
      L4: ["workbench", "reports", "analytics", "exports", "ops"],
    });
    expect(moduleNames).toHaveLength(31);
  });

  it("同层策略与白名单同 06 第 3.6 节、任务书 第 11 节第 4 项一致", () => {
    const policies = Object.fromEntries(
      registry.layers.map((layer) => [layer, registry.sameLayer[layer]?.policy]),
    );
    expect(policies).toEqual({
      L0: "free",
      L1: "whitelist",
      L2: "whitelist",
      L3: "whitelist",
      L4: "free",
    });
    expect(registry.sameLayer.L1?.allow).toEqual({
      identity: ["tenant", "approval", "docs", "notify", "media"],
      tenant: ["docs"],
      staff: ["approval", "media"],
      portal: ["identity"],
      profile: ["approval", "tenant", "media", "identity"],
      content: ["media"],
    });
    expect(registry.sameLayer.L2?.allow).toEqual({});
    expect(registry.sameLayer.L3?.allow).toEqual({
      order: ["ad", "delivery"],
      delivery: ["ad", "publish"],
    });
    expect(registry.nonModuleDirs).toEqual(["testing"]);
  });

  it("本仓库：登记表与 packages/services/src 下的目录一一对应", () => {
    const result = run(process.execPath, [checkLayersScript], repoRoot);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain("31 个模块（L0 10、L1 10、L2 1、L3 5、L4 5）");
  });

  it("目录与登记表一致时通过；非模块目录 testing 建不建都通过", () => {
    const dir = makeServicesDir();
    expect(run(process.execPath, [checkLayersScript, "--services-dir", dir], repoRoot).status).toBe(
      0,
    );
    mkdirSync(join(dir, "testing"));
    expect(run(process.execPath, [checkLayersScript, "--services-dir", dir], repoRoot).status).toBe(
      0,
    );
  });

  it("多一个未登记目录即失败，并指出是哪个", () => {
    const dir = makeServicesDir();
    mkdirSync(join(dir, "partner"));
    writeFileSync(join(dir, "partner", "index.ts"), "export {};\n");
    const result = run(process.execPath, [checkLayersScript, "--services-dir", dir], repoRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("partner：目录没有登记");
  });

  it("已登记的模块缺目录或缺 index.ts 即失败", () => {
    const dir = makeServicesDir();
    rmSync(join(dir, "billing"), { recursive: true });
    rmSync(join(dir, "order", "index.ts"));
    const result = run(process.execPath, [checkLayersScript, "--services-dir", dir], repoRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("模块 billing 已登记");
    expect(result.stderr).toContain("order：缺 index.ts");
  });

  it.each<[string, (draft: Registry) => void, string]>([
    ["模块的层没定义", (draft) => (draft.modules.partner = "L9"), "模块 partner 的层"],
    [
      "白名单指到别的层",
      (draft) => draft.sameLayer.L3?.allow?.order?.push("billing"),
      "L3 白名单 order → billing",
    ],
    [
      "白名单的起点没登记",
      (draft) => Object.assign(draft.sameLayer.L1?.allow ?? {}, { partner: ["media"] }),
      "L1 白名单的起点 partner",
    ],
    [
      "同层策略不认识",
      (draft) => Object.assign(draft.sameLayer.L4 ?? {}, { policy: "open" }),
      "L4 的同层策略",
    ],
    [
      "某一层没有同层策略",
      (draft) => {
        delete draft.sameLayer.L2;
      },
      "L2 没有同层策略",
    ],
    [
      "非模块目录与模块重名",
      (draft) => draft.nonModuleDirs.push("billing"),
      "billing 同时出现在 modules 与 nonModuleDirs 里",
    ],
  ])("登记表写坏了即失败：%s", (_label, mutate, message) => {
    const result = checkMutated(mutate);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("原样的登记表经同一条路径通过（上面的反例不是因为换了目录才失败）", () => {
    const result = checkMutated(() => undefined);
    expect(result.status, result.output).toBe(0);
  });

  it("不认识的参数按用法错误退出（退出码 2）", () => {
    const result = run(process.execPath, [checkLayersScript, "--fix"], repoRoot);
    expect(result.status).toBe(2);
  });
});
