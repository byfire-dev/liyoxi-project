# 「狸有戏」技术栈现状核实与选型建议（ext-stack）

- 查证日期：**2026-10-02**（下文所有"现状"均指这一天；版本号来自 npm registry `https://registry.npmjs.org/<包名>`，用 `npm view` 与 registry JSON 直接读取，另注明的除外）
- 读者：首席架构师；用途：供架构设计与 ADR 直接引用
- 标注约定：**【资料】**＝PRD / 原型 / 参考工程里明确写了的；**【核实】**＝今天在网上或 registry 查到的；**【推断】**＝我的判断，没有直接出处
- 参考工程：`timavia-liyo-project`（下称"参考工程"）

---

## 0. 结论速览

1. **基座沿用参考工程，只动三处**：ESLint 9 已于 2026-08-06 停止维护，新项目上 ESLint 10；运营后台是新的 PC Web 应用，用 React 19 + Vite 8 + Ant Design 6；Prisma 必须精确锁 7.10.0（`prisma@latest` 现在指向 8.0.0-rc.19）。
2. **TypeScript 留在 5.9.3**。TypeScript 7（Go 原生版）7 月已成为 `latest`，但 `openapi-typescript` 与 `typescript-eslint` 都还不支持，契约生成链路会直接崩。
3. **小程序继续 React 18**。Taro 4.3.0（三天前发布）与 NutUI React Taro 的 peer 依赖都还是 `react ^18`；仓库里会同时存在 React 18（小程序）与 React 19（后台），共享包必须不依赖 React。
4. **后台 UI 推荐 antd 6 + 自建 8 个左右业务构件，不引 ProComponents**。ProComponents 稳定线（2.8.10）只支持 antd 4/5，支持 antd 6 的 3.x 发了 30 多个预发布号仍未进 `latest`；antd 5 的一年维护期约在 2026-11 到期。备选是精确锁定 ProComponents 3.1.x（官方 Ant Design Pro v6 脚手架就是这么用的）。
5. **Node 24 在 2026-10-20 转入 Maintenance LTS，Node 26 在 2026-10-28 成为 LTS**。建议以 Node 24 开工，CI 加一条 Node 26 非阻塞任务，V1.0 上线前决定是否切换。
6. **电子签章**：V1.0 用"协议点击同意留痕 + 平台单方盖章的授权书 PDF + 哈希与验真页"在工程上够用，但它不是《电子签名法》第十三条的"可靠电子签名"；PRD 10.5 第 7 条写的是"双方签章"，原型写"正式授权书以双方签章版本为准"，这一条必须由法务拍板。
7. **电子发票**：V1.0 财务线下开票后上传文件合理；留好 `InvoiceProvider` 接口位与字段。原型里"电子发票发送至接收邮箱"意味着要新接一条发信通道，参考工程没有。
8. **埋点**：26 个事件、试点 1～2 个城市的量级，自建事件表 + 汇总表即可；We分析基础版免费、白拿平台流量数据。不需要独立数仓，不建议自托管 PostHog 或采购神策。
9. **可观测性**：微信要求 request 合法域名经过 ICP 备案，小程序无法直连 sentry.io，必须经自有域名转发（tunnel）或自建上报接口。
10. **PRD 要求可用性 99.9%、每日备份保留 30 天**，参考工程的单机 ECS + 容器内 PostgreSQL + 本地备份 14 天达不到，数据库建议用云托管 RDS。

---

## 1. 依赖版本现状与锁定建议

### 1.1 总表

| 依赖 | 参考工程 | 今天的最新稳定版 | 状态与要点 | 新项目建议 |
| --- | --- | --- | --- | --- |
| Node.js | 24（`engines >=24 <25`） | 24.21.0（LTS）；26.10.0（Current） | 24 于 **2026-10-20 转 Maintenance**、2028-04-30 EOL；26 于 **2026-10-28 成为 LTS**、2029-04-30 EOL；25 已 EOL；27 起改为一年一个大版本、个个都是 LTS | **24.x 开工**，`engines` 放宽到 `>=24 <27`，CI 加 Node 26 非阻塞任务；V1.0 上线前（26 进入 LTS 一两个月后）再决定是否切换 |
| pnpm | 10.30.0 | 12.8.1；11.28.2；10.34.6 | 12.0.0 于 2026-08-26 发布，是 Rust 重写版，保留 11 的命令与 lockfile 格式；11（2026-04）要求 Node 22+；10 线仍在发补丁（10.34.6，2026-09-28） | **10.34.x**，与参考工程同大版本；12 才发五周，三个月后再评估 |
| TypeScript | 5.9.3 | 7.0.2（2026-07-08，Go 原生版）；6.0.3（最后一个 JS 版） | `openapi-typescript@7.13.0` peer 为 `typescript ^5.x`，在 TS 7 下因 `ts.factory` 不存在而崩溃；`typescript-eslint@8.71.0` peer 为 `<6.1.0`，TS 7 支持请求被关闭 | **5.9.3**；等 openapi-typescript 支持后再升 6.0，TS 7 等编程接口稳定（预计 7.1）再议 |
| Taro | 4.2.1 | 4.3.0（2026-09-29） | 4.3.0 才发三天；peer 仍是 `react ^18`、`vite ^4` | **4.2.1**，等 4.3.x 出一两个补丁再跟 |
| React（小程序） | 18.3.1 | 19.3.0（2026-09-09） | Taro 官方发布版不支持 React 19（见 1.2） | **18.3.1** |
| React（后台） | — | 19.3.0 | antd 6 推荐 React 19；React Router 8 要求 ≥19.2.7 | **19.3.x** |
| NutUI React Taro | 3.0.20 | `latest` 标签＝**3.0.23-cpp**；非 cpp 稳定线最新＝3.0.20；4.0.0-beta.7 | `latest` 指向 `-cpp` 变体线（含义未在发布说明里解释）；peer `react ^16.8‖^17‖^18` | **精确锁 3.0.20**，禁止 `pnpm up --latest` |
| Zustand | 5.0.15 | 5.0.15 | 一致 | 5.0.15 |
| Hono | 4.13.5 | 4.13.12（2026-09-30） | 仍是 4.x | 4.13.x 最新补丁 |
| @hono/zod-openapi | 1.6.1 | 1.6.3 | — | 1.6.3 |
| @hono/node-server | 2.1.1 | 2.1.3 | — | 2.1.3 |
| Zod | 4.5.4 | 4.6.5（2026-09-13） | — | 4.6.x |
| Prisma | 7.10.0 | CLI `latest`＝**8.0.0-rc.19**；7.10.0 在 `prev` 标签；`@prisma/client` 的 `latest` 仍是 7.10.0 | Prisma 8 是候选版，官方称 GA 预计 2026-10；8 换了查询 API（`.take/.skip` 改 `.limit/.offset` 等）；7 在 8 GA 后还有 18 个月修复期 | **`prisma`、`@prisma/client`、`@prisma/adapter-pg` 全部精确锁 7.10.0**；依赖机器人禁掉 prisma 大版本 |
| PostgreSQL | 16（`postgres:16-alpine`） | 18.6；17.11；16.15；19 仍在 Beta 4（2026-09-24），GA 目标 10 月底 | 16 支持到 2028-11-09，18 支持到 2030-11-14；阿里云 RDS、腾讯云均已支持 18 | **18.x**（新库无迁移负担，支持期多两年）；要与参考工程共用运维脚本则 16.15。Prisma 7 官方支持矩阵今天没查到（文档页已换成 Prisma 8），需在 CI 用同版本验证 |
| Redis / Valkey | Redis 7（`redis:7-alpine`） | Redis 8.10.2；7.4.11；Valkey 9.1.2 | Redis 7.4 起是 RSALv2/SSPL，8.0 起加了 AGPLv3 选项；Valkey 是 BSD-3、Linux 基金会治理；BullMQ 兼容 Redis、Valkey | **Redis 7.4**（与参考工程一致）或云托管 Redis；自建且在意许可可换 Valkey 8.1/9.x |
| BullMQ | 6.3.4 | 6.3.11（2026-10-01） | 6.0.0（2026-07-30）移除了旧的 repeatable API，定时任务改用 Job Schedulers；`ioredis` 变成需显式安装的可选 peer；6 新增 PostgreSQL 后端（2026-09-27 才公告） | **6.3.x + Redis 后端**；PostgreSQL 后端太新，不采用 |
| ioredis | 6.0.0 | 6.0.0 | — | 6.0.0 |
| Vite | 小程序侧 `^4.5`（Taro 约束） | 8.3.2（2026-10-01，Rolldown） | `@vitejs/plugin-react@6` 要求 `vite ^8` | 后台 **8.3.x**；小程序保持 Taro 指定的 4.x |
| Vitest | 4.1.11 | 5.0.3（5.0.0 于 2026-09-03）；`V4` 标签＝4.1.11 | 5 要求 Vite ≥6.4、Node ≥22.12；默认每个用例前 `clearAllMocks`，漏 `await` 的异步断言直接失败 | **4.1.11** 开工（可直接移植参考工程的测试辅助）；5.1 之后升级 |
| Playwright | 未使用 | 1.63.0（2026-09-04） | — | 后台端到端测试用 1.63.x |
| ESLint | 9.39.5 | **10.11.0**；9.x 已于 **2026-08-06 EOL**，npm 上标了 deprecated | `typescript-eslint@8.71.0` 支持 ESLint 10；`eslint-plugin-react@7.37.5` 的 peer 不含 10；`eslint-plugin-react-hooks@7.1.1` 支持 10 | **10.11.x** + typescript-eslint 8.71 + react-hooks 7.1.1；`eslint-plugin-react` 换成 `@eslint-react/eslint-plugin` 或去掉 |
| tsup | 8.5.1 | 8.5.1（2025-11） | README 顶部写明不再积极维护，建议改用 tsdown（0.23.0，未到 1.0） | 先沿用 **tsup 8.5.1**，记一条技术债 |
| Sentry | `@sentry/node` 10.73.0 | 11.2.0（11.0.0 于 2026-09-23） | 11 才发九天；`sentry-miniapp@1.20.4` 已跟到 `@sentry/core` 11 | 接入时用 11.x；现在就接则 10.73.0 |
| Pino | 10.3.1 | 10.3.1 | — | 10.3.1 |
| jose | 6.2.10 | 6.2.12 | — | 6.2.x |
| openapi-typescript | 7.13.0 | 7.13.0（2026-02） | 见 TypeScript 一行 | 7.13.0 |
| PM2 | 使用中 | 7.0.4 | 许可证 AGPL-3.0（仅作进程管理工具使用不受影响） | 见 7.4：建议容器化后不再需要 |

出处（均 2026-10-02 查证）：
- Node 发布计划：<https://raw.githubusercontent.com/nodejs/Release/main/schedule.json>、<https://nodejs.org/en/about/previous-releases>、<https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule>
- pnpm 12：<https://www.infoq.com/news/2026/09/pnpm-12-rust/>、<https://github.com/pnpm/pnpm/releases/tag/v12.0.0>
- TypeScript 7 与工具链：<https://github.com/openapi-ts/openapi-typescript/issues/2841>、<https://github.com/typescript-eslint/typescript-eslint/issues?q=is%3Aissue+TypeScript+7+support>（#12518、#12720 关闭，#10940 仍开着）
- Taro：<https://github.com/NervJS/taro/releases>；NutUI：<https://github.com/jdf2e/nutui-react/releases>
- Prisma：<https://www.prisma.io/docs/orm/release-status>、<https://www.prisma.io/blog/prisma-next-roadmap>
- PostgreSQL：<https://www.postgresql.org/support/versioning/>、<https://layerbase.com/blog/when-will-postgres-19-be-released>；云厂商：<https://www.alibabacloud.com/en/news/product/rds-for-postgresql-supports-postgresql-18-mik>、<https://cloud.tencent.cn/announce/detail/2140>
- Redis / Valkey：<https://endoflife.date/api/redis.json>、<https://endoflife.date/api/valkey.json>、<https://www.phoronix.com/news/Redis-8.0-Goes-AGPLv3>
- BullMQ：<https://docs.bullmq.io/guide/migrations/migrate-from-v5-to-v6>、<https://bullmq.io/news/260927/bullmq-v6-postgresql/>（这两页今天直接抓取失败，内容取自搜索摘要；`bullmq@6.3.11` 的 `peerDependencies` 里确有可选的 `pg`，可互证）
- Vitest 5：<https://vitest.dev/blog/vitest-5.html>；ESLint：<https://eslint.org/version-support/>；tsup：<https://raw.githubusercontent.com/egoist/tsup/main/README.md>
- 参考工程版本：`package.json:7,9,40,49,51`、`apps/mobile/package.json:30,40,41,43,61`、`apps/api/package.json:19-37`、`packages/contract/package.json:32`、`packages/db/package.json:34`、`infra/compose.prod.yml:10,31`

### 1.2 Taro 对 React 19 的支持

- 【核实】`@tarojs/react@4.3.0`、`@tarojs/plugin-framework-react@4.3.0` 的 `peerDependencies` 都是 `react ^18`，`@tarojs/taro@4.3.0` 要求 `@types/react ^18`；4.3.0 的发布说明没有提到 React 19 或 Vite 5 以上。
- 【核实】NervJS/taro 仓库有一条 2026-08-07 由社区用户开的 issue #19468，标题是"Taro 已支持 Vite 8, React 19, Tailwind 4…"，状态 Open，看不到维护者回复，也没有对应的官方发布版本。<https://github.com/NervJS/taro/issues/19468>
- 【推断】这是社区方案或分支的宣告，不是官方已发布的能力。小程序侧按 React 18 设计，不要依赖 React 19 的新 API（`use`、Actions、`ref` 作为 prop 等）。
- 对仓库结构的影响：`apps/mobile` 用 React 18，`apps/admin` 用 React 19。pnpm 按包隔离依赖可以共存，但 **`packages/contract`、`packages/shared` 不能依赖 React 或 `@types/react`**，否则类型会互相污染。参考工程的依赖方向（`shared ← contract ← services ← api/worker`，`mobile` 只引生成的类型，见 `AGENTS.md` §2）正好满足这一点。

### 1.3 "保持一致"与"升级"的分类

| 类别 | 依赖 | 理由 |
| --- | --- | --- |
| 与参考工程保持一致 | TypeScript 5.9.3、Taro 4.2.1、React 18.3.1（小程序）、NutUI 3.0.20、Zustand 5.0.15、Prisma 7.10.0、ioredis 6.0.0、Pino 10.3.1、openapi-typescript 7.13.0、tsup 8.5.1、Vitest 4.1.11、pnpm 10.x、Node 24 | 工具链互相锁死（TS ↔ openapi-typescript ↔ typescript-eslint；Taro ↔ React 18 ↔ NutUI）；参考工程已在生产验证；可以直接搬工程脚手架、测试辅助与部署经验 |
| 同大版本内跟到最新补丁 | Hono 4.13.12、@hono/zod-openapi 1.6.3、@hono/node-server 2.1.3、Zod 4.6.5、BullMQ 6.3.11、jose 6.2.12、pg 8.23.1 | 无破坏性变更，拿安全与缺陷修复 |
| 必须不同 | ESLint 10（9 已 EOL）；后台 React 19 + Vite 8 + antd 6（新应用）；PostgreSQL 18（建议） | 见 1.1 |
| 暂不跟进 | TypeScript 6/7、pnpm 11/12、Vitest 5、Taro 4.3.0、Prisma 8、NutUI 4 beta、tsdown、Sentry 11（接入时再定） | 太新，或被工具链阻塞 |

---

## 2. 运营管理后台前端选型

### 2.1 需求画像

- 【资料】PC 网页端，Chrome、Edge 最新版，分辨率不低于 1366×768（PRD §10.1）；原型 56 个画板。
- 【资料】"所有列表支持筛选、分页和导出，关键操作记录日志"（PRD §7 开头）；权限按"菜单＋按钮＋数据范围"三级（PRD §3、§7.12）；敏感操作二次确认并经审批（PRD §3.3 第 3 条）。
- 【资料】原型里出现的交互：上线日历（`admin/Calendar.txt`）、Excel 导入与模板下载（`admin/DataEntry.txt:45,65`，V1.1）、Excel 导出（`admin/Orders.txt:206`、`admin/Reconcile.txt:105`）、证照原图与 OCR 结果并排核对（`admin/Review.txt:39,70`）、PDF/OFD 发票上传（`admin/Invoices.txt:178`）、趋势图（`admin/RptDelivery.txt:50`、`admin/RptService.txt:51`）、授权书 PDF 下载（`admin/OrderDetail.txt:119`）。原型文本里搜"上传"命中 20 个画板、"审批"18 个、"导出"15 个、"日历"9 个。
- 【推断】这是典型的中后台：服务端分页表格 + 筛选表单 + 详情页或侧滑面板 + 审批弹窗，没有大数据量前端表格、没有复杂可视化、没有甘特图或拖拽看板。

### 2.2 方案对比

| 方案 | 版本现状 | 优点 | 问题 | 结论 |
| --- | --- | --- | --- | --- |
| **A. React 19 + Vite 8 + antd 6 + 自建业务构件** | antd 6.6.5（6.0.0 于 2025-11-21）；React 19.3.0；Vite 8.3.2 | 依赖全是稳定版；团队熟 React；与参考工程"版式构件只从 `src/components` 取"的做法一致；契约类型直接复用 | 要自己写查询表格、筛选栏等基础构件，约一周 | **推荐** |
| B. 同上 + ProComponents 3.1.x | `@ant-design/pro-components` 的 `latest`＝2.8.10（2025-07，peer `antd ^4.24.15‖^5.11.2`）；`beta`＝3.1.15-3（peer `antd ^6`）；3.x 从 2025-07 到 2026-09 发了 30 多个预发布号 | ProTable/ProForm 省 CRUD 样板；官方 Ant Design Pro v6（2026-04-30）就是 antd 6 + pro-components `^3.1.14-2` | 3.x 至今没有进 `latest`，版本号形如 `3.1.15-3` 属预发布语义，范围匹配不可靠，必须精确锁定；发版频繁、无稳定承诺 | 备选：工期紧时采用，精确锁版本并经一层封装引入 |
| C. antd 5 + ProComponents 2.8.10 | antd 5.29.3（2025-12-18 后无新版） | 全稳定版 | antd 5 自 6.0 发布起只有一年维护期，约 2026-11 到期；React 19 需额外补丁包；ProComponents 2.x 一年多没发版 | 不推荐新项目采用 |
| D. Refine + antd | `@refinedev/core` 5.0.12；`@refinedev/antd` 6.0.3（2025-10）peer `antd ^5.23.0` | 资源、权限、数据提供者一揽子 | 不支持 antd 6（issue #7140 自 2025-12-02 开着、无维护者回复）；数据层约定与"Zod 契约 → OpenAPI → 类型"的自有链路重叠 | 不推荐 |
| E. Umi Max / Ant Design Pro v6 全家桶 | `@umijs/max` 4.7.22；脚手架已用 TypeScript ^7、Biome、utoopack | 开箱即用的布局、权限、请求 | 构建与约定体系和参考工程（Vite、ESLint、Vitest、TS 5.9）完全不同；脚手架用的 TS 7 与本项目契约工具链冲突 | 不推荐 |
| F. Vue 3 + Element Plus / Naive / Arco（vben 5、soybean） | Vue 3.5.43；Element Plus 2.14.7；Naive UI 2.45.3；Arco Vue 2.58.0（2026-04）；vben admin v5.7.0（2026-05-21）；soybean-admin v2.0.2 | 国内后台模板成熟，权限、多标签页、主题现成 | 团队主力是 React（小程序即 Taro React）；多一套框架、状态管理与组件范式；模板自带的请求与权限模型要改造才能接契约 | 不推荐 |

出处（2026-10-02）：<https://github.com/ant-design/ant-design/issues/55804>（antd 6 发布说明与 v5 一年维护期）；<https://raw.githubusercontent.com/ant-design/pro-components/master/package.json>（主干版本 3.1.15-3，peer antd ^6）；<https://github.com/ant-design/ant-design-pro/issues/11735>、<https://raw.githubusercontent.com/ant-design/ant-design-pro/master/package.json>；<https://github.com/refinedev/refine/issues/7140>；<https://github.com/vbenjs/vue-vben-admin/releases>、<https://github.com/soybeanjs/soybean-admin/releases>。

### 2.3 推荐栈（方案 A）

| 层 | 选型 | 版本 | 说明 |
| --- | --- | --- | --- |
| 框架与构建 | React + Vite + `@vitejs/plugin-react` | 19.3.x / 8.3.x / 6.1.x | 纯 SPA，静态产物放 nginx 或对象存储 + CDN |
| 组件库 | Ant Design + `@ant-design/icons` | 6.6.x / 6.3.x | 默认 CSS 变量主题；不再支持 IE |
| 路由 | **TanStack Router** | 1.170.x | 路径参数与查询参数全类型化，查询参数可用 Zod 校验，正适合"筛选条件进 URL"的列表页；备选 React Router 8.4（要求 React ≥19.2.7、Node ≥22.22，ESM-only） |
| 服务端状态 | TanStack Query + `openapi-fetch` + `openapi-react-query` | 5.104.x / 0.17.0 / 0.5.4 | 类型直接来自契约包生成的 `paths`；后台是 Web 打包环境，表单校验可以直接 import 契约里的 Zod schema（小程序只引类型） |
| 客户端状态 | Zustand | 5.0.15 | 只放登录态、权限、布局偏好；与小程序同库 |
| 表格 | antd `Table` + 自建 `QueryTable` | — | 服务端分页、排序、筛选、列显隐；不需要 AG Grid 或 TanStack Table |
| 表单 | antd `Form` + Zod | — | 提交前用契约 schema 校验 |
| 图表 | ECharts（按需引入）+ 自写薄封装 | 6.1.0 | 见 2.4 |
| 日历 | antd `Calendar` 自定义单元格 | — | 见 2.4 |
| 上传 | 对象存储直传（S3 分片 + 预签名）+ antd `Upload` 做界面 | — | 见 2.4 |
| 视频预览 | 原生 `<video>` + `hls.js`（需要 HLS 时） | 1.7.x | 见 2.4 |
| 权限 | 自有权限码 + 数据范围；前端 `<Can>` / `useCan` | — | 见 2.4 |
| 日期 | dayjs | 1.11.x | antd 6 内置依赖 |
| 测试 | Vitest + Testing Library；Playwright 端到端 | 4.1.11 / 16.3.x；1.63.x | — |
| 错误上报 | `@sentry/react` | 接入时定 | 见第 7 章 |

建议自建的业务构件（约 8 个，都放 `apps/admin/src/components`）：`QueryTable`（筛选栏 + 表格 + 分页 + URL 同步）、`FilterBar`、`DetailPanel`（详情页与侧滑面板共用）、`ConfirmAction`（二次确认 + 原因必填）、`ApprovalTimeline`（审批与操作日志时间线）、`UploadField`（图片、视频、PDF 直传）、`ExportButton`（发起导出任务并轮询下载）、`Can`（按钮级权限）。

### 2.4 逐项说明

**路由：TanStack Router 对 React Router 8**
- 【核实】React Router 8.0.0 于 2026-06-17 发布，ESM-only，最低 Node 22.22.0、React 19.2.7、Vite 7；8.4.0（2026-09-15）。TanStack Router 1.170.41（2026-09-30），peer React ≥18。<https://remix.run/blog/react-router-v8>、<https://www.infoq.com/news/2026/08/react-route-v8/>
- 【推断】后台 50 多页几乎都是"列表 + 筛选"，筛选条件、分页、当前标签页放进 URL 才能分享链接、刷新不丢。TanStack Router 的查询参数类型化 + Zod 校验能与契约里的查询 schema 复用同一份定义，这是选它的主要理由。团队更熟 React Router 的话，8.x 的 data 模式也可行，代价是查询参数要手工解析与校验。

**数据请求与契约衔接**
- 【资料】参考工程的链路是 Zod schema → `generated/openapi.json` → `openapi-typescript` 生成 `generated/types.d.ts`（`packages/contract/package.json:20`）。
- 【核实】`openapi-fetch@0.17.0`、`openapi-react-query@0.5.4`（peer `@tanstack/react-query ^5.80`、`openapi-fetch ^0.17`）与 `openapi-typescript@7.13.0` 同一天（2026-02-11）发布，是同一套工具。
- 【推断】后台直接用 `createClient<paths>()` + `$api.useQuery('get', '/admin/orders', { params })`，不需要 orval 或 hey-api 再生成一套客户端代码（两者同样被 TypeScript 7 阻塞，且会引入第二份生成物）。会话是 Cookie 方案的话，`openapi-fetch` 设 `credentials: 'include'` 并统一加防 CSRF 的自定义请求头（参考工程 ADR-063 的做法）。

**表格：antd Table 够用**
- 【核实】AG Grid 36.2.0；Community 版 MIT，但 Excel 导出、行分组与聚合、服务端行模型、主从表都在 Enterprise 版，约 999 美元/开发者（价格来自第三方页面）。<https://www.ag-grid.com/javascript-data-grid/community-vs-enterprise/>、<https://www.simple-table.com/blog/ag-grid-pricing-license-breakdown-2026>
- 【核实】`@tanstack/react-table` 9.2.4（9.0.0 于 2026-08-04），无界面，需自己写渲染。
- 【推断】本项目每页 10～50 行、服务端分页，导出走服务端（见 3.11），不存在前端十万行渲染。antd Table 的固定列、行选择、展开行、虚拟滚动已经覆盖需求。

**图表：ECharts 6**
- 【核实】`echarts@6.1.0`（2026-05-19，Apache-2.0）；`echarts-for-react@3.0.6` 支持 ECharts 6；`@ant-design/plots@2.6.8`、`@antv/g2@5.4.8` 最近一次发布在 2025-12 至 2026-01；`recharts@3.10.1`（2026-07-25）。
- 【资料】V1.0 报表只有经营概览与积分报表（PRD §7.10），其余 5 张在 V1.1。
- 【推断】图表类型不外乎折线、柱状、少量环形。ECharts 维护最活跃、中文文档全，按需引入后体积可控；自己写 30 行左右的 React 封装即可，不必依赖 `echarts-for-react`。若更看重与 antd 视觉统一，`@ant-design/plots` 也可以（Ant Design Pro 脚手架在用），但近九个月没发版。

**日历**
- 【资料】上线日历"按日展示待上线订单，支持按人员筛选"（PRD §7.7 第 2 条）。
- 【核实】`@fullcalendar/react@7.1.0`（2026-09-05），新增 peer `temporal-polyfill`；`react-big-calendar@1.20.0`。
- 【推断】月视图 + 单元格里列订单 + 点开当天清单，antd `Calendar` 的 `cellRender` 就能做。只有当需要周视图、资源泳道或拖拽改期时才上 FullCalendar（时间线与资源视图属于其付费插件，需另行确认许可）。

**Excel 导入导出：全部放服务端**
- 【核实】SheetJS：npm 上的 `xlsx` 停在 0.18.5（2022-03），带 CVE-2023-30533（原型污染，0.19.3 修复）与 CVE-2024-22363（正则拒绝服务，0.20.2 修复）；修复版只在 `https://cdn.sheetjs.com` 以 tarball 分发（0.20.3），许可证 Apache-2.0。<https://git.sheetjs.com/sheetjs/sheetjs/issues/2961>、<https://www.sentinelone.com/vulnerability-database/cve-2024-22363/>
- 【核实】ExcelJS：`exceljs@4.4.0`（2023-10）之后没有发版，主仓库自 2024-01 起无提交；出现多个社区分支（`@protobi/exceljs` 4.4.0-protobi.10、`exceljs-community` 5.2.0 等）。已知问题集中在**读取**不可信文件（解压放大、原型污染）与传递依赖告警。<https://github.com/exceljs/exceljs/discussions/2987>、<https://github.com/exceljs/exceljs/discussions/3008>
- 【核实】`write-excel-file@4.1.1`（2026-06，MIT，只写）；`csv-stringify@6.9.0`（2026-09）。
- 【推断与建议】
  - **导出**放服务端做（权限与数据范围只在服务端可信，且导出本身要记审计日志）。列表导出默认给 CSV（UTF-8 带 BOM，流式）；业务上必须 .xlsx 的（原型的对账明细写明 .xlsx，`admin/Reconcile.txt:105`）用只写库生成：`write-excel-file`，或 ExcelJS 的流式 `WorkbookWriter`（只走写路径，不解析外部文件）。本项目数据量是千到十万行级，两者都够。
  - **导入**（V1.1 的数据录入，`admin/DataEntry.txt:65`）要解析用户上传的文件，属于不可信输入：放 worker 里做，限制文件大小与行数；库用 SheetJS 官方 CDN 的 0.20.3 tarball（锁定完整性哈希），不要装 npm 上的 `xlsx@0.18.5`。
  - 社区分支（`exceljs-community` 等）今天没有核实维护者背景，采用前要做供应链评估。

**大文件上传**
- 【资料】图片单张 ≤5MB、超出先压缩；视频单个 ≤200MB、支持断点续传（PRD §10.1，针对商家端）。后台要上传每集原片、样片、成片（PRD §7.2、§7.6），体积可能远超 200MB【推断】。
- 【资料】参考工程用 S3 兼容接口（`@aws-sdk/client-s3`、`@aws-sdk/s3-presigned-post`，本地 MinIO、生产腾讯云 COS，见 `AGENTS.md:20`、`apps/api/package.json`）。
- 【核实】`@uppy/core@6.2.0`、`@uppy/aws-s3@6.2.2`（2026-09-30，支持 S3 分片）；`cos-js-sdk-v5@1.10.1`；`cos-wx-sdk-v5@1.8.0` 的 `uploadFile` 超过 `SliceSize` 自动走分块上传，分块上传默认支持断点续传。<https://cloud.tencent.com/document/product/436/31953>
- 【推断与建议】
  - 后台：浏览器直传对象存储，走 S3 分片上传（服务端提供"创建分片上传、签发各分片 URL、完成上传"三个接口），前端用 Uppy 的无界面模式或自写 200 行左右的分片逻辑，界面用 antd。这样与云厂商解耦，本地 MinIO 也能跑。
  - 小程序：小文件沿用参考工程的预签名 POST + `wx.uploadFile`；200MB 视频的断点续传有两条路：直接用 `cos-wx-sdk-v5`（绑定腾讯云，需要临时密钥），或自己用 `FileSystemManager` 分块读取 + `wx.request` PUT 到预签名分片地址（与厂商解耦，但要自己实现重试与续传，需真机验证内存占用）。这一点要在技术方案里单独验证。

**视频预览**
- 【资料】预告片与样片加水印，播放地址签名并设有效期，防盗链（PRD §10.2）；预告片多码率自适应、CDN 加速（PRD §10.1）。
- 【核实】`hls.js@1.7.3`、`xgplayer@3.0.26`（MIT）、`video.js@8.24.1`、`tcplayer.js@5.3.4`。
- 【推断】后台审片只需能播 MP4 与 HLS：Chrome、Edge 对 MP4 原生支持，HLS 用 `hls.js`。除非采用云点播的加密播放方案，否则不必引入整套播放器。

**权限：菜单 + 按钮 + 数据范围**
- 【资料】8 类内部角色 × 13 个模块，取值为查看、编辑、本人任务、无；数据范围为本人、本组（主管）、全部；角色权限可在后台配置（PRD §3.3、§7.12 第 2 条）。
- 【核实】`@casl/ability@7.0.1`、`@casl/react@7.0.1`、`@casl/prisma@2.0.2`（peer `@prisma/client` 支持到 ^7），均 2026-07-06 发布。
- 【推断与建议】权限模型用**自有权限码**（如 `order.refund.approve`）+ **数据范围枚举**，存库、可配置：
  - 服务端：路由层 `requirePermission(code)`；服务层统一的 `scopeFilter(ctx, resource)` 把"本人、本组、全部"翻译成 Prisma 的 `where` 条件。数据范围只在服务端强制。
  - 前端：登录后拿到权限码集合，菜单与路由按码过滤，按钮用 `<Can code="…">`。
  - CASL 的长处是带条件的规则，而本项目的角色矩阵本质是"码的集合 + 一个范围枚举"，引 CASL 收益不大；如果后续出现"仅可操作金额小于 X 的退款"这类条件规则再引入。

---

## 3. 后端周边库

### 3.1 二次验证（TOTP 与短信）

- 【资料】"后台安全：按角色授权；登录须二次验证；关键操作二次确认并记录日志"（PRD §10.2 第 4 条）。原型的短信模板"身份验证码"的触发时机写的是"更换手机号或后台登录二次验证时"（`admin/OpsTemplates.txt:127`）；创建员工时"初始密码通过短信发送，员工首次登录须修改密码并完成二次验证"（`admin/SysStaff.txt:182`）。**原型指向的第二因子是短信验证码，不是 TOTP。**
- 【资料】参考工程的后台是"邮箱 + 密码 + TOTP"，TOTP 自己实现（RFC 6238，测试向量钉在 `totp.test.ts`），不引 otplib；TOTP 密钥用 AES-256-GCM 可逆加密，恢复码 sha256、一次性；连错 5 次锁 15 分钟（`docs/02-architecture.md:161`，ADR-063）。
- 【核实】`otplib@13.5.0`（2026-08-21）：v13 是整体重写，取消了 `authenticator` 单例，容错窗口从"步数"改成"秒数"，从 v12 迁移时配错会让已绑定的验证器全部失效。`otpauth@9.5.2`（2026-09-03）。<https://github.com/yeojz/otplib/releases>
- 【建议】V1.0 按原型做"手机号 + 密码 + 短信验证码"（短信通道本来就要接），同时把参考工程的 TOTP 实现搬过来作为可选的第二因子，对超级管理员与财务强制启用 TOTP。需要库的话用 otplib 13，不要照着 v12 的教程写。短信作为第二因子有被转发、换卡的风险，这一取舍要架构师确认。

### 3.2 密码哈希

- 【资料】参考工程用 Node 自带的 scrypt，理由是不引原生依赖（ADR-063）。
- 【核实】Node 24.7.0 起 `node:crypto` 提供 `argon2()` / `argon2Sync()`，返回的是原始派生密钥，不是可直接存库的编码串，需要自己拼参数与盐；该接口的稳定性等级今天没有查到。`argon2@0.45.1`（原生模块，带预编译包）；`@node-rs/argon2@2.2.1`（napi 预编译）。<https://nodejs.org/docs/latest-v24.x/api/webcrypto.html>、<https://github.com/better-auth/better-auth/issues/6608>
- 【建议】沿用 scrypt（零依赖、已有实现与测试），存储格式带算法与参数前缀（如 `scrypt$N$r$p$salt$hash`），登录成功时发现参数过旧就重新哈希，将来换 argon2id 不用改表。若团队倾向 argon2id，用 `@node-rs/argon2`，并把它加进 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies`（参考工程 `pnpm-workspace.yaml:6`）。

### 3.3 会话管理

- 【资料】参考工程：后台会话放 Redis 而不是签名 JWT，目的是"怀疑泄漏时现在就踢下线"；Cookie 用 `__Host-` 前缀 + HttpOnly + SameSite=Strict；写操作另要自定义请求头防跨站；后台账号表与小程序用户表完全分开（ADR-063）。小程序用 JWT 访问令牌 + 刷新令牌（jose）。
- 【建议】照搬。本项目需要补的：
  - 角色或数据范围变更后，原型写"权限在员工下次刷新页面时生效"（`admin/SysStaff.txt:182`），所以权限要每次请求从会话或缓存里取，不能固化在令牌里。
  - 禁用员工、重置密码时立即作废该员工的全部会话。
  - 空闲超时与绝对超时；财务类操作（退款执行、积分调整审批）前要求近期重新验证（step-up）。
- 【核实】`better-auth@1.7.7` 等一体化方案存在，但它自带用户表与会话模型，与"两套身份互不提权"的既有设计重叠。【推断】不引入。

### 3.4 审计日志

- 【资料】操作日志记录改价、退款、套餐有效期调整、积分调整、归属变更、档案修改等关键操作，"建议保留不少于 3 年"（PRD §7.12 第 5 条）；代改档案要记修改前后内容（PRD §7.4 第 2 条）。参考工程有 `admin_audit_logs`，只增不改不删，不记密码与动态码（ADR-063）。
- 【建议的实现模式】
  - 一张只追加的表：操作人、角色、动作码、资源类型与 ID、修改前后（JSONB，只存差异）、原因、关联审批单、请求 ID、IP、UA、时间。
  - **与业务变更同一个数据库事务写入**（服务层提供 `audit()`，不放在中间件里做事后补记），保证"改了就一定有日志"。
  - 数据库层面给应用账号只授 INSERT、SELECT；敏感字段（手机号、证件号）脱敏后再入日志。
  - 按月分区便于三年后归档；需要更强的防篡改再加哈希链或定期把摘要写到对象存储。
  - 导出、下载成片包、查看证照原图这类"读"操作也记一条。

### 3.5 状态机

- 【资料】PRD 里的状态流转至少有：订购单、付款单、交付工单、广告制作任务、客服工单（含"3 天未确认自动解决"）、退款（先审批、再执行）、发票、资质审核、上线与下架任务（PRD §5.2、§5.3、§7.5～§7.9）。
- 【核实】`xstate@5.33.2`（2026-09-15）。
- 【建议】**手写**。每个实体一张类型化的转移表（当前状态 × 事件 → 下一状态、允许的角色、前置条件），放在 `packages/services`：
  - 落库用带条件的更新（`UPDATE … WHERE id = ? AND status = ?`，影响行数为 0 即并发冲突）。
  - 每次转移写一条状态历史（谁、何时、从哪到哪、原因），与审计日志同事务。
  - 副作用（发通知、扣积分、生成下游任务）在事务提交后入队。
- 【推断】XState 的强项是进程内的长生命周期 actor 与可视化；这里的状态都持久化在数据库、由 HTTP 请求和定时任务驱动，用 XState 等于多一层序列化与恢复的复杂度。转移表本身可以导出成图给产品核对。

### 3.6 定时与延迟任务

| 方案 | 版本 | 适用 | 问题 |
| --- | --- | --- | --- |
| **BullMQ Job Schedulers + delayed** | 6.3.11 | 定时（cron）、延迟、重试、限流、并发控制；参考工程已在用 | 入队与数据库事务不是一个原子操作 |
| pg-boss | 12.35.1（2026-09-30，Node ≥22.12） | 只用 PostgreSQL；入队可与业务写入同事务；自带 cron 与单例 | 团队没用过；本项目反正要 Redis（会话、限流） |
| node-cron / croner | 4.6.0 / 10.0.1 | 进程内定时 | 无持久化、无重试、多实例会重复执行 |
| BullMQ 6 的 PostgreSQL 后端 | 6.x | 想去掉 Redis | 2026-09-27 才公告，太新 |

- 【资料】本项目的定时需求：每月发放套餐积分、周期末清零、到期前多节点提醒（7/3/1 天，30/7/1 天）、每日下载微信支付账单对账、工单 3 天自动解决、30 分钟响应超时升级、约定上线日次日逾期提醒、使用期结束前 30 天生成下架任务、每月 1 日评定服务商等级（PRD §2.3、§7.7、§7.8、§7.9、§12.3）。
- 【建议】
  - BullMQ 6：周期任务用 `upsertJobScheduler`（v6 已删除旧的 `repeat` 选项，不能照 v5 的写法）。
  - **以数据库里的到期时间为准，定时扫描为主**：每个带时限的实体存 `due_at`，每分钟或每小时的扫描任务取出到期行、用带条件的更新抢占后处理。延迟任务只作加速手段，丢了也不影响正确性，Redis 数据丢失后可自愈。
  - 事务后入队的可靠性：业务事务里写一张 outbox 表，由 worker 轮询投递；或者干脆让"扫描到期行"承担这一职责。
  - worker 单实例（参考工程 `infra/ecosystem.config.cjs:28` 注明定时任务不可重复）；要多实例时扫描任务加 PostgreSQL 咨询锁。
  - Redis 配 `maxmemory-policy noeviction` 并开 AOF（参考工程 `infra/compose.prod.yml:36-37` 已开 `appendonly yes`）。
- 出处：<https://docs.bullmq.io/guide/migrations/migrate-from-v5-to-v6>、<https://www.pkgpulse.com/guides/bullmq-vs-bee-queue-vs-pg-boss-job-queues-nodejs-2026>

### 3.7 金额与积分的精确计算

- 【资料】金额有套餐月费、积分包价格、退款、返佣；积分有套餐积分、加购积分、冻结积分，以及折扣（订剧与广告折扣）、顶级模型加扣比例（默认 20%）、制作中取消的扣除比例；MRR 对季付、年付按月分摊（PRD §2、§7.3、§9.1）。
- 【核实】`decimal.js@10.6.0`、`big.js@7.0.1`、`dinero.js@2.0.2`（2026-03，2.x 已转正）。
- 【建议】
  - 金额一律存**整数分**（`BIGINT`），积分存**整数**；接口按字符串或整数传，不出现浮点数（参考工程已有"主键以 string 传输"的同类约定，`AGENTS.md` §3 第 4 条）。
  - 比例类参数存整数（万分比）或 `NUMERIC`，计算用整数乘除 + **明确的取整规则**。Prisma 的 `Decimal` 底层就是 decimal.js，不必另装。
  - 取整规则（折后积分、加扣积分、部分退回积分向上、向下还是四舍五入）PRD 没写，需要业务确认。
  - 分摊类计算（MRR、按月发放）用"最后一期补差"保证各期之和等于总额。
  - 积分账户用流水账（只追加）+ 余额快照，余额变更在同一事务内完成并可由流水重算；"优先扣快到期的积分"（PRD §12.1）意味着要按批次记到期日。

### 3.8 幂等键

- 【建议】
  - 写接口（提交订购、创建支付、执行退款、积分调整、确认收款）要求请求头 `Idempotency-Key`；服务端一张表以（调用方、键）唯一，存请求摘要与首次响应；同键不同参返回冲突。
  - 支付与退款回调以微信支付的交易号、退款单号做唯一约束。
  - 积分流水以（业务类型、业务单号、分录类型）唯一，保证重试不会重复扣发。
  - 小程序端按钮防抖只是体验层，正确性靠服务端。
  - 参考工程任务侧已有 `aiJobKey` 幂等的做法（`AGENTS.md` §3 第 5 条），思路一致。

### 3.9 分布式锁

- 【核实】`redlock` 的 npm 最新版是 5.0.0-beta.2（2022-03），多年没有更新。
- 【建议】
  - 余额类操作用**行锁**（事务内 `SELECT … FOR UPDATE` 锁积分账户行），这是主要手段。
  - 跨行的临界区（如同一经营主体并发提交订购、每日对账任务单例）用 **PostgreSQL 事务级咨询锁** `pg_advisory_xact_lock`，随事务自动释放，不存在锁过期与续期问题；Prisma 里在交互式事务中用 `$queryRaw` 调用。
  - Redis 锁（`SET NX PX` + 随机值校验释放）只用于非关键的去重（如防重复点击、通知节流），不用于资金与积分。不引 redlock。

### 3.10 工作日历

- 【资料】成片交付时长按工作日计、目标不超过 6 个工作日；资质审核时限 1 个工作日；新交付经理 1 个工作日内联系商家（PRD §9.1、§7.4）。
- 【核实】
  - `chinese-days@1.5.9`（2026-06，MIT）：提供 `isWorkday`、`isHoliday`、`isInLieu`、`findWorkday` 等，节假日数据覆盖 2004–2026；作者明确提醒国务院发布新一年安排后要手动升级依赖。<https://github.com/vsme/chinese-days>
  - NateScarlet/holiday-cn：每日抓取国务院公告，按年提供 JSON。`2026.json` 的出处是 <https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm>，含 2026-09-20、2026-10-10 两个调休上班日；**`2027.json` 今天还是空的**（国务院通常在 11 月前后公布次年安排）。<https://github.com/NateScarlet/holiday-cn>
  - npm 上名为 `holiday-cn` 的包停在 2017 年，与上面的仓库不是一回事，不要装错。
- 【建议】
  - 自建一张 `calendar_days` 表（日期、是否工作日、名称、来源），初始数据从 holiday-cn 的年度 JSON 或 chinese-days 导入；后台可人工修正。
  - 没有数据的年份默认"周一到周五上班"，并在每年 11–12 月由定时任务检查下一年数据是否就绪、未就绪则告警。
  - `addWorkdays`、`workdaysBetween` 放 `packages/shared`，时区固定 `Asia/Shanghai`，单元测试覆盖调休日（今天 2026-10-02 就在国庆假期内，是现成的用例）。

### 3.11 PDF 生成（《定制内容授权书》）

- 【资料】每笔订购按剧目与发布账号各生成 1 份；要素 7 项，含"双方签章"（PRD §10.5）；版权续期后授权期限顺延、可重新下载（`merchant/Contracts.txt:21`）。

| 方案 | 版本 | 优点 | 问题 |
| --- | --- | --- | --- |
| **@react-pdf/renderer** | 4.9.0（2026-08） | 用 React 组件写模板，团队上手快；纯 Node，不需要浏览器；可在 worker 里跑 | 中文要自己注册字体文件；复杂排版能力不如浏览器 |
| Puppeteer（HTML 转 PDF） | 25.12.0（Node ≥22.12） | 排版保真度最高，模板就是 HTML/CSS | 要带一个 Chromium（体积与内存大，国内下载要走镜像）；服务器要装中文字体 |
| pdf-lib | 1.17.1（2021-11 后无更新）；分支 `@cantoo/pdf-lib` 2.11.1（2026-09） | 轻；适合"在设计好的 PDF 模板上填字、贴章" | 原版已停更；中文要配 fontkit 嵌字体；自己算换行与分页 |
| pdfmake / PDFKit | 0.3.11 / 0.20.2 | 纯 JS | 声明式或命令式排版，都要自己处理中文字体 |
| Typst | `@myriaddreamin/typst-ts-node-compiler` 0.7.0 | 排版质量高、速度快、中文支持好 | 团队要学一门标记语言；Node 绑定是社区包 |

- 【建议】V1.0 用 **@react-pdf/renderer**，在 worker 队列里生成：
  - 模板带版本号，授权书记录模板版本、渲染入参快照与文件 SHA-256；
  - 嵌入开源中文字体（如思源黑体/宋体，SIL OFL 许可）。参考工程的生产机"没有任何中文系统字体"（`.github/workflows/ci.yml:68` 的注释），所以字体必须随仓库或镜像分发，不能指望系统字体；
  - 页脚放授权书编号与验真二维码（指向平台的验真页）；
  - 要加数字签名（PAdES）可用 `@signpdf/signpdf@3.3.0` + 平台的机构证书，或直接交给电子签平台（见第 4 章）。

### 3.12 导出大文件

- 【建议】
  - 小结果集（如 ≤5000 行）同步流式响应；更大的走**异步导出任务**：记录"谁、筛选条件、行数、文件键、过期时间"，worker 用键集分页（按主键游标）读库，`csv-stringify` 流式写出，经分片上传直接流到对象存储，完成后给签名下载链接并通知。
  - .xlsx 用 ExcelJS 的流式写入器或 `write-excel-file`（见 2.4）。
  - 防 CSV 公式注入：以 `=`、`+`、`-`、`@` 开头的单元格前加单引号；CSV 带 UTF-8 BOM 保证 Excel 直接打开不乱码。
  - 导出受数据范围约束、要记审计日志，手机号等敏感列默认脱敏。
  - 成片包"打包下载"（PRD §9.3 的 `package_download` 属性里有"按集或打包"）属于大文件：用流式 zip（`archiver@8.0.0` 或 `yazl`）在 worker 里预先打好放对象存储，不要在请求里现打。

---

## 4. 电子签章

### 4.1 四家平台

| 平台 | 接口能力（公开资料） | 计费（今天能查到的） | 备注 |
| --- | --- | --- | --- |
| 腾讯电子签 | 企业与个人实名、模板发起、多方签署、骑缝章、批量签；微信小程序内签署体验最顺；可集成进第三方应用 | **官方定价页今天未能直接抓到**。第三方页面称：标准版 1500 元/500 份、高级版 6000 元/1500 份（无 API）、专业版起才有 API（有称 13 万元/年，也有称"专业迷你版"4 万元/1 万份），按次单价 2～6 元。各页面互相不一致 | 价格与 API 版本门槛必须商务询价 |
| e签宝 | 开放平台 SaaS API：实名与意愿认证、模板、签署流程、存证与出证 | **官方报价页**：100 份 650 元、500 份 3000 元、1000 份 5500 元、2000 份 10000 元，有效期 1 年（即 5～6.5 元/份）；实名认证单价页面未列 | <https://www.esign.cn/site/quotation>、<https://open.esign.cn/prices> |
| 法大大 | 基础版、专业版、卓越版（含 API 集成）、旗舰版 | 官方价格页四档全部写"请联系商务经理"；第三方称 1～6 元/份 | <https://www.fadada.com/price> |
| 契约锁 | 偏私有化部署与大型组织的印章管控，也有公有云 API | 无公开价；第三方称 2～7 元/份 | 小团队 SaaS 场景不是其主战场【推断】 |

第三方价格出处（非官方，仅供量级参考，2026-10-02）：<https://tencentesign.com/blog/tencent-esign-pricing-2026>、<https://www.wanyuna.com/post/52.html>、<https://zhuanlan.zhihu.com/p/515091174>。

【推断】四家都提供企业实名、签署意愿认证（短信或人脸）、CA 数字证书、可信时间戳与存证报告，这正是"可靠电子签名"需要的要件；差别主要在微信生态内的体验（腾讯电子签占优）与价格门槛。

### 4.2 "印章图片 + PDF 落章 + 勾选留痕"的法律效力

- 【核实】《电子签名法》第十三条：电子签名同时满足四个条件才视为"可靠的电子签名"——制作数据专属于签名人、签署时仅由签名人控制、签署后对签名的改动能被发现、签署后对数据电文内容和形式的改动能被发现；第十四条：可靠的电子签名与手写签名或盖章具有同等法律效力。<https://www.cac.gov.cn/2004-08/28/c_126468489.htm>
- 【核实】律所与行业文章的一致看法：一张印章图片贴在 PDF 上不构成可靠电子签名，只能作为一般数据电文证据；法院会综合身份认证、签署过程、存储传输与完整性来认定，单纯的截图或未经认证的 PDF 容易被质疑。<https://www.allbrightlaw.com/SH/CN/10475/b04e085a2f9072f6.aspx>、<https://www.allbrightlaw.com/CN/10475/64cec076cbfe188a.aspx>
- 【推断】本项目有两类文件，要分开看：
  1. **点击同意类协议**（用户服务协议、会员服务协议、定制内容授权使用协议、广告制作与交付服务协议等，PRD §7.11 第 3 条）：记录协议版本、内容哈希、同意人、时间、IP、设备与关联单据，是互联网服务的通行做法，能证明合同成立与内容；原型已经按"首次签署、最近确认、关联单据、历史版本永久留存"设计（`merchant/Contracts.txt:22,64-76`）。
  2. **《定制内容授权书》**：实质是平台（授权方）向商家出具的授权证明，主要用途是商家在抖音、视频号遇到版权申诉时出示【推断】。平台单方盖章的 PDF 在这类场景通常可用，但证明力弱于可靠电子签名，对方可以质疑真伪。

### 4.3 V1.0 是否足够与建议

- **工程上够用，法律上有一个缺口要法务确认。**
- 【资料】PRD §10.5 第 7 条的要素是"双方签章"；原型两处写"正式授权书以双方签章版本为准"（`merchant/Contracts.txt:29`、`merchant/OrderDetail.txt:83`），后台下载时提示"授权方信息以双方签章版本为准"（`admin/OrderDetail.txt:119`）。也就是说，产品已经承认应用内生成的 PDF 不是"正式版"，但**没有任何页面或流程描述"双方签章版本"怎么产生**。这是 PRD 与原型的一个空白。
- 【建议】
  1. V1.0：点击同意留痕 + 平台单方盖章的授权书 PDF（哈希入库、带编号与验真页）。把授权书定位为"平台出具的授权证明"，双方合意由订购时同意的《定制内容授权使用协议》承载。**这需要法务认可，并把 PRD §10.5 第 7 条的"双方签章"改成与之一致的表述。**
  2. 架构上留 `SignatureProvider` 接口（驱动：`stamp` 本地盖章 / `tencent-ess` / `esign`…），授权书记录里预留"签署流程 ID、签署方、证书序列号、存证编号"字段。
  3. 若法务坚持双方签章：接腾讯电子签或 e签宝，每份 2～6.5 元，且每个商家要先在电子签平台完成企业实名（法人人脸或对公打款）。这对小商家是一道明显的转化门槛，个体工商户能否顺利完成企业认证也需验证。量级参考：一笔订购 2 部剧 × 2 个账号 = 4 份授权书。
  4. 折中：只让平台一方用机构数字证书对 PDF 做数字签名（平台在电子签平台做一次企业认证，单方签署），商家侧仍是点击同意。这样 PDF 防篡改、可验真，成本和转化影响都小。
  5. V1.1 服务商入驻"签署合作协议"（PRD §7.13 第 2 条）是 B2B 合同、金额大、频次低，适合直接上电子签平台。

---

## 5. 电子发票（数电发票）

### 5.1 现状

- 【核实】国家税务总局公告：自 2024-12-01 起在全国正式推广应用数电发票，与纸质发票具有同等法律效力；红冲需开具红字发票信息确认单。<https://www.chinatax.gov.cn/chinatax/n810219/n810780/c5236090/content.html>
- 【推断】通过电子税务局开具数电发票本身不收费；成本在人工。

### 5.2 开票接口服务商

| 服务商 | 能力（公开资料） | 接入成本（非官方） |
| --- | --- | --- |
| 诺诺（航信系） | 开放平台提供开票、查询、红字确认单等接口，SDK 多 | 有文章称 599 元/年/税号；另有评测称其数电票主要靠 RPA、暂不支持"乐企"直连——**未经官方证实** |
| 百望云 | 云端 API、状态回调；评测称已完成"乐企"对接 | 年费约 3000～8000 元 |
| 高灯 | 微信生态里做得多（微信发票助手等） | 月费 88 元起、按量阶梯 |
| 小型 API 商 | 一个税号一年一两百元起 | 资质与稳定性需自行评估 |

出处（均为第三方评测或营销文章，2026-10-02，**价格与能力以商务询价为准**）：<https://www.163.com/dy/article/KV2L8TJN0556MTTF.html>、<https://post.smzdm.com/p/ae6vgvdz/>、<https://blog.pospal.cn/kb/21845>。

### 5.3 V1.0 人工开票是否合理

- 【资料】V1.0 流程：商家按付款单申请 → 财务处理 → 电子发票上传后推送商家，纸质发票登记快递；抬头取认证主体、不可改；已开票的付款退款前须先开红字发票；积分订购不单独开票（PRD §7.9 第 4 条，`admin/Invoices.txt:43,106`）。
- 【推断】**合理**。只有付款单（套餐、积分包）才开票，试点期每月几十到几百张，财务在电子税务局手工开具完全可行；而且开票时点与项目名称还没定（PRD §12.3"发票与会计处理"待确认），过早自动化会把未定的规则写死。

### 5.4 需要注意的三点

1. **文件格式**：原型只允许"上传 PDF 或 OFD 文件"（`admin/Invoices.txt:178`）。数电发票还有 XML 格式，企业报销入账归档往往要 XML【推断，需财务确认】，建议上传支持 PDF、OFD、XML，一张发票可挂多个文件。
2. **邮件通道**：商家申请电子发票时必填"接收邮箱"（`merchant/Invoices.txt:40`），后台开具后"电子发票已推送商家，并发送至接收邮箱"（`admin/Invoices.txt:248`）。参考工程明确没有发信通道（ADR-063："liyo 没有发信通道"）。本项目要新接邮件推送服务（阿里云邮件推送或腾讯云 SES；`nodemailer@10.0.13` 可走 SMTP），或者把"发送至邮箱"从 V1.0 砍掉、只在小程序内下载——需要产品确认。
3. **红冲与退款的顺序**是状态机约束：已开票的付款单，退款单进入"执行"前必须存在已完成的红字发票记录。

### 5.5 自动化的接口位

- `InvoiceProvider` 接口：`issue`（开蓝票）、`query`、`requestRedConfirm`（红字确认单）、`issueRed`、`download(format)`，外加回调入口。V1.0 的驱动是 `manual`（财务上传即完成）。
- 发票表字段预留：发票类型（普票、专票）、介质（电子、纸质）、抬头、税号、地址电话、开户行账号、项目名称与税收分类编码、金额、税率、税额、发票号码（数电票 20 位）、开票日期、原发票号与红字确认单编号、文件键（pdf/ofd/xml）、服务商与服务商流水号、状态（待开票 → 开票中 → 已开具 / 失败 → 已红冲）、邮件投递状态。
- 开票申请与付款单一对一还是可合并开票，PRD 没写；原型按"付款单申请"，建议先一对一。

---

## 6. 数据埋点与分析

### 6.1 量级

- 【资料】26 个事件（PRD §9.3，逐行数过）；其中 `asset_adopted`、`points_expire` 标注为系统事件；漏斗 9 步，"成片交付、上线核验通过两个环节取后台状态数据"（PRD §9.2）；V1.0 先在 1～2 个城市做种子商家试点（PRD §11.2）。
- 【推断】用户是商家老板与店员，不是消费者。按数百到数千个经营主体估，日事件量在 10³～10⁵ 之间，年累计千万行以内，PostgreSQL 单表分区完全能承受。

### 6.2 方案对比

| 方案 | 成本 | 能力 | 问题 | 结论 |
| --- | --- | --- | --- | --- |
| **自建事件表 + 汇总 SQL** | 开发约 2～3 人日 | 事件与业务数据同库，可直接关联主体、套餐、订单；口径自己掌握 | 没有现成的可视化探索界面 | **主方案** |
| **We分析 基础版** | 免费 | 访问、来源场景值、留存、页面等平台级数据，无需开发；`wx.reportEvent` 自定义事件 | 基础版只支持事件分析、最多 10 个分析、自定义上报 5000 条/日；漏斗、留存、分布、路径要专业版 | **并行使用**（白拿平台流量数据） |
| We分析 专业版 | 按近一年日均打开次数计：<100 次 388 元/年，100～1000 次 688 元/年，1000～1 万次 1888 元/年（优惠价） | 全部分析模型，上报上限 5 万条/日 | 数据在微信侧，导出与业务库关联不便 | 可选，很便宜，可作为漏斗的交叉校验 |
| 友盟+ U-Mini | 免费 | 多平台小程序统计 | 数据给第三方；与业务库割裂 | 不需要 |
| 神策 / GrowingIO | 第三方称神策 SaaS 约 5 万元/年起，私有化 8～18 万元/年且要 16 核 64G 以上 | 完整的行为分析平台 | 对本项目量级过重 | 不采用 |
| PostHog 自托管 | 官方要求约 4 vCPU / 16GB，含 ClickHouse、Kafka 等多组件；自托管无官方支持 | 产品分析、漏斗、功能开关 | **没有官方微信小程序 SDK**（posthog-js issue #2223 仍是需求）；只能走 HTTP API，丢掉自动采集与会话 | 不采用 |

出处（2026-10-02）：<https://developers.weixin.qq.com/miniprogram/analysis/wedata/price>（We分析计费）；<https://developers.weixin.qq.com/miniprogram/analysis/wedata/DataManage.html>；<https://github.com/PostHog/posthog-js/issues/2223>；<https://posthog.com/docs/self-host>；<https://www.webfunny.com/blog/post/349>（神策价格，第三方）。

### 6.3 自建方案要点

- 表 `analytics_events`：事件名、发生时间、用户、角色、经营主体、门店、城市、品类、客户端版本（这些是 PRD §9.3 规定的公共属性）、会话 ID、属性（JSONB）、来源（客户端或服务端）；按月分区；（事件名、时间）与（经营主体、时间）索引。
- 采集：
  - 小程序端封装 `track()`：本地队列 + 批量上报（如每 10 条或页面隐藏时），失败重试，带客户端生成的事件 ID 去重。
  - **能在服务端产生的事件一律服务端记**：`plan_purchase`、`points_topup`（以支付回调为准）、`order_submit`、`asset_adopted`、`points_expire`、`member_join` 等，客户端上报只留纯行为类（`mall_view`、`trailer_play`、`share_click` 等）。这样漏斗的关键节点不受客户端丢报影响。
  - 接口限流、事件名与属性按契约里的 Zod schema 校验（26 个事件各一份 schema，放 `packages/contract`）。
- 隐私：埋点属性不放手机号、证照号等；在隐私政策里列明。

### 6.4 后台报表：直接查业务库

- 【资料】V1.0 报表两张：经营概览（收款额、付费主体数、新开通与续费、续费率、升级率、积分消耗、订购部数）、积分报表（积分负债、每月发放、消耗、清零与退回）；工作台有"今日数据"（PRD §7.10、§7.1）。指标口径仍待确认（PRD §12.3）。
- 【建议】
  - **不需要独立数仓**。用"按日汇总表 + 当日实时查询"：夜间任务把前一日的指标幂等地写入 `stat_daily_*`，报表读汇总表，"今日数据"直接查业务表。
  - 汇总表优于物化视图：Prisma 对物化视图没有一等支持（要在迁移里手写 SQL，与参考工程"不手写 SQL 改表"的规则有摩擦，`AGENTS.md` §3 第 9 条），而汇总表可增量、可重算、可按口径版本留痕。
  - **积分报表属于财务口径**（积分按预收款管理，消耗或清零时确认收入，PRD §7.9、§12.1），必须从积分流水账推导，并在月末固化一份快照，保证事后可复核、不随口径调整而漂移。
  - 报表查询量上来后先加只读副本；V1.1 七张报表全上、或要接 BI 工具时，再考虑把数据同步到分析库。

---

## 7. 可观测性与运维

### 7.1 错误监控

- 【资料】参考工程：`@sentry/node` 已集成，但"生产 `SENTRY_DSN` 还空着"，眼下只能看日志（`docs/08-deployment.md:165,342`）；小程序错误上报的决定是"评估 `sentry-miniapp`；不可用则自建 `POST /client-logs`"（ADR-016，`docs/02-architecture.md:114`）。
- 【核实】
  - `@sentry/node`、`@sentry/react` 11.2.0（2026-10-01）；`@sentry/hono` 11.2.0。
  - Sentry 官方没有微信小程序 SDK；社区的 `sentry-miniapp@1.20.4`（2026-09-20）活跃，基于 `@sentry/core`、已升到 11，支持微信等多端与 Taro。<https://github.com/lizhiyao/sentry-miniapp>
  - **微信小程序的 request 合法域名必须 HTTPS 且经过 ICP 备案**，每月可改 50 次。<https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html>
  - sentry.io 在国内访问慢且不稳；自托管 Sentry 最低 4 核 16GB + 16GB swap（实际常要 24～32GB），24.8 起有只收错误的精简模式。<https://develop.sentry.dev/self-hosted/>、<https://juejin.cn/post/7613237473860452361>
  - 国内替代：阿里云 ARMS 用户体验监控支持微信小程序与 Taro（npm 接入）；腾讯云前端性能监控 RUM 有小程序 SDK。<https://help.aliyun.com/zh/arms/user-experience-monitoring/access-mini-program-application>、<https://cloud.tencent.com/product/rum>
- 【推断与建议】
  - sentry.io 的接收域名没有 ICP 备案，**小程序不可能直连**。可行做法：`sentry-miniapp` 配 `tunnel` 指向自有 API 域名的转发接口，或自建 `/client-logs` 再由服务端转报。
  - api、worker、后台 Web 统一用 Sentry SDK，DSN 可配置（参考工程"未配置不崩溃"的规则适用）。后端先用 Sentry SaaS 起步最快；后台 Web 也走 tunnel，避免运营人员网络下丢报。
  - 上报前清洗：关闭默认的个人信息采集，过滤手机号、证件号、令牌；商家证照与法人身份证件属于敏感个人信息，错误上下文里不能带。数据出境的合规判断交法务；若不接受出境，改用阿里云 ARMS 或自托管。
  - 这次要把 DSN 真的配上：参考工程上线至今 DSN 为空，等于没有错误监控。

### 7.2 日志

- 【资料】参考工程：Pino 输出到 stdout，PM2 落文件，不建 Loki/Grafana（ADR-015）。
- 【建议】
  - Pino 10 结构化 JSON，带请求 ID、操作人 ID、经营主体 ID；用 Pino 的 `redact` 屏蔽手机号、证件号、令牌。
  - 采集到云日志服务（阿里云 SLS 或腾讯云 CLS，装采集器读容器 stdout），在日志服务里做检索与告警；不自建 ELK 或 Loki。
  - 运行日志保留 180 天以上（《网络安全法》要求网络日志留存不少于六个月【推断，按通行理解，具体由法务确认】）；业务操作日志在数据库里保留 3 年（PRD §7.12）。

### 7.3 指标、告警与探活

- 【资料】参考工程 `/health` 返回数据库、Redis 与 worker 心跳状态（ADR-064）；探活用 uptime-kuma 或云监控每分钟一次（`docs/08-deployment.md:341`）。
- 【建议】
  - 探活放在**机器外部**：云监控的站点监控或另一台机器上的 uptime-kuma，每分钟探 `/health`，判定条件含 `worker` 字段。
  - 业务侧关键指标先用日志与数据库查询 + 定时任务推告警，不上 Prometheus：队列积压与失败数、支付回调失败、对账差异、定时任务未按时完成、订阅消息与短信发送失败率。
  - 云资源指标（ECS、RDS、Redis 的 CPU、内存、磁盘、连接数）用云监控自带告警。
  - 告警发到企业微信群机器人（平台人员本来就用企业微信，PRD §7.4、§7.12）。
  - 【核实】npm 上 `prom-client@15.1.3` 被标了 deprecated（提示改用 `@prometheus-io/client`）；今天没有进一步核实新包，真要上 Prometheus 时再查。

### 7.4 部署形态

- 【资料】参考工程：阿里云 ECS 单机；PostgreSQL、Redis 用 Docker Compose 跑在本机；api、worker 用 PM2 跑宿主机 Node；全容器化推迟（ADR-010、ADR-022）；部署是在生产机上拉代码、装依赖、构建、迁移、重建进程（`infra/deploy.sh`）；备份是每日 04:00 `pg_dump` 到本机、保留 14 天（`docs/08-deployment.md:340`）。
- 【资料】本项目的硬要求：可用性不低于 99.9%；每日备份、保留 30 天；核心接口 P95 不超过 500 毫秒（PRD §10.1、§10.2）。

| 方案 | 适合 | 代价 |
| --- | --- | --- |
| **Docker Compose（1～2 台 ECS）+ 云托管数据库** | 小团队、两三个服务 | 没有自动扩缩与自愈编排；多机时要自己做滚动发布 |
| Kubernetes（ACK / TKE） | 多服务、要弹性、有专人运维 | 学习与运维成本高，小团队不划算 |
| Serverless 容器（阿里云 SAE、腾讯云云托管） | 想要多实例与滚动发布、又不想管集群 | worker 这类长驻进程与定时任务要确认计费与实例保活策略 |

- 【建议】
  1. **数据库用云托管 RDS PostgreSQL（高可用版）**：单机容器内的 PostgreSQL 做不到 99.9%，也没有时间点恢复；RDS 自带自动备份（设 30 天）与主备切换。Redis 可以云托管，也可以先自建（丢了可由数据库重建，前提是按 3.6 以数据库到期时间为准）。
  2. **应用从第一天就容器化**：多阶段 Dockerfile（`pnpm deploy --prod` 产出最小运行目录），api、worker、迁移三个镜像或同镜像不同入口；Compose 的重启策略取代 PM2。参考工程的事故记录（PM2 环境变量旧快照、在生产机上构建出半成品，`infra/deploy.sh` 头部注释）都源于"在生产机上构建 + PM2"，容器化后这类问题不存在。
  3. V1.0 先单机 Compose + RDS 也可以，但要明确写下这达不到 99.9% 的承诺，或者起两个 api 实例挂负载均衡。
  4. K8s 等到 V2.0 有自动化合成、AI 渲染等弹性负载时再评估。
  5. 若团队坚持与参考工程一致（PM2 + 宿主机 Node），也可行，代价是继续背那套部署脚本的复杂度。

### 7.5 CI/CD

- 【资料】参考工程 CI：GitHub Actions，带 PostgreSQL 16、Redis 7 服务容器，跑 Prisma 校验、迁移、lint、格式检查、类型检查、测试、契约漂移检查、构建（`.github/workflows/ci.yml`）；没有自动部署，生产机装依赖走国内镜像（`docs/08-deployment.md:27,198`）。
- 【核实】国内常见做法：GitHub Actions 构建镜像 → 推到阿里云 ACR 或腾讯云 TCR → SSH 到服务器执行拉取与重启；Docker Hub 在国内不可直接访问，基础镜像要同步到国内镜像仓库；也可在国内机器上跑自托管 runner。<https://zhuanlan.zhihu.com/p/1911727880951564207>、<https://juejin.cn/post/7646820023195566089>
- 【建议】
  - CI 沿用参考工程那套检查项，服务容器换成目标数据库版本；加后台 Web 的构建与 Playwright 冒烟。
  - CD：在 GitHub 托管 runner 上构建镜像并推 ACR；部署任务通过 SSH 在服务器上先跑迁移容器、再滚动重启 api 与 worker；服务器只从国内镜像仓库拉取，不访问 GitHub 与 Docker Hub。
  - 后台静态产物上传对象存储 + CDN，或打进 nginx 镜像。
  - 小程序上传用 `miniprogram-ci@2.1.31`。注意它的上传密钥默认要配 IP 白名单，而 GitHub 托管 runner 出口 IP 不固定：要么关掉白名单（降低安全性），要么在固定 IP 的自托管 runner 或服务器上执行上传。
  - 密钥放 GitHub Environments，生产部署加人工审批。

---

## 8. 技术风险与 PRD 冲突

1. **工具链互锁**：TypeScript、openapi-typescript、typescript-eslint 三者把 TS 锁在 5.9/6.0；Taro、NutUI 把小程序锁在 React 18、Vite 4。新项目里任何"顺手升到 latest"都会断链（`prisma`、`@nutui/nutui-react-taro`、`typescript` 的 `latest` 标签今天都指向不该装的版本）。必须全部精确锁版本，并给依赖机器人配忽略规则。
2. **ProComponents 无稳定版支持 antd 6**；antd 5 维护期约 2026-11 到期。选 antd 5 会立刻背上过期依赖，选 ProComponents 3 要接受预发布版。
3. **授权书"双方签章"**（PRD §10.5 第 7 条、原型多处）没有对应流程；V1.0 的印章图片方案不是可靠电子签名。
4. **可用性 99.9%、备份 30 天**与参考工程的单机部署、本地 14 天备份不匹配。
5. **小程序错误监控无法直连 Sentry**（合法域名须 ICP 备案）；参考工程生产至今没配 DSN。
6. **后台二次验证方式不一致**：原型是短信验证码，参考工程是 TOTP；短信作为第二因子强度较弱。
7. **电子发票要发邮件**，参考工程没有发信通道；原型只收 PDF、OFD，未考虑 XML。
8. **200MB 视频在小程序内断点续传**需要专门验证（分块读取的内存占用、与对象存储厂商的绑定程度）。
9. **2027 年节假日安排尚未公布**，工作日计算不能硬编码在依赖包里。
10. **ExcelJS 停更、npm 上的 SheetJS 带漏洞**：Excel 导入（V1.1）解析不可信文件时风险最高。
11. **BullMQ 入队与数据库事务不原子**：积分扣减后的下游任务若只靠入队，Redis 故障会丢任务；需按 3.6 用数据库到期时间兜底。
12. **取整规则未定义**：折扣、加扣比例、部分退回都会产生非整数积分。
13. **Node 24 即将进入维护期**（2026-10-20）；按 V1.0 的研发周期，上线时 Node 26 已是 Active LTS，需要提前安排一次切换验证。
14. **tsup 已不再积极维护**，参考工程仍在用；短期无碍，属于已知技术债。
15. **第 4、5 章的服务商价格大多来自第三方页面**，彼此矛盾，不能直接用于预算。

---

## 9. 需要拍板的问题

1. 后台 UI：采纳"antd 6 + 自建构件"，还是为了工期用预发布版 ProComponents 3？
2. 后台登录第二因子：短信（原型）、TOTP（参考工程），还是短信为默认、高权限角色强制 TOTP？
3. 《定制内容授权书》：平台单方盖章 + 协议点击同意是否满足法务要求？是否要求平台侧数字签名？是否必须双方电子签（接受每份 2～6.5 元与商家企业实名的门槛）？PRD §10.5 第 7 条是否修订？
4. 电子发票：V1.0 是否真的要"发送至接收邮箱"（需新接邮件服务）？上传格式是否加 XML？开票申请与付款单是否严格一对一？
5. 数据库与部署：是否用云托管 RDS？V1.0 是否接受单机（达不到 99.9%）？应用是否从第一天容器化（偏离参考工程的 PM2 方案）？
6. PostgreSQL 版本：18（建议）还是与参考工程一致的 16？
7. Node：以 24 上线，还是在 V1.0 上线前切到 26 LTS？
8. 错误监控：Sentry SaaS（数据出境需法务判断）、自托管，还是阿里云 ARMS？
9. 对象存储厂商：参考工程代码写的是腾讯云 COS，生产机在阿里云 ECS；本项目用哪家？这决定小程序大文件上传是用厂商 SDK 还是自写 S3 分片。
10. 积分与金额的取整规则（向上、向下、四舍五入）与 MRR 分摊的补差规则。
11. We分析专业版（每年几百到两千元）是否购买，用来交叉校验漏斗？
12. 路由库：TanStack Router（建议）还是团队更熟的 React Router 8？
13. Excel：列表导出默认 CSV 是否可接受，哪些报表必须 .xlsx？

---

## 附录 A：查证方法与局限

- 版本号、发布日期、peer 依赖、许可证、deprecated 标记：2026-10-02 直接读 npm registry（`npm view` 与 `https://registry.npmjs.org/<包名>`）。
- 生命周期：Node 读官方 `schedule.json`；PostgreSQL 读官方 versioning 页；Redis、Valkey 读 endoflife.date 的 API；ESLint 读官方 version-support 页。
- 未能直接核实、只有二手来源的：BullMQ v6 迁移指南与 PostgreSQL 后端公告原文（抓取失败，取自搜索摘要，另以包的 peer 依赖互证）；腾讯电子签、法大大、契约锁、诺诺、百望、高灯的价格（官方页无价或未抓到）；Prisma 7 对 PostgreSQL 18 的官方支持声明；Node `crypto.argon2` 的稳定性等级；NutUI `-cpp` 版本线的含义；Taro issue #19468 所述方案的归属。
- 没有做的事：没有安装或运行任何候选库；没有读取任何 `.env` 文件（只读了 `.env.example` 的变量名）；没有修改参考工程与资料目录。

## 附录 B：本次查询到的候选库版本（npm registry，2026-10-02）

| 用途 | 包 | 最新版（发布日期） | 许可证 / 备注 |
| --- | --- | --- | --- |
| 路由 | `@tanstack/react-router` | 1.170.41（2026-09-30） | MIT |
| 路由 | `react-router` | 8.4.0（2026-09-15） | MIT；peer react ≥19.2.7，Node ≥22.22 |
| 请求 | `@tanstack/react-query` | 5.104.0（2026-09-26） | MIT |
| 请求 | `openapi-fetch` / `openapi-react-query` | 0.17.0 / 0.5.4（2026-02-11） | MIT |
| 组件 | `antd` | 6.6.5（2026-09-20）；5 线停在 5.29.3 | MIT |
| 组件 | `@ant-design/pro-components` | latest 2.8.10（2025-07-17）；beta 3.1.15-3（2026-09-29） | MIT |
| 表格 | `ag-grid-community` | 36.2.0（2026-09-16） | MIT（企业功能另购） |
| 表格 | `@tanstack/react-table` | 9.2.4（2026-08-28） | MIT |
| 图表 | `echarts` | 6.1.0（2026-05-19） | Apache-2.0 |
| 图表 | `@ant-design/plots` / `@antv/g2` | 2.6.8（2025-12-24）/ 5.4.8（2026-01-06） | MIT |
| 图表 | `recharts` | 3.10.1（2026-07-25） | MIT |
| 日历 | `@fullcalendar/react` | 7.1.0（2026-09-05） | MIT（核心） |
| Excel | `exceljs` | 4.4.0（2023-10-19） | MIT；已停更 |
| Excel | `xlsx`（npm） | 0.18.5（2022-03-24） | Apache-2.0；有已知漏洞，修复版在官方 CDN |
| Excel | `write-excel-file` | 4.1.1（2026-06-08） | MIT；只写 |
| CSV | `csv-stringify` | 6.9.0（2026-09-25） | MIT |
| 上传 | `@uppy/core` / `@uppy/aws-s3` | 6.2.0 / 6.2.2（2026-09-30） | MIT |
| 上传 | `cos-js-sdk-v5` / `cos-wx-sdk-v5` | 1.10.1 / 1.8.0（2025-05） | ISC |
| 视频 | `hls.js` / `xgplayer` / `video.js` | 1.7.3 / 3.0.26 / 8.24.1 | Apache-2.0 / MIT / Apache-2.0 |
| 权限 | `@casl/ability` / `@casl/react` / `@casl/prisma` | 7.0.1 / 7.0.1 / 2.0.2（2026-07-06） | MIT |
| TOTP | `otplib` / `otpauth` | 13.5.0（2026-08-21）/ 9.5.2（2026-09-03） | MIT |
| 密码 | `argon2` / `@node-rs/argon2` | 0.45.1 / 2.2.1 | MIT |
| 状态机 | `xstate` | 5.33.2（2026-09-15） | MIT |
| 任务 | `bullmq` / `pg-boss` / `node-cron` | 6.3.11 / 12.35.1 / 4.6.0 | MIT / MIT / ISC |
| 精确计算 | `decimal.js` / `big.js` / `dinero.js` | 10.6.0 / 7.0.1 / 2.0.2 | MIT |
| 锁 | `redlock` | 5.0.0-beta.2（2022-03-06） | MIT；长期未更新 |
| 节假日 | `chinese-days` | 1.5.9（2026-06-02） | MIT；数据到 2026 |
| PDF | `@react-pdf/renderer` | 4.9.0（2026-08-27） | MIT |
| PDF | `puppeteer` | 25.12.0（2026-09-23） | Apache-2.0；Node ≥22.12 |
| PDF | `pdf-lib` / `@cantoo/pdf-lib` | 1.17.1（2021-11-06）/ 2.11.1（2026-09-15） | MIT |
| PDF | `pdfmake` / `pdfkit` | 0.3.11 / 0.20.2 | MIT |
| PDF 签名 | `@signpdf/signpdf` | 3.3.0（2025-12-29） | MIT |
| 监控 | `@sentry/node` / `@sentry/react` | 11.2.0（2026-10-01） | MIT |
| 监控 | `sentry-miniapp` | 1.20.4（2026-09-20） | MIT；社区维护 |
| 日志 | `pino` | 10.3.1（2026-02-09） | MIT |
| 质量 | `eslint` / `typescript-eslint` | 10.11.0 / 8.71.0 | MIT |
| 质量 | `@biomejs/biome` / `oxlint` | 2.5.15 / 1.86.0 | 备选，未采用 |
| 测试 | `vitest` / `@playwright/test` | 5.0.3（V4 线 4.1.11）/ 1.63.0 | MIT / Apache-2.0 |
| 小程序 CI | `miniprogram-ci` | 2.1.31（2026-03-12） | MIT |
| 后台框架（未采用） | `@refinedev/antd` | 6.0.3（2025-10-23）；peer antd ^5.23 | MIT |
| 后台框架（未采用） | `vue` / `element-plus` / `naive-ui` / `@arco-design/web-vue` | 3.5.43 / 2.14.7 / 2.45.3 / 2.58.0 | MIT |
