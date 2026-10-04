# 依赖方向与分层的夹具

每个子目录是一棵小树，照仓库的样子摆 `apps/`、`packages/`，只放说明问题所需的几个文件。
`infra/ci/test/layers.test.ts` 进到夹具目录里跑 dependency-cruiser，用的是仓库根的 `.dependency-cruiser.cjs` 与 `infra/ci/layers.json`，逐条断言退出码与报出的规则名。
`pnpm depcheck` 不扫本目录（规则里已排除 `infra/ci/fixtures/`）。

写法上的四点：

- 夹具里没有 `node_modules`。跨包的引用写成相对路径时，解析结果与真实仓库里按包名引用相同（都落到 `packages/<包>/src/…`）；写成包名时解析不了，留下的是包名本身。两种写法规则都要拦，所以夹具里两种都有。
- 所以夹具测不到“第三方包装上之后”的情形：那时终点是 `node_modules` 下的真实路径，规则里排除哪些路径（`exclude`）也跟着起作用。这一段不放夹具（`node_modules`、`dist` 进不了版本库），由用例在仓库外的临时目录里按 pnpm 的摆法现造，见下面第二张表。
- 文件只写副作用导入（`import "…";`），免得被 lint 判成未使用。本目录不进任何 tsconfig，不做类型检查。
- 一个反例一个夹具。加规则时加一个夹具，并在用例的 `expected` 表里写上期望的违规；用例会核对“每个夹具都有用例、每条规则都有夹具报出过”。

| 夹具 | 摆了什么 | 期望 |
| --- | --- | --- |
| `cross-layer` | `billing`（L2）引 `order`（L3） | `layer-L2-no-upward` |
| `upward-each-layer` | L0、L1、L2、L3 各引一个更高层的模块 | 四条 `layer-L*-no-upward` |
| `upward-type-only` | `flow`（L0）用 `import type` 引 `order`（L3） | `layer-L0-no-upward` |
| `downward-ok` | 向下引、跨层向下引 | 通过 |
| `circular` | `events` 与 `audit`（同在 L0）互引 | `no-circular` |
| `same-layer-allowed` | L1、L3 白名单的全部 18 条；L0、L4 同层互引 | 通过 |
| `same-layer-denied` | `ad` 引 `order`；`tenant` 引 `identity`；`media` 引 `notify` | `layer-L3-same-layer-whitelist`、`layer-L1-same-layer-whitelist` |
| `module-internal` | 模块与包入口引别的模块 `index.ts` 以外的文件 | `module-public-api` |
| `providers-driver` | `billing` 引 `providers/index.ts`；`kernel` 引它不算 | `providers-via-types` |
| `unregistered-module` | 引一个没登记的模块目录 `partner` | `services-unregistered-module` |
| `fe-imports-db` | `apps/weapp` 引 `@liyoxi/db`（包名与路径两种写法） | `fe-no-server`、`db-only-from-services` |
| `fe-imports-services` | `apps/admin`、`apps/portal` 引 services | `fe-no-server` |
| `contract-imports-workspace` | contract 引 shared、services、config | `contract-is-leaf` |
| `contract-imports-react-prisma` | contract 引 `react`、`@prisma/client` | `contract-no-react-prisma` |
| `shared-imports-services-db` | shared 引 services、db | `shared-only-contract` |
| `shared-impure` | shared 的源码引 `node:fs`、`path`、`react`；测试文件引 `node:fs` 不算 | `shared-no-node`、`shared-no-react` |
| `shared-reaches-zod` | shared → contract 的入口 → `zod` | `shared-no-zod` |
| `weapp-reaches-zod` | `apps/weapp` 经两跳到 `zod` 与 `@hono/zod-openapi` | `weapp-no-zod` |
| `db-imports-shared` | db 引 shared | `db-only-contract` |
| `app-imports-db` | api、worker 引 `@liyoxi/db`、`@prisma/client`、`pg` | `db-only-from-services` |
| `package-imports-app` | services 引 `apps/api` | `packages-not-to-apps` |
| `app-imports-app` | worker 引 api、admin | `apps-not-to-apps` |
| `app-deep-imports-services` | api 绕过 services 的入口直接引模块 | `apps-via-services-entry` |
| `allowed` | 允许的方向全部走一遍：应用 → services → db / shared → contract，含 shared、小程序只引 contract 的纯常量文件 | 通过 |

不放夹具、由用例现造的（`layers.test.ts` 的“第三方包的入口在 dist/ 下也拦得住”一组）：

| 用例 | 摆了什么 | 期望 |
| --- | --- | --- |
| 装好的树 | 临时目录里按 pnpm 的摆法装四个假包（实体在 `node_modules/.pnpm/<包>@<版本>/node_modules/<包>/`，入口在 `dist/` 下，声明它的包下面放软链接）：`apps/weapp`、shared 经 contract 转两手到 `@hono/zod-openapi`；contract 引 `@prisma/adapter-pg`；shared 引 `react`；`apps/api` 引 `pg`。另放一个 `packages/contract/dist/` 下的文件作对照 | `weapp-no-zod`、`shared-no-zod`、`contract-no-react-prisma`、`shared-no-react`、`db-only-from-services` 各一条，终点都是 `node_modules/…/dist/index.js`；`dist/` 下那个文件不报 |
| 本仓库的图 | 对 `infra/ci/test` 出 JSON 报告（用例文件都引 `vitest`，它的入口在 `dist/` 下） | 图里有终点在 `node_modules/…/dist/` 下的 `vitest` |
| `exclude` 的正则 | 逐条比路径 | 仓库自己的 `dist/`、`coverage/` 与本目录命中；`node_modules` 里的 `dist/`、名字里带 `dist` 的源码不命中 |
