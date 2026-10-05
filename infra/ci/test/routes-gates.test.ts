import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, repoRoot, run, writeFiles } from "./helpers.js";

// 路由元数据接管带进来的三个脚本（W0-10 任务书 第 7 节第 4–6、8 条）：已落地判定与待落地清单、
// 计划 第 8.2 节的表、natural 幂等的约束名核对。都在仓库外的临时目录里造输入；约束名那一组只读迁移库。
// 用例里不写仓库现在的条数：数取自提交的路由清单，清单变了用例不用改。

const node = (script: string, args: readonly string[]) =>
  run("node", [join(repoRoot, "infra/ci", script), ...args], repoRoot);

interface Route {
  operationId: string;
  doc: string;
  method: string;
  path: string;
  summary: string;
  version: string;
  milestone: string | null;
  xIdempotent: string;
  idempotentBy: string[] | null;
}

const route = (operationId: string, patch: Partial<Route> = {}): Route => ({
  operationId,
  doc: "m01-account",
  method: "GET",
  path: "/m/fixtures",
  summary: "夹具",
  version: "V1.0",
  milestone: "M1",
  xIdempotent: "none",
  idempotentBy: null,
  ...patch,
});

const committed = JSON.parse(
  readFileSync(join(repoRoot, "packages/contract/generated/routes.json"), "utf8"),
) as Route[];

const temps: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of temps.splice(0)) cleanup();
});
function tempWith(files: Record<string, string>): string {
  const { dir, cleanup } = makeTempDir("lyx-routes-gates-");
  temps.push(cleanup);
  writeFiles(dir, files);
  return dir;
}

describe("landed.mjs：已落地判定与待落地清单", () => {
  const stub = (status: string, content: string) =>
    [
      "# 夹具留桩",
      "",
      "| 项 | 内容 |",
      "| --- | --- |",
      `| 状态 | ${status} |`,
      `| 留桩内容 | ${content} |`,
      "",
    ].join("\n");
  /** 四条 V1.0（a 三样齐全、b 没有测试、c 在留桩清单、d 什么都没有）加一条 V1.1 */
  function fixture(extra: Record<string, string> = {}): { dir: string; args: string[] } {
    const dir = tempWith({
      "routes.json": JSON.stringify([
        route("m.fixture.a", { milestone: "M0" }),
        route("m.fixture.b"),
        route("m.fixture.c"),
        route("m.fixture.d", { milestone: "M2" }),
        route("m.fixture.later", { version: "V1.1", milestone: null }),
      ]),
      "mounted.json": JSON.stringify([
        "m.fixture.a",
        "m.fixture.b",
        "m.fixture.c",
        "m.fixture.later",
      ]),
      "api/src/fixture.test.ts": `it("a", () => call("m.fixture.a"));\nit("c", () => call('m.fixture.c'));\n`,
      "api/node_modules/x/y.test.ts": `call("m.fixture.b");\n`,
      "stubs/README.md": "说明里提到 `m.fixture.a` 不算留桩\n",
      "stubs/m2-fixture-c.md": stub("留桩中", "接口 `m.fixture.c` 先返回空"),
      "stubs/m1-fixture-a.md": stub("已回补", "接口 `m.fixture.a`"),
      "baseline.txt": "# 说明\n4\n3\n",
      ...extra,
    });
    const args = ["routes", "mounted", "tests", "stubs", "baseline"].flatMap((name) => [
      `--${name}`,
      join(
        dir,
        {
          routes: "routes.json",
          mounted: "mounted.json",
          tests: "api",
          stubs: "stubs",
          baseline: "baseline.txt",
        }[name] as string,
      ),
    ]);
    return { dir, args };
  }

  it("三个条件都满足才算已落地；V1.1 不在清单里；清单按里程碑分组并写明还缺什么", () => {
    const { args } = fixture();
    const result = node("landed.mjs", ["--report", ...args]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("V1.0 接口 4 条：已落地 1，待落地 3；基线 3");
    expect(result.stdout).toContain(
      "| `m.fixture.b` | m01-account | GET `/m/fixtures` | 接口层测试 |",
    );
    expect(result.stdout).toContain(
      "| `m.fixture.c` | m01-account | GET `/m/fixtures` | 在留桩清单 |",
    );
    expect(result.stdout).toContain(
      "| `m.fixture.d` | m01-account | GET `/m/fixtures` | 处理器、接口层测试 |",
    );
    expect(result.stdout).toContain("## M1（待落地 2）");
    expect(result.stdout).not.toContain("m.fixture.a");
    expect(result.stdout).not.toContain("m.fixture.later");
  });

  it("--check：不超过基线通过，高于基线失败；已挂载清单不存在按空集算", () => {
    const { args } = fixture();
    const ok = node("landed.mjs", ["--check", ...args]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("待落地 3，已落地 1，基线 3");
    const { dir, args: lower } = fixture({ "baseline.txt": "4\n2\n" });
    const over = node("landed.mjs", ["--check", ...lower]);
    expect(over.status).toBe(1);
    expect(over.stderr).toContain("待落地数 3 高于基线 2：待落地数只减不增");
    const missing = lower.map((arg) =>
      arg === join(dir, "mounted.json") ? join(dir, "nope.json") : arg,
    );
    expect(node("landed.mjs", ["--check", ...missing]).stderr).toContain("待落地数 4 高于基线 2");
  });

  it("基线只能往下降：后一行大于前一行、不是数都算基线文件不合规", () => {
    const raised = node("landed.mjs", ["--check", ...fixture({ "baseline.txt": "3\n4\n" }).args]);
    expect(raised.status).toBe(1);
    expect(raised.stderr).toContain("基线只能往下降：第 2 个值 4 大于上一个 3");
    const junk = node("landed.mjs", ["--check", ...fixture({ "baseline.txt": "多\n" }).args]);
    expect(junk.status).toBe(1);
    expect(junk.stderr).toContain("不是非负整数");
  });

  it("--require：点名的里程碑还有待落地的即失败", () => {
    const { args } = fixture();
    expect(node("landed.mjs", ["--check", "--require", "M0", ...args]).status).toBe(0);
    const left = node("landed.mjs", ["--check", "--require", "M0,M2", ...args]);
    expect(left.status).toBe(1);
    expect(left.stderr).toContain("里程碑 M2 还有 1 条接口待落地：m.fixture.d");
  });

  it("仓库现状：V1.0 的接口都在清单里，V1.1 的不在；基线没有被超过", () => {
    const result = node("landed.mjs", ["--report", "--check"]);
    expect(result.status).toBe(0);
    const v1 = committed.filter((item) => item.version === "V1.0").length;
    expect(result.stdout).toContain(`V1.0 接口 ${v1} 条：`);
    const later = committed.find((item) => item.version !== "V1.0");
    if (later) expect(result.stdout).not.toContain(`\`${later.operationId}\``);
  });

  it("用法错误以 2 退出", () => {
    expect(node("landed.mjs", []).status).toBe(2);
    expect(node("landed.mjs", ["--check", "--nope", "x"]).status).toBe(2);
  });
});

describe("plan-routes.mjs：计划 第 8.2 节的表", () => {
  const plan = (rows: string[]) =>
    [
      "### 8.2 接口文档",
      "",
      "| 文档 | V1.0 | M0 | M1 | M2 |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
      "",
      "表后的正文。",
      "",
    ].join("\n");
  const routes = JSON.stringify([
    route("m.fixture.a", { milestone: "M0" }),
    route("m.fixture.b"),
    route("m.fixture.c"),
    route("admin.fixture.d", { doc: "a01-system", milestone: "M2" }),
    route("m.fixture.later", { version: "V1.1", milestone: null }),
  ]);
  const good = [
    "| [m01 账号](api/m01-account.md) | 3 | 1 | 2 | |",
    "| [a01 系统](api/a01-system.md) | 1 | | | 1 |",
    "| [x01 事件](api/x01-events-jobs.md) | — | 登记 | 随模块 | 随模块 |",
    "| 合计 | 4 | 1 | 2 | 1 |",
  ];
  const args = (dir: string) => [
    "--routes",
    join(dir, "routes.json"),
    "--plan",
    join(dir, "plan.md"),
  ];

  it("--check：一致即通过；数不对时逐行指出，--write 重写后再查通过，表外的正文不动", () => {
    const dir = tempWith({ "routes.json": routes, "plan.md": plan(good) });
    expect(node("plan-routes.mjs", ["--check", ...args(dir)]).status).toBe(0);

    const stale = good.map((line) => line.replace("| 3 | 1 | 2 | |", "| 3 | | 3 | |"));
    writeFiles(dir, { "plan.md": plan(stale) });
    const diff = node("plan-routes.mjs", ["--check", ...args(dir)]);
    expect(diff.status).toBe(1);
    expect(diff.stderr).toContain("计划 第 8.2 节的表与路由清单不一致");
    expect(diff.stderr).toContain("应当是：| [m01 账号](api/m01-account.md) | 3 | 1 | 2 | |");

    expect(node("plan-routes.mjs", ["--write", ...args(dir)]).status).toBe(0);
    expect(readFileSync(join(dir, "plan.md"), "utf8")).toBe(plan(good));
    expect(node("plan-routes.mjs", ["--check", ...args(dir)]).status).toBe(0);
  });

  it("V1.0 的接口没有里程碑即失败，也不重写", () => {
    const broken = JSON.stringify([route("m.fixture.a", { milestone: null })]);
    const dir = tempWith({ "routes.json": broken, "plan.md": plan(good) });
    const result = node("plan-routes.mjs", ["--write", ...args(dir)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("m.fixture.a 没有里程碑");
    expect(readFileSync(join(dir, "plan.md"), "utf8")).toBe(plan(good));
  });

  it("清单里新出现的文档补一行；--summary 出逐条的汇总", () => {
    const dir = tempWith({
      "routes.json": routes,
      "plan.md": plan(good.filter((line) => !line.includes("a01"))),
    });
    expect(
      node("plan-routes.mjs", ["--write", "--summary", join(dir, "summary.md"), ...args(dir)])
        .status,
    ).toBe(0);
    expect(readFileSync(join(dir, "plan.md"), "utf8")).toContain(
      "| [a01-system](api/a01-system.md) | 1 | | | 1 |",
    );
    const summary = readFileSync(join(dir, "summary.md"), "utf8");
    expect(summary).toContain("### m01-account · M1（2）");
    expect(summary).toContain("| `m.fixture.b` | GET `/m/fixtures` | 夹具 |");
    expect(summary).toContain("| `m.fixture.later` | m01-account | V1.1 |");
  });

  it("仓库现状：计划里的表与提交的路由清单一致", () => {
    const result = node("plan-routes.mjs", ["--check"]);
    expect(result.output).toContain("里程碑归属核对通过");
    expect(result.status).toBe(0);
  });
});

describe("natural-constraints.mjs：约束名核对（只读迁移库 lyx_migrate_check）", () => {
  it("提交的路由清单里，natural 路由写的约束名在库里都找得到", () => {
    const result = node("natural-constraints.mjs", []);
    expect(result.output).toContain("约束名核对通过");
    expect(result.status).toBe(0);
  });

  it("写错一个约束名、natural 没写约束名，各报各的", () => {
    const natural = committed.find((item) => item.xIdempotent === "natural") as Route;
    const dir = tempWith({
      "routes.json": JSON.stringify([
        { ...natural, idempotentBy: [...(natural.idempotentBy ?? []), "uq_lyx_fixture_nope"] },
        route("m.fixture.b", { method: "POST", xIdempotent: "natural", idempotentBy: null }),
      ]),
    });
    const result = node("natural-constraints.mjs", ["--routes", join(dir, "routes.json")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${natural.operationId} 写的约束 uq_lyx_fixture_nope 在库 lyx_migrate_check 里找不到`,
    );
    expect(result.stderr).toContain("m.fixture.b 是 natural，却没有写约束名");
    expect(result.stderr.match(/找不到/g)).toHaveLength(1);
  });

  it("库连不上或没有这个库：以 2 退出，不报通过", () => {
    const result = node("natural-constraints.mjs", ["--database", "lyx_fixture_no_such_db"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("没跑成");
  });
});
