import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, repoRoot, run } from "./helpers.js";

// 依赖方向与分层门禁的用例（W0-02 任务书 第 7 节第 3–7 条）。
// 反例是 infra/ci/fixtures/layers/ 下的小树，一个反例一个夹具；进到夹具目录里跑
// dependency-cruiser，用的是仓库根的那份规则，所以改规则不必改夹具。

const depcruiseBin = join(repoRoot, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");
const configPath = join(repoRoot, ".dependency-cruiser.cjs");
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

/** 对一个目录跑 dependency-cruiser，报告格式与 pnpm depcheck 相同 */
function cruiseDir(dir: string, targets: readonly string[]): CruiseResult {
  const result = run(process.execPath, [depcruiseBin, ...targets, "--config", configPath], dir);
  const output = result.output.replace(ANSI, "");
  const matches = [...output.matchAll(/^\s*error ([\w-]+): (\S+) → ?(\S*)$/gm)];
  const violations = matches.map(([, rule, from, to]) => `${rule}: ${from} → ${to}`).sort();
  const rules = [...new Set(matches.map(([, rule]) => rule ?? ""))].sort();
  return { status: result.status, violations, rules, output };
}

function cruise(fixture: string): CruiseResult {
  const dir = join(fixturesDir, fixture);
  const targets = ["apps", "packages"].filter((name) => existsSync(join(dir, name)));
  return cruiseDir(dir, targets);
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

function expectViolations(fixture: string): CruiseResult {
  const result = cruise(fixture);
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
