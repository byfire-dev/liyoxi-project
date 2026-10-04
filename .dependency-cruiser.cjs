// 狸有戏 · 依赖方向与分层规则。命令：pnpm depcheck。
// 依据：01 第 4.2、5 节；06 第 3.6 节；D7 第 2.2、2.3 节（D1、D2 按开发计划 第 4.2 节 Q4 改写）。
//
// 读法：
//   1. 包间方向只能是 应用 → services → db / shared → contract。
//   2. packages/services 的五层与同层白名单不写在这里：加载时读 infra/ci/layers.json 展开，不落生成文件。
//   3. 工作区包有两种写法都要拦：解析成功时是路径（packages/db/src/index.ts）；
//      包清单没声明、解析不了时留下的是包名（@liyoxi/db）。第三方包同理。
//   4. 只增规则随工作包 PR；删改已有规则只在单独的 gate-change PR 里做。
//
// 本文件是 CommonJS，而全仓 lint 禁 require()，所以内置模块用 process.getBuiltinModule 取。

const { readFileSync } = process.getBuiltinModule("node:fs");
const { join } = process.getBuiltinModule("node:path");

const registry = JSON.parse(readFileSync(join(__dirname, "infra/ci/layers.json"), "utf8"));

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 名字列表拼成一个分组；空列表拼成永不匹配 */
const oneOf = (names) => (names.length > 0 ? `(?:${names.map(escapeRe).join("|")})` : "(?!)");

const APPS = ["api", "worker", "weapp", "admin", "portal"];
const FRONTENDS = ["weapp", "admin", "portal"];

/** 工作区包：解析后的路径，或解析不了时留下的包名 */
const workspace = (dir, names) => `^${dir}/${oneOf(names)}/|^@liyoxi/${oneOf(names)}(?:/|$)`;
/** allowed 之外的全部工作区包 */
const workspaceExcept = (allowed) =>
  `^packages/(?!${oneOf(allowed)}/)|^apps/|^@liyoxi/(?!${oneOf(allowed)}(?:/|$))`;
/** 第三方包：node_modules 下的路径（pnpm 下前面还有 .pnpm 一段），或解析不了时留下的包名 */
const thirdParty = (names) => `(?:^|/)node_modules/${oneOf(names)}(?:/|$)|^${oneOf(names)}(?:/|$)`;

/** 带进 Zod 运行时的包：zod 本身，以及把它当运行时依赖的 @hono/zod-openapi */
const ZOD_RUNTIME = thirdParty(["zod", "@hono/zod-openapi"]);
/** 测试与脚本：不随包给到使用方（shared 的静态扫描用例要读源码文件，得用 node:fs） */
const NOT_SHIPPED = ["\\.(?:test|spec)\\.[cm]?[jt]sx?$", "/(?:test|scripts)/"];

/**
 * 仓库自己的构建与覆盖率产物：路径里有 dist、coverage 一段，且整条路径不经过 node_modules。
 * exclude 比的是解析后的路径，命中的模块连同指向它的依赖边一起从图里拿掉。
 * 第三方包的入口常在 dist/ 下（pnpm 下是 node_modules/.pnpm/<包>@<版本>/node_modules/<包>/dist/…），
 * 不带前面的否定就会把它们滤掉，以第三方包为终点的规则随之看不见这些包。
 */
const OWN_BUILD_OUTPUT = "^(?!.*(?:^|/)node_modules/).*(?:^|/)(?:dist|coverage)/";

// ---------- 包间方向（D1–D6、D10） ----------

const packageRules = [
  {
    name: "contract-is-leaf",
    comment: "D2（按 Q4 改写）：contract 不依赖任何工作区包",
    severity: "error",
    from: { path: "^packages/contract/" },
    to: { path: workspaceExcept(["contract"]) },
  },
  {
    name: "contract-no-react-prisma",
    comment: "D2：contract 不 import react、@prisma/*（02 第 5.4 节）",
    severity: "error",
    from: { path: "^packages/contract/" },
    to: { path: `${thirdParty(["react", "react-dom"])}|(?:^|/)node_modules/@prisma/|^@prisma/` },
  },
  {
    name: "shared-only-contract",
    comment: "D1（按 Q4 改写）：shared 的工作区依赖只许 contract；不引 db、services、应用",
    severity: "error",
    from: { path: "^packages/shared/" },
    to: { path: workspaceExcept(["shared", "contract"]) },
  },
  {
    name: "shared-no-node",
    comment: "D1：shared 的源码不 import Node 内置模块（小程序也要用它）。测试与脚本不算",
    severity: "error",
    from: { path: "^packages/shared/src/", pathNot: NOT_SHIPPED },
    to: { dependencyTypes: ["core"] },
  },
  {
    name: "shared-no-react",
    comment: "D1：shared 不依赖 React（02 第 5.4 节）",
    severity: "error",
    from: { path: "^packages/shared/" },
    to: { path: thirdParty(["react", "react-dom"]) },
  },
  {
    name: "shared-no-zod",
    comment: "Q4：shared 只引 contract 的纯常量子路径，经任何路径都到不了 Zod 运行时",
    severity: "error",
    from: { path: "^packages/shared/" },
    to: { path: ZOD_RUNTIME, reachable: true },
  },
  {
    name: "weapp-no-zod",
    comment: "D6、Q4：小程序不带进 Zod 运行时，经任何路径都到不了",
    severity: "error",
    from: { path: "^apps/weapp/" },
    to: { path: ZOD_RUNTIME, reachable: true },
  },
  {
    name: "db-only-contract",
    comment: "01 第 4.2 节：db 的工作区依赖只许 contract；db 与 shared 互不依赖",
    severity: "error",
    from: { path: "^packages/db/" },
    to: { path: workspaceExcept(["db", "contract"]) },
  },
  {
    name: "db-only-from-services",
    comment:
      "D3：数据包只被 services 引用。api、worker 先全禁；装配文件要引客户端工厂时走 gate-change（W0-02 任务书 第 11 节第 5 项）",
    severity: "error",
    from: { pathNot: "^packages/(?:services|db)/" },
    to: {
      path: `${workspace("packages", ["db"])}|${thirdParty(["@prisma/client", "pg"])}`,
    },
  },
  {
    name: "packages-not-to-apps",
    comment: "01 第 4.2 节：方向是 应用 → 包，包不反过来引应用",
    severity: "error",
    from: { path: "^packages/" },
    to: { path: workspace("apps", APPS) },
  },
  {
    name: "apps-not-to-apps",
    comment: "01 第 4.2 节：应用之间互不引用，共用的代码放 packages",
    severity: "error",
    from: { path: "^apps/([^/]+)/" },
    to: { path: workspace("apps", APPS), pathNot: "^apps/$1/" },
  },
  {
    name: "apps-via-services-entry",
    comment: "D4：api、worker 只经 @liyoxi/services 的公开入口拿业务能力",
    severity: "error",
    from: { path: "^apps/(?:api|worker)/" },
    to: {
      path: `^${registry.servicesDir}/`,
      pathNot: `^${registry.servicesDir}/(?:${oneOf(registry.nonModuleDirs)}/)?index\\.ts$`,
    },
  },
  {
    name: "fe-no-server",
    comment: "D5：三个前端不引 services、db",
    severity: "error",
    from: { path: `^apps/${oneOf(FRONTENDS)}/` },
    to: { path: workspace("packages", ["services", "db"]) },
  },
  {
    name: "no-circular",
    comment: "D10：无循环依赖。只在类型上成环也算",
    severity: "error",
    from: {},
    to: { circular: true },
  },
];

// ---------- packages/services 内部（D7、D8；01 第 5 节；06 第 3.6 节） ----------

const SERVICES = registry.servicesDir;
const moduleNames = Object.keys(registry.modules);
const modulesOf = (layer) => moduleNames.filter((name) => registry.modules[name] === layer);
const inModules = (names) => `^${SERVICES}/${oneOf(names)}/`;

for (const name of moduleNames) {
  if (!registry.layers.includes(registry.modules[name])) {
    throw new Error(`infra/ci/layers.json：模块 ${name} 的层 ${registry.modules[name]} 没有定义`);
  }
}

/** 同步调用只能向下：每一层不得引用比它高的层 */
const upwardRules = registry.layers.slice(0, -1).map((layer, index) => ({
  name: `layer-${layer}-no-upward`,
  comment: `01 第 5 节：${layer} 的模块不得引用更高层的模块；向上的影响走出站事件或端口`,
  severity: "error",
  from: { path: inModules(modulesOf(layer)) },
  to: { path: inModules(registry.layers.slice(index + 1).flatMap(modulesOf)) },
}));

/**
 * 同层策略是白名单的层：模块只能引白名单里列给它的同层模块。
 * 一个模块一条规则，同一层的规则同名。没有同层模块可拦的（如 L2 只有 billing）不出规则。
 * 策略是 free 的层不出规则，只受 no-circular 约束。
 */
const sameLayerRules = registry.layers
  .filter((layer) => registry.sameLayer[layer]?.policy === "whitelist")
  .flatMap((layer) => {
    const peers = modulesOf(layer);
    const allow = registry.sameLayer[layer].allow ?? {};
    return peers
      .map((name) => ({
        name,
        denied: peers.filter((peer) => peer !== name && !(allow[name] ?? []).includes(peer)),
      }))
      .filter(({ denied }) => denied.length > 0)
      .map(({ name, denied }) => ({
        name: `layer-${layer}-same-layer-whitelist`,
        comment: `06 第 3.6 节：${layer} 的同层调用只走 infra/ci/layers.json 的白名单`,
        severity: "error",
        from: { path: inModules([name]) },
        to: { path: inModules(denied) },
      }));
  });

/** 模块对外的入口：各自的 index.ts；providers 另开 types.ts 给领域模块（D8） */
const PUBLIC_ENTRIES = [`^${SERVICES}/[^/]+/index\\.ts$`, `^${SERVICES}/providers/types\\.ts$`];

const servicesRules = [
  ...upwardRules,
  ...sameLayerRules,
  {
    name: "module-public-api",
    comment: "D7：模块之间只能引对方的入口文件；引自己模块里的文件不限",
    severity: "error",
    from: { path: `^${SERVICES}/([^/]+)/` },
    to: { path: `^${SERVICES}/[^/]+/`, pathNot: [`^${SERVICES}/$1/`, ...PUBLIC_ENTRIES] },
  },
  {
    name: "module-public-api",
    comment: "D7：包入口（src 下直接放的文件）同样只能引各模块的入口文件",
    severity: "error",
    from: { path: `^${SERVICES}/[^/]+$` },
    to: { path: `^${SERVICES}/[^/]+/`, pathNot: PUBLIC_ENTRIES },
  },
  {
    name: "providers-via-types",
    comment: "D8：驱动实现只在装配处（kernel）被引用；领域模块只依赖 providers/types",
    severity: "error",
    from: {
      path: `^${SERVICES}/`,
      pathNot: `^${SERVICES}/${oneOf(["providers", "kernel", ...registry.nonModuleDirs])}/`,
    },
    to: { path: `^${SERVICES}/providers/`, pathNot: `^${SERVICES}/providers/types\\.ts$` },
  },
  {
    name: "services-unregistered-module",
    comment: "D7 第 2.3 节：新增模块先在 infra/ci/layers.json 登记层",
    severity: "error",
    from: {},
    to: {
      path: `^${SERVICES}/[^/]+/`,
      pathNot: inModules([...moduleNames, ...registry.nonModuleDirs]),
    },
  },
];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [...packageRules, ...servicesRules],
  options: {
    doNotFollow: { path: ["node_modules"] },
    // 反例夹具自成一棵树，由 infra/ci/test/layers.test.ts 逐个进去跑，不混进全仓的结果
    exclude: { path: ["^infra/ci/fixtures/", OWN_BUILD_OUTPUT] },
    // import type 也算依赖：下层不得在类型上依赖上层
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["main", "types", "typings"],
    },
  },
};
