// 路由元数据接管的自测（任务书 W0-10 第 7 节第 1–3、6、7 条里不经命令行的那一半）。
// 与路线图的对账在 scripts/docs-check.ts（pnpm contract:docs-check）；这里另把它的几个比对函数各喂一个反例。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  GOLDEN_PATH,
  SOURCE_PATHS,
  c86OperationIds,
  diffGolden,
  diffRoutemap,
  diffStepUpSkip,
  openRoutes,
  stringifyGolden,
} from "../../scripts/docs-check.js";
import { PERMISSION_KEYS } from "../authz/index.js";
import { MILESTONES } from "../registry/define.js";

import {
  ContractRouteError,
  ROUTE_DOCS,
  ROUTE_PLACEMENTS,
  adminMeta,
  allMetaOnlyRoutes,
  allRegistryOnly,
  allRoutes,
  buildRouteCatalog,
  catalogResourcePathProblems,
  defineRouteDoc,
  defineRouteRegistry,
  hookMeta,
  isMetaOnlyRoute,
  merchantMeta,
  portalMeta,
  registryOnly,
  resourcePathProblems,
  routeCatalog,
  routeCatalogProblems,
  routeRegistryProblems,
  type RouteCatalogEntry,
  type RoutePlacement,
} from "./index.js";

const routesDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(routesDir, "../../../..");
const readRepo = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

const problemsOf = (build: () => unknown): string => {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractRouteError);
    return (error as ContractRouteError).problems.join("\n");
  }
  throw new Error("本该抛错，却登记成功了");
};

const count = <T>(items: readonly T[], test: (item: T) => boolean): number =>
  items.filter(test).length;

describe("只有元数据的登记形态", () => {
  it("补缺省值、补前缀，产出认得出来", () => {
    const entry = merchantMeta({
      method: "get",
      path: "/m/fixture-things",
      operationId: "m.fixtureThing.list",
      "x-clerk-view": "same",
    });
    expect(isMetaOnlyRoute(entry)).toBe(true);
    expect(entry).toMatchObject({
      metaOnly: true,
      path: "/api/v1/m/fixture-things",
      "x-auth": "member",
      "x-capability": null,
      "x-idempotent": "none",
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(isMetaOnlyRoute({ ...entry })).toBe(false);
  });

  it("把关与构造器是同一套：写路由要声明幂等方式，natural 要约束名，none 要理由", () => {
    const write = { method: "post", path: "/admin/fixture-things", "x-permission": null } as const;
    expect(
      // @ts-expect-error 写路由必须显式声明幂等方式
      problemsOf(() => adminMeta({ ...write, operationId: "admin.fixtureThing.create" })),
    ).toMatch(/写路由须声明 x-idempotent/);
    expect(
      problemsOf(() =>
        // @ts-expect-error natural 须同时写出约束名
        adminMeta({
          ...write,
          operationId: "admin.fixtureThing.create",
          "x-idempotent": "natural",
        }),
      ),
    ).toMatch(/natural 须同时写出 x-idempotent-by/);
    expect(
      problemsOf(() =>
        // @ts-expect-error none 须写理由
        adminMeta({ ...write, operationId: "admin.fixtureThing.create", "x-idempotent": "none" }),
      ),
    ).toMatch(/none 须写理由/);
  });

  it("组与鉴权对不上即拒绝；下载页须显式写 x-auth；回调固定 signed", () => {
    expect(
      problemsOf(() =>
        // @ts-expect-error staff 只在后台
        merchantMeta({ method: "get", path: "/m/x", operationId: "m.x.get", "x-auth": "staff" }),
      ),
    ).toMatch(/x-auth 须为/);
    const noAuth = { method: "get", path: "/portal/x", operationId: "portal.x.get" } as const;
    // @ts-expect-error 下载页没有缺省的 x-auth
    expect(problemsOf(() => portalMeta(noAuth))).toMatch(/x-auth 须为/);
    const hook = hookMeta({
      method: "post",
      path: "/hooks/fixture/events",
      operationId: "hooks.fixture.event.receive",
      "x-idempotent": "natural",
      "x-idempotent-by": ["uq_fixture"],
    });
    expect(hook["x-auth"]).toBe("signed");
  });

  it("权限点、能力点按类型只收登记过的键、assert-in-handler 与 null", () => {
    const base = { method: "get", path: "/admin/fixture-things" } as const;
    adminMeta({ ...base, operationId: "admin.fixtureThing.list", "x-permission": null });
    adminMeta({
      ...base,
      operationId: "admin.fixtureThing.list",
      "x-permission": "assert-in-handler",
    });
    adminMeta({
      ...base,
      operationId: "admin.fixtureThing.list",
      "x-permission": PERMISSION_KEYS[0] ?? null,
    });
    // @ts-expect-error 没登记的权限点过不了类型检查
    adminMeta({ ...base, operationId: "admin.fixtureThing.list", "x-permission": "nope.nope" });
    merchantMeta({
      method: "get",
      path: "/m/fixture-things",
      operationId: "m.fixtureThing.list",
      "x-clerk-view": "none",
      // @ts-expect-error 没登记的能力点过不了类型检查
      "x-capability": "nope.nope",
    });
  });
});

describe("文档目录与登记表", () => {
  const meta = merchantMeta({
    method: "get",
    path: "/m/fixture-things",
    operationId: "m.fixtureThing.list",
    "x-clerk-view": "same",
  });

  it("整个文件交进来按形态分拣；别的导出不管", () => {
    const doc = defineRouteDoc("m99-fixture", [{ meta, SomeSchema: { shape: {} }, LIMIT: 3 }]);
    expect(doc.group).toBe("m");
    expect(doc.metaOnly).toEqual([meta]);
    expect(doc.routes).toEqual([]);
    expect(doc.registryOnly).toEqual([]);
  });

  it("放错文档、绕开登记函数、探活放错地方都报错", () => {
    expect(problemsOf(() => defineRouteDoc("a99-fixture", [{ meta }]))).toMatch(/不属于 admin 组/);
    expect(
      problemsOf(() => defineRouteDoc("m99-fixture", [{ raw: { method: "get", path: "/m/x" } }])),
    ).toMatch(/长得像路由，却不是构造器或登记函数的产出/);
    const probe = registryOnly({ registryKey: "hooks.healthz.get", path: "/healthz" });
    expect(problemsOf(() => defineRouteDoc("m99-fixture", [{ probe }]))).toMatch(
      /只登记的探活只放在/,
    );
    expect(problemsOf(() => defineRouteDoc("fixture", []))).toMatch(/文档名须形如/);
  });

  it("三种形态一起查重：operationId、方法与路径", () => {
    const again = merchantMeta({
      method: "get",
      path: "/m/fixture-things",
      operationId: "m.fixtureThing.list",
      "x-clerk-view": "same",
    });
    expect(routeRegistryProblems([], [], [meta, again]).join("\n")).toMatch(
      /operationId 或登记键重复：m\.fixtureThing\.list[\s\S]*方法与路径重复/,
    );
    expect(routeRegistryProblems([], [], [{ ...meta }]).join("\n")).toMatch(
      /不是由 merchantMeta \/ adminMeta \/ portalMeta \/ hookMeta 登记的/,
    );
    expect(() => defineRouteRegistry({ routes: [], metaOnly: [meta, again] })).toThrow(
      ContractRouteError,
    );
  });

  it("资源文件都挂进了所在目录的 index.ts，文档目录都挂进了 docs.ts", () => {
    const docsFile = readFileSync(join(routesDir, "docs.ts"), "utf8");
    const dirs = readdirSync(routesDir).filter((name) =>
      statSync(join(routesDir, name)).isDirectory(),
    );
    expect(dirs.sort()).toEqual(ROUTE_DOCS.map((doc) => doc.doc).sort());
    for (const dir of dirs) {
      expect(docsFile, dir).toContain(`"./${dir}/index.js"`);
      const index = readFileSync(join(routesDir, dir, "index.ts"), "utf8");
      const files = readdirSync(join(routesDir, dir)).filter(
        (name) => name.endsWith(".ts") && name !== "index.ts" && !name.endsWith(".test.ts"),
      );
      for (const file of files) {
        expect(index, `${dir}/${file}`).toContain(`"./${file.replace(/\.ts$/, ".js")}"`);
      }
    }
  });
});

describe("路由清单（验收 1、3、6）", () => {
  it("条数：669 条，V1.0 613、V1.1 56；探活 5 条只登记；natural 15 条；四组 167、470、17、15", () => {
    expect(routeCatalog).toHaveLength(669);
    expect(allRoutes.length + allMetaOnlyRoutes.length + allRegistryOnly.length).toBe(669);
    expect(count(routeCatalog, (e) => e.version === "V1.0")).toBe(613);
    expect(count(routeCatalog, (e) => e.version === "V1.1")).toBe(56);
    expect(count(routeCatalog, (e) => e.registryKeyOnly === true)).toBe(5);
    expect(count(routeCatalog, (e) => e.xIdempotent === "natural")).toBe(15);
    const byGroup = (group: string) =>
      count(routeCatalog, (e) => e.operationId.startsWith(`${group}.`));
    expect([byGroup("m"), byGroup("admin"), byGroup("portal"), byGroup("hooks")]).toEqual([
      167, 470, 17, 15,
    ]);
    expect(ROUTE_DOCS).toHaveLength(19);
  });

  it("清单没有问题：都写了归属，权限点与能力点都在注册表里", () => {
    expect(routeCatalogProblems(routeCatalog, ROUTE_PLACEMENTS)).toEqual([]);
  });

  it("写路由都声明了幂等方式：none 有理由，natural 有约束名；GET 都是 none", () => {
    for (const entry of routeCatalog) {
      const id = entry.operationId;
      if (entry.method === "GET") expect(entry.xIdempotent, id).toBe("none");
      if (entry.xIdempotent === "natural")
        expect(entry.idempotentBy?.length, id).toBeGreaterThan(0);
      else expect(entry.idempotentBy, id).toBeNull();
      if (entry.xIdempotent === "none" && !entry.registryKeyOnly) {
        expect(entry.idempotentNote, id).toBeTruthy();
      }
    }
  });

  it("V1.0 的都有里程碑，V1.1 的没有；探活按任务书归到 M0、M4、M7", () => {
    for (const entry of routeCatalog) {
      if (entry.version === "V1.0")
        expect(MILESTONES, entry.operationId).toContain(entry.milestone);
      else expect(entry.milestone, entry.operationId).toBeNull();
    }
    const milestoneOf = (id: string) => routeCatalog.find((e) => e.operationId === id)?.milestone;
    expect(milestoneOf("hooks.healthz.get")).toBe("M0");
    expect(milestoneOf("hooks.readyz.get")).toBe("M0");
    expect(milestoneOf("hooks.health.get")).toBe("M0");
    expect(milestoneOf("hooks.internalHealth.finance.get")).toBe("M4");
    expect(milestoneOf("hooks.internalHealth.flow.get")).toBe("M7");
    expect(count(routeCatalog, (e) => e.milestone === "M0")).toBe(3);
  });

  it("清单的顺序与声明顺序无关：文档内按 operationId 排", () => {
    const reversed = ROUTE_DOCS.map((doc) => ({ ...doc, metaOnly: [...doc.metaOnly].reverse() }));
    expect(buildRouteCatalog(reversed, ROUTE_PLACEMENTS)).toEqual(routeCatalog);
  });

  it("反例：漏写归属、多写归属、权限点不在注册表里、skip 用在不是驳回的接口上", () => {
    const first = routeCatalog[0] as RouteCatalogEntry;
    const { [first.operationId]: _dropped, ...missing } = ROUTE_PLACEMENTS as Readonly<
      Record<string, RoutePlacement>
    >;
    expect(routeCatalogProblems(routeCatalog, missing).join("\n")).toMatch(
      new RegExp(`${first.operationId.replaceAll(".", "\\.")} 没有写归属`),
    );
    expect(
      routeCatalogProblems(routeCatalog, { ...ROUTE_PLACEMENTS, "m.nope.get": "M1" }).join("\n"),
    ).toMatch(/归属表里的 m\.nope\.get 不是登记过的路由/);
    const admin = routeCatalog.find(
      (e) => e.permission !== null && !/\.(reject|rejectReview)$/.test(e.operationId),
    ) as RouteCatalogEntry;
    const mutate = (patch: Partial<RouteCatalogEntry>) =>
      routeCatalogProblems(
        routeCatalog.map((e) => (e === admin ? { ...e, ...patch } : e)),
        ROUTE_PLACEMENTS,
      ).join("\n");
    expect(mutate({ permission: "nope.nope" })).toMatch(/权限点 nope\.nope 不在权限点注册表里/);
    expect(mutate({ xStepUp: "skip" })).toMatch(/不是驳回接口/);
    const merchant = routeCatalog.find((e) => e.capability !== null) as RouteCatalogEntry;
    expect(
      routeCatalogProblems(
        routeCatalog.map((e) => (e === merchant ? { ...e, capability: "nope.nope" } : e)),
        ROUTE_PLACEMENTS,
      ).join("\n"),
    ).toMatch(/能力点 nope\.nope 不在能力点注册表里/);
  });
});

describe("路径对着资源登记查（约定 C10；移交表第 19 行 ②）", () => {
  it("V1.0 的路由没有问题", () => {
    expect(catalogResourcePathProblems(routeCatalog)).toEqual([]);
  });

  it("反例：没登记的资源段、参数名不符、动作顶在组名后面；别名与回调的渠道名放行", () => {
    expect(resourcePathProblems("/admin/alerts/{alertId}/acknowledge")).toEqual([]);
    expect(resourcePathProblems("/m/me/change-phone")).toEqual([]);
    expect(resourcePathProblems("/m/store-profile/qualification/submit")).toEqual([]);
    expect(resourcePathProblems("/hooks/asr/media-jobs/{mediaJobId}")).toEqual([]);
    expect(resourcePathProblems("/hooks/wechatpay/transactions")).toEqual([]);
    expect(resourcePathProblems("/admin/alerts/{id}").join()).toMatch(/参数名登记为 \{alertId\}/);
    expect(resourcePathProblems("/admin/nope-things").join()).toMatch(/既不是登记过的资源/);
    expect(resourcePathProblems("/admin/alerts/nope/claim").join()).toMatch(/既不是登记过的资源/);
    expect(resourcePathProblems("/admin/auth/{authId}").join()).toMatch(/登记为不按 id 访问/);
  });
});

describe("与路线图、黄金文件、C86 登记表对账（验收 2、7）", () => {
  const routemap = JSON.parse(readRepo(SOURCE_PATHS.routemap)) as Record<string, unknown>[];
  const golden = readRepo(GOLDEN_PATH);

  it("逐字段 0 差异", () => {
    expect(diffRoutemap(routeCatalog, routemap)).toEqual([]);
  });

  it("反例：改一条的权限点、少一条、多一条，各报各的", () => {
    const target = routeCatalog.find((e) => e.permission !== null) as RouteCatalogEntry;
    const changed = routeCatalog.map((e) => (e === target ? { ...e, permission: "nope.nope" } : e));
    expect(diffRoutemap(changed, routemap)).toEqual([
      `${target.operationId} 的权限点：契约是 "nope.nope"，路线图是 ${JSON.stringify(target.permission)}`,
    ]);
    expect(diffRoutemap(routeCatalog.slice(1), routemap)).toEqual([
      `路线图有而契约没有：${routeCatalog[0]?.operationId}`,
    ]);
    expect(diffRoutemap(routeCatalog, routemap.slice(1)).join("\n")).toMatch(
      /^契约有而路线图没有：/,
    );
  });

  it("黄金文件与清单一致；提交的那份就是按清单写出来的", () => {
    expect(diffGolden(routeCatalog, golden)).toEqual([]);
    expect(golden).toBe(stringifyGolden(openRoutes(routeCatalog)));
    const lists = JSON.parse(golden) as Record<string, string[]>;
    expect(lists.public?.filter((line) => line.endsWith("（仅内网）"))).toEqual([
      "GET /internal/health/finance hooks.internalHealth.finance.get（仅内网）",
      "GET /internal/health/flow hooks.internalHealth.flow.get（仅内网）",
    ]);
  });

  it("反例：黄金文件少一条、多一条；路由悄悄改成 public", () => {
    const lists = JSON.parse(golden) as Record<string, string[]>;
    const dropped = lists.public?.[0] as string;
    const fewer = JSON.stringify({ ...lists, public: lists.public?.slice(1) });
    expect(diffGolden(routeCatalog, fewer)).toEqual([
      `黄金文件：public 路由不在黄金文件里：${dropped}（新增公开、可选、验签路由须评审）`,
    ]);
    const more = JSON.stringify({ ...lists, signed: [...(lists.signed ?? []), "POST /hooks/x y"] });
    expect(diffGolden(routeCatalog, more)).toEqual([
      "黄金文件：黄金文件有而契约没有的 signed 路由：POST /hooks/x y",
    ]);
    const member = routeCatalog.find((e) => e.xAuth === "member") as RouteCatalogEntry;
    const opened = routeCatalog.map((e) => (e === member ? { ...e, xAuth: "public" as const } : e));
    expect(diffGolden(opened, golden).join("\n")).toContain(member.operationId);
  });

  it("x-step-up: skip 与约定 C86 的登记表双向一致", () => {
    const registered = c86OperationIds(readRepo(SOURCE_PATHS.conventions));
    expect(diffStepUpSkip(routeCatalog, registered)).toEqual([]);
    expect(diffStepUpSkip(routeCatalog, registered.slice(1)).join("\n")).toMatch(
      /声明了 x-step-up: skip，但不在约定 C86 的登记表里/,
    );
    expect(diffStepUpSkip(routeCatalog, [...registered, "admin.nope.reject"]).join("\n")).toMatch(
      /登记表里有 admin\.nope\.reject，契约里它没有声明/,
    );
  });
});
