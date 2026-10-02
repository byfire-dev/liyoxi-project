# 参考工程 timavia-liyo-project 后端与整体架构调研报告

| 项 | 内容 |
| --- | --- |
| 调研对象 | `timavia-liyo-project`（下称「参考工程」，产品名同为「狸有戏」，定位是「AI IP 操盘手」） |
| 调研日期 | 2026-10-02 |
| 代码基线 | `git log` 最新提交 `f1361e3`（2026-09-26）；全仓 383 个提交、约 110 个 PR，时间跨度 2026-09-02 ～ 2026-09-26 |
| 目的 | 判断新产品「狸有戏 · 短剧营销工具」（商家端小程序 + PC 运营后台）可以沿用什么、必须改什么 |
| 方法 | 只读：逐条读 docs/00、02（全部 ADR）、03、04、06、08 相关段、AGENTS.md、README.md；核对 apps/api、apps/worker、packages/*、infra、根配置；`git log --oneline` |
| 约定 | 「【资料】」= 文档或代码里明确写了的，附出处；「【推断】」= 本报告的判断。路径均相对参考工程根目录，`文件:行号` 以 `f1361e3` 为准 |

---

## 0. 结论速览

1. **工程骨架可以整体沿用**：pnpm monorepo + 全仓 ESM + TS strict；Hono 4 + `@hono/zod-openapi` 契约先行；`packages/services` 作为业务逻辑唯一落点；`ServiceContext` 一处装配；Provider 抽象「未配置不崩溃」；BullMQ 分队列 + `jobs` 表记产品可见状态 + 补偿扫描；presign/confirm 直传；Pino + Sentry + `/health` + worker 心跳；Vitest 分层 + 真库集成测试；CI 六道门禁。这些在参考工程里都是跑过生产、踩过坑、有测试钉住的。
2. **领域能力要大面积新建**：参考工程**没有**微信支付、**没有**积分账本（只有一个写死的常量 `LIYO_POINTS_GRANT = 8000`）、**没有**金额类型列、**没有** RBAC、**没有**审批流、**没有**导出与报表、**没有**私有桶签名下载与分片上传、**没有**前端 Web 工程。新产品 PRD 第 2、3、7 章的主体都落在这些空白上。
3. **管理后台不能沿用形态，只能沿用安全模型**：ADR-063 的后台是一个 284 行的 HTML 字符串 + 12 条接口，三个面板，所有账号权限相同，账号靠 CLI 建。它是为「闭测期两件日常」设计的，不是为 56 个画板、8 类岗位、菜单/按钮/数据范围三级权限设计的。
4. **多租户模型要从单层改成两层**：参考工程是 `ip → ip_members(role 线性四级)`；新产品是「经营主体 → 门店 → 成员」，套餐/积分/合同/发票挂主体，订单/工单/素材/发布账号挂门店（PRD 6.16.1）。
5. **参考工程的「素材（expressions）」域与新产品的「门店素材」高度同构**（PRD 6.16.3：图片、视频、录音、音频、文档、文字六类，上传后自动转写、识别、打标签），ADR-032～050 的上传登记表、ASR、视觉理解、封面抽帧这一整套可以调整后复用——这是调研里最大的一块「意外可复用资产」。
6. **两条必须先于编码拍板的技术约束**（都有参考工程的实测依据）：`wx.downloadFile` 单次最大 200MB（ADR-067），成片包下载必须按集；参考工程的直传只有单次 presigned POST（`providers/storage/s3.ts:33-45`），撑不起「断点续传」和后台 GB 级原片/成片上传。

---

## 1. 技术栈、版本与 monorepo 结构

### 1.1 精确版本（以各 package.json 为准）

| 层 | 依赖 | 版本 | 出处 |
| --- | --- | --- | --- |
| 运行时 | Node.js | `>=24.0.0 <25`（`.nvmrc` / `.node-version` = 24） | `package.json` engines |
| 包管理 | pnpm | `10.30.0`（`packageManager` 固定）；`.npmrc`: `engine-strict=true` | `package.json`、`.npmrc` |
| 语言 | typescript | 5.9.3 | 根 `package.json` |
| Web 框架 | hono | 4.13.5 | `apps/api/package.json` |
| | @hono/node-server | 2.1.1 | 同上 |
| | @hono/zod-openapi | 1.6.1 | `apps/api`、`packages/contract` |
| | @hono/swagger-ui | 0.6.1 | `apps/api` |
| 校验 / 契约 | zod | 4.5.4 | api / worker / contract / services |
| | openapi-typescript | 7.13.0（dev） | `packages/contract` |
| ORM / DB | prisma、@prisma/client、@prisma/adapter-pg | 7.10.0 | `packages/db` |
| | pg | 8.23.0；@types/pg 8.23.1 | 同上 |
| | PostgreSQL | 16（`postgres:16-alpine`） | `infra/compose.yml` |
| 队列 | bullmq | 6.3.4 | api / worker / services |
| | ioredis | 6.0.0；Redis 7（`redis:7-alpine`，AOF 开） | 同上、`infra/compose*.yml` |
| 认证 | jose | 6.2.10 | api / worker / services |
| 日志 | pino | 10.3.1；pino-pretty 13.1.3（dev） | services |
| 监控 | @sentry/node | 10.73.0 | api / worker |
| 对象存储 | @aws-sdk/client-s3、@aws-sdk/s3-presigned-post | 3.1124.0 | api / worker / services |
| 文档抽取 | unpdf 1.8.1、mammoth 1.12.2 | | services |
| 构建 | tsup 8.5.1、tsx 4.23.13 | | api / worker |
| 测试 | vitest | 4.1.11 | 根 |
| 规范 | eslint 9.39.5、typescript-eslint 8.69.0、prettier 3.9.6、eslint-config-prettier 10.1.8 | | 根 |
| | @commitlint/cli + config-conventional 21.2.2、husky 9.1.7、lint-staged 17.4.1 | | 根 |
| 小程序 | @tarojs/* 4.2.1（Vite 编译，vite `^4.5.0`）、react 18.3.1、@nutui/nutui-react-taro 3.0.20、@nutui/icons-react-taro 3.0.2、zustand 5.0.15、sass `^1.80.0` | | `apps/mobile/package.json` |

说明：
- 服务端依赖一律**锁精确版本**（无 `^`），小程序端的构建链有少量 `^`。`chore(deps)` 提交 `f63b93d` 记录过「package.json 锁了精确版本、lockfile 还是 ^」的不一致，需要 `pnpm install` 同步。
- 文档与代码有版本漂移：`docs/00-project-plan.md` §3.3 写「BullMQ 5」，实际是 6.3.4；AGENTS.md 已更正为「BullMQ 6」。
- `pnpm-workspace.yaml` 用 `onlyBuiltDependencies` 白名单放行安装脚本（prisma、esbuild、@swc/core、@tarojs/binding、sharp 等）——pnpm 10 默认不跑依赖的 install script，新仓库会遇到同样的事。

### 1.2 目录与包职责

```
apps/
  mobile/    Taro 4 微信小程序（仅 weapp；h5 只作本地调试）
  api/       Hono 服务端：/api/v1/* + /health + /docs + /admin（同进程）
  worker/    BullMQ 消费者（5 条队列）+ 运维 CLI（cli / queue-admin / render-sample）
packages/
  contract/  Zod schema + createRoute 路由定义 + 错误码 → generated/openapi.json + types.d.ts
  db/        prisma/schema.prisma（921 行、28 个 model）+ 18 个迁移目录 + createPrismaClient
  services/  业务服务 + Provider 接口与驱动 + ServiceContext + queue 封装 + testing 替身
  shared/    纯工具（无 IO）：常量、id、时间、上传登记表
  config/    tsconfig 预设（base / node-lib / node-app）
infra/       compose.yml（本地 pg/redis/minio）· compose.prod.yml · nginx-api.conf · Caddyfile（备选）
             · ecosystem.config.cjs（PM2）· deploy.sh · check-proc-env.sh · test/deploy.test.ts
docs/        00–11 编号文档
```

规模参考（不含 node_modules / 生成物）：api + worker + packages + infra 约 7.3 万行，其中 `packages/services/src` 占绝大多数，测试代码与实现代码量大致相当（例如 `studio/draft.service.ts` 1391 行 / 对应测试 2100 行）。

### 1.3 依赖方向

【资料】AGENTS.md §2：`shared ← contract ← services ← api / worker`；`db` 只被 `services` 引用；`mobile` 只引用 `contract` 的生成类型（实际还引用了 `@liyo/shared/uploads`、`@liyo/shared/constants`，见 `apps/mobile/package.json` 与 `docs/02-architecture.md:183`）。

【资料 + 核对】这条方向**只是约定，没有工具强制**：
- `docs/00-project-plan.md` §5 写「CI 用 dependency-cruiser 或 eslint 规则校验」，但根 `package.json`、`eslint.config.js`、`.github/workflows/ci.yml` 里都没有 dependency-cruiser，ESLint 的 `no-restricted-imports` 只禁了 axios（`eslint.config.js:40-50`）。
- `apps/api/package.json` 与 `apps/worker/package.json` 都直接声明了 `@liyo/db`、`@prisma/client`、`pg` 依赖（因为 tsup 把 `@liyo/*` 内联进产物，第三方依赖必须在本包声明，见 `apps/api/tsup.config.ts:11-12`）。
- worker 有两处越过 services 直接碰数据层：`apps/worker/src/cli.ts:13` 引 `@liyo/db` 的类型；`apps/worker/src/jobs/maintenance.ts:43-53` 直接用 `ctx.prisma.$transaction` 做每日清理。

【推断】新项目多一个 `apps/admin`（Web）之后，包变多、人也可能变多，建议把依赖方向做成 ESLint 规则或 dependency-cruiser 检查进 CI，别再只靠约定。

### 1.4 内部包形态（ADR-017）

工作区包的 `exports` 直接指向 `src/*.ts`（如 `packages/contract/package.json`），开发期零构建；api / worker 用 tsup 打成单文件 ESM，`noExternal: [/^@liyo\//]` 把内部包内联，第三方保持 external（`apps/api/tsup.config.ts`）。`packages/*` 的 `build` 脚本是空操作。

---

## 2. 关键架构模式：做法与代码位置

### 2.1 契约先行（Zod → OpenAPI 3.1 → 类型生成 → contract:check）

| 环节 | 做法 | 位置 |
| --- | --- | --- |
| schema | 每个域一份 Zod schema，用 `.openapi()` 命名组件 | `packages/contract/src/schemas/*.ts` |
| 路由 | `createRoute({ method, path, request, responses, security })`，响应用 `okResponse()` / `errorResponses()` 拼 | `packages/contract/src/routes/*.ts`；工具在 `src/common.ts:89-111` |
| 通用件 | `IdSchema`（BIGINT 字符串，regex + refine 判上限）、`VersionSchema`（int4）、`envelope()`、`PaginationQuerySchema`（page ≥1，pageSize 默认 20 ≤100）、`paginated()`、`IsoDateTimeSchema`、`API_PREFIX = "/api/v1"` | `src/common.ts:10-113` |
| 登记 | 所有路由进 `allRoutes` 数组（顺序敏感：静态段要排在参数段前） | `src/index.ts`（尾部 `allRoutes`、`OPENAPI_INFO`） |
| 生成 | 用 no-op handler 把 `allRoutes` 注册到一个临时 `OpenAPIHono`，`getOpenAPI31Document` 写 `generated/openapi.json`，再 `openapi-typescript` 出 `generated/types.d.ts` | `packages/contract/scripts/generate.ts:11-33`；`package.json` 的 `generate` |
| 漂移检查 | `pnpm generate && git diff --exit-code -- generated`；生成物**入库**（`git ls-files packages/contract/generated` 有两个文件，约 373KB + 287KB） | `packages/contract/package.json` 的 `check`；CI `ci.yml:59-60` |
| 服务端绑定 | `app.openapi(route, handler)`；Zod 校验失败走 `defaultHook` → 400 + 40001 + `details` | `apps/api/src/app.ts:29-47`；各 `routes/*.ts` |
| 契约自测 | ① 每个错误码都有 HTTP 映射与文案；② **导出的每条路由都必须在 `allRoutes` 里**；③ 路径数与唯一 path 数相等；④ 路径参数必填且不可空；⑤ 数组里引用的组件不能是可空组件 | `packages/contract/src/contract.test.ts:16-148` |
| 在线文档 | `/api/v1/openapi.json` 按**实际挂载**的路由生成，`/docs` 是 Swagger UI | `apps/api/src/app.ts:109-125` |

「接口三步走」是 AGENTS.md 硬规则 1：改 contract → 实现 services + 薄路由 → `pnpm contract:generate`。小程序只从 `@liyo/contract/generated/types` 取类型。

【推断】对新项目的价值比参考工程更大：这次有小程序和 PC 后台两个消费端，同一份 `types.d.ts` 两边共用。后台路由建议单独成组（如 `routes/admin/*.ts`、OpenAPI tag `admin-*`），并考虑**生成两份文档**（商家端 / 运营端），避免把后台接口面暴露在商家端可见的 openapi.json 里。参考工程的做法是「未配置后台时线上 openapi.json 不含后台路由」（`packages/contract/src/index.ts` allRoutes 注释），新项目后台是常驻的，要显式拆。

### 2.2 services 作为业务逻辑唯一落点

- 路由是薄壳：取参 → 调 service → `ok(data)`。样例 `apps/api/src/routes/uploads.ts`（23 行）、`routes/archive.ts`。
- worker 处理器同样是薄壳：`apps/worker/src/jobs/ai-tasks.ts`（36 行）只做「按 job.name 分流 → 调 `ctx.tasks.runAiTask` → 把 `retry`/`failed` 翻译成 throw / `UnrecoverableError`」（ADR-019）。
- 服务写成工厂函数 `createXxxService(deps)`，依赖全部显式注入（prisma、其他 service、provider、`now()` 时钟），无 DI 容器、无装饰器。样例 `packages/services/src/media/media.service.ts:46-56`。
- 管理后台与开发者 CLI 复用同一套服务：`admin.service.ts` 自己几乎不写业务，只多做留痕（`packages/services/src/admin/admin.service.ts:7-11`）。

### 2.3 ServiceContext 装配

- `createServiceContext({ name })`：`loadEnv()` → pino logger → Prisma → ioredis → `createProviders` → `createQueues` → JWT / Token → `buildServices` → health，返回 `{ env, logger, prisma, redis, providers, queues, jwt, tokens, runtime, services, tasks, health, shutdown }`（`packages/services/src/context.ts:569-668`）。
- api 与 worker **各装配一份**（`apps/api/src/server.ts:12`、`apps/worker/src/index.ts:21`）。
- `buildServices(deps)`（`context.ts:222` 起）是「由已有基础设施装配业务服务」的纯函数，测试用它注入假 Provider、假队列、可拨动的时钟（`packages/services/src/testing/index.ts` 的 `createTestHarness`）。
- `Services` 接口（`context.ts:71`）是 api 路由与 worker 任务唯一依赖的面；`Tasks` 接口是 worker 侧执行入口。
- 环境变量只经 `loadEnv()`（Zod 校验，`packages/services/src/config/env.ts`）：必填只有 `DATABASE_URL`、`REDIS_URL`、`JWT_SECRET(≥32)`；其余全部可选并带默认值；另有「成对校验」（视觉 / 音频线路的 BASE_URL 与 API_KEY 只填一个就启动即失败，ADR-058）。

【推断】`context.ts` 已经 668 行、`Services` 接口 25 个成员，全在一个文件里手工接线。新产品域更多（主体/门店、套餐、积分、付款、订购、广告、交付、发布、工单、财务、报表、系统），建议按域拆装配函数（`buildBillingServices` 等），避免单文件继续膨胀。

### 2.4 Provider 抽象与「未配置不崩溃」（原则 P6）

- 接口集中在 `packages/services/src/providers/types.ts`：`SmsProvider`、`StorageProvider`、`WechatProvider`、`LlmProvider`、`AsrProvider`、`GeoProvider`、`RenderProvider`，每个都带 `readonly configured: boolean`。
- 未配置实现：`providers/unconfigured.ts:12-65`——调用即 `AppError.unavailable("xx未配置")`（50001 / HTTP 503），进程照常启动。
- 装配：`providers/index.ts` 的 `createProviders(env, logger, { redis })` 按 env 是否齐全选驱动；启动时打一行 `providers ready` 汇总各 Provider 生效状态（`index.ts:298-322`），**这行日志是核对线上配置的事实源**（因为 PM2 旧 env 快照会压过 `.env`，见 §6.1）。
- worker 侧：`isUnavailable(err)` 的任务直接 `UnrecoverableError`，不占着队列退避（`apps/worker/src/jobs/maintenance.ts:25-28`；`packages/services/src/errors.ts:41-43`）。
- 降级边界是逐能力设计的，不是一刀切。例：生产环境微信没配时内容安全「不放行」，开发环境「跳过」（`context.ts:627-628` 的 `unconfiguredSafety`）。

【推断】新产品要新增的 Provider：`PayProvider`（微信支付 JSAPI 下单 / 回调验签 / 退款 / 账单下载）、`OcrProvider`（营业执照、食品经营许可证）、`WecomProvider`（企业微信绑定、可能的通知）、可能的 `VodProvider`（转码 / 多码率 / 水印）。但**支付不能照搬「未配置就 50001」的降级语义**：支付回调丢失、退款失败是资金问题，要有对账与补单，而不是「下次再试」。

### 2.5 错误码与错误双通道（ADR-012）

- 唯一源 `packages/contract/src/errors.ts:5-65`：`ErrorCode` 常量 + `errorHttpStatus` + `errorMessage` 三张表。现有 17 个码：0、40001、40010–40017、401、40301、40401、40901、42901、50000、50001。
- 服务层只抛 `AppError`（`packages/services/src/errors.ts:5-39`，带 `badRequest / unauthorized / forbidden / notFound / conflict / rateLimited / unavailable` 工厂）。
- api 统一序列化 `apps/api/src/middleware/error.ts:10-53`：`AppError` → 其 status + `{code,message,details?}`；`HTTPException` → 映射码；`InvalidIdError` / 数据库拒收 BIGINT → 400 + 40001 并打 warn、报 Sentry warning；其余 → 500 + 50000 并报 Sentry。
- 成功体恒为 `{ code: 0, message: "ok", data }`（`apps/api/src/types.ts:26` 的 `ok()`）。
- 客户端规则：先读 body 的 `code`，无 body 才看 HTTP 状态；401 触发一次 refresh 重放（`docs/04-api-contract.md` §2）。

【推断】新项目要扩一批业务码：套餐未生效/已过期、积分不足、积分冻结冲突、门店未认证、名额超限、订单状态不允许、审批状态不允许、支付失败/重复支付、无数据范围权限等。建议按域分段（如 41xxx 套餐积分、42xxx 订单交付、43xxx 支付财务），沿用三张表同源的写法。

### 2.6 鉴权：JWT 双 token、refresh 轮换

| 项 | 做法 | 位置 |
| --- | --- | --- |
| access | HS256，默认 2h；claims `sub=uid`、`aud=liyo`、`iss=liyo-identity`、`client_id` | `packages/services/src/identity/jwt.ts:24-67` |
| 密钥轮换 | 签发只用当前密钥；校验依次试当前与 `JWT_SECRET_PREVIOUS` | 同上 `:29-33, 48-65` |
| refresh | 32 字节随机 base64url，库里只存 sha256；默认 30d；轮换时旧行写 `revoked_at` + `replaced_by_id` | `identity/tokens.ts:22-66`；表 `refresh_tokens` |
| 中间件 | `requireAuth(jwt)` 解析 Bearer 写 `userId / clientId`；`optionalAuth` 给「登录/绑定合一」接口 | `apps/api/src/middleware/auth.ts` |
| 客户端 | 小程序 `request.ts` 自动带 Bearer、401 单飞 refresh、重放一次 | `apps/mobile/src/utils/request.ts`、`refresh.ts` |
| 清理 | maintenance 每日 03:00 删过期 / 吊销超过一天的 refresh token、过期验证码、未确认上传登记 | `apps/worker/src/jobs/maintenance.ts:43-53` |

【核对发现，供新项目设计时注意】
1. `tokens.rotate()` **不在事务里**，也没有「旧 token 被重放 → 吊销整条链」的检测：先 `findUnique` 判有效 → `issue()` 新 token → 再 `update` 旧行（`tokens.ts:50-66`）。两个并发 refresh 拿同一个旧 token 都会成功。小程序端靠单飞避免，PC 浏览器多标签页会真的并发。
2. `requireAuth` 只验 JWT 签名与有效期，不查用户状态（`auth.ts:6-16`）：账号被禁用后 access token 在 2h 内仍有效。对商家端可接受，对运营后台员工不可接受——参考工程自己也是因此给后台另做了 Redis 会话（ADR-063）。
3. 短信验证码明文入库、5 分钟有效（`docs/03-data-model.md` §1 `sms_codes`）；且【资料】生产的短信驱动截至 2026-09-16 仍是 `console`（`docs/02-architecture.md:60`），**腾讯云短信这条链路没有经过生产验证**。新产品的续费/上线/下架提醒要用短信（PRD 6.10.1、7.11.4），这部分不能当成「已验证资产」。

### 2.7 权限断言

- 参考工程只有一套权限：IP 成员角色，线性四级 `viewer(1) < editor(2) < admin(3) < owner(4)`（`packages/shared/src/constants.ts` 的 `IP_ROLE_RANK`）。
- 断言在**服务层**做：`ipService.assertMember(ipId, userId, minRole)`——非成员 40401、IP 已停用 40015、角色不足 40301（`packages/services/src/ip/ip.service.ts:188-207`）。路由不做权限判断（AGENTS.md §5）。
- 行级归属：各服务拿到资源后再断言它的 `ip_id`（例 `ai-jobs.service.ts:181-185`）。
- 【资料】`docs/00-project-plan.md` §4.2 规划的是 `ipMember` 中间件，实际落地改成了服务层断言；ADR-030（停用 IP）特意指出「IP 状态只在 assertMember 生效，定时任务等旁路必须各自过滤」，并修过一次「每日梳理不过滤 IP 状态」的漏洞。

【推断】新产品权限维度多得多，线性 rank 不够用：
- 商家侧：老板 / 店员（V1.1 加管理员、服务商），且是「主体级 + 门店级」两层；店员**看不到**积分、金额、合同、发票（PRD 3.1、6.16.2）——这是字段级/资源类型级的可见性，不是 rank 比大小。
- 平台侧：8 类岗位 × 13 个模块的「查看 / 编辑 / 本人任务 / 无」矩阵 + 数据范围（本人 / 本组 / 全部）+ 敏感操作二次确认与审批（PRD 3.3）。
- 建议沿用「断言在服务层、路由不判权限」的原则，但把断言抽成显式的权限点（`can(actor, "order.refund.approve", resource)`）+ 数据范围过滤器（进查询 where），并把「旁路也要过滤」写进规范。

### 2.8 限流与请求加固

- 集中声明在 `apps/api/src/app.ts:55-86`：`/api/*` 请求体 ≤1MB、超时 30s、全局每 IP 300 次/分；登录、短信、refresh、识图单独收紧。写接口在各路由文件按用户维度加 `rateLimit(..., { keyBy: "user" })`（例 `routes/uploads.ts:11-14`）。AGENTS.md 规则 13「加固不可退化」。
- 实现 `apps/api/src/middleware/rate-limit.ts`：Redis 固定窗口 `INCR` + 首次 `EXPIRE`（`:17-27`）；测试用内存实现；超限 429 + 42901 + `Retry-After` / `X-RateLimit-*`（`:64-79`）。
- 额度清单见 `docs/04-api-contract.md` §2.1。
- 安全头 `secureHeaders()` 全局开；**不开 CORS**（`docs/02-architecture.md` §4）。nginx 侧 `client_max_body_size 2m`（`infra/nginx-api.conf:46`）。

【核对发现】
1. 客户端 IP 取 `X-Forwarded-For` **第一跳**（`rate-limit.ts:49-53`），而 nginx 用的是 `$proxy_add_x_forwarded_for`（追加，不覆盖，`infra/nginx-api.conf:53`）。客户端自带一个 `X-Forwarded-For` 头就能伪造第一跳，按 IP 的限流（含登录、短信）可被绕过。新项目应取 `X-Real-IP` 或可信代理之后的最后一跳。【推断，未做实测】
2. `INCR` 与 `EXPIRE` 是两条命令、非原子（`rate-limit.ts:21-22`）：两条之间进程退出会留下永不过期的计数键。量小时无感，新项目可用 Lua 或 `SET NX EX` + `INCR` 修掉。
3. 新项目有两类请求会撞上现有加固：**支付回调**（需要原始请求体验签、不能套用户限流、微信侧有重试）与 **Excel 导入 / 大表导出**（1MB 体积与 30s 超时都不够）。前者要单独的路由组与白名单，后者应走「直传 + 异步任务 + 下载链接」。

### 2.9 乐观锁

- 多人编辑的表带 `version`（int4）；更新走 `updateMany({ where: { id, version }, data: { ..., version: { increment: 1 } } })`，`count === 0` → `AppError.conflict()`（409 + 40901）。样例 `packages/services/src/archive/archive.service.ts:90-100`、`expression/expression.service.ts:537-538`。
- 契约侧 `VersionSchema` 收紧到 int4（`packages/contract/src/common.ts:24-29`）。
- 需要串行化的地方另用**事务级 advisory lock**：`pg_advisory_xact_lock(hashtextextended(key, 0))`，并用类型把「必须在交互式事务里拿」钉死（`packages/services/src/studio/draft.service.ts:174-195`）。
- 幂等更多靠**唯一约束**而不是先查后写（ADR-059：「每周幂等靠唯一约束、渲染 jobId 带 renderId，都不指望 BullMQ 的 jobId 去重」）。

【推断】积分账户的冻结/扣减/退回是高一致性场景，乐观锁 + 重试不如「事务内 `SELECT … FOR UPDATE` 锁账户行（或 advisory lock 按主体 id）+ 流水表唯一业务键」稳妥。参考工程没有用过 `FOR UPDATE`（全仓 grep 无命中），这一块是新写。

### 2.10 事务后入队与补偿

【资料】这是参考工程花了最多修复提交的一块，规则已经沉淀得很清楚：

1. **入队一律在事务提交之后**：worker 抢得快，提交前推出去会读到还没有的行（`packages/services/src/studio/render.service.ts:12-22`）。
2. **先建行、后推队列；推失败不回滚行**：行还在（pending），由补偿扫描补推；反过来「行没建成却推了队列」才是麻烦。
3. **产品可见状态记在库里**（`ai_jobs` 表：pending / processing / succeeded / failed + attempts + error + queue_job_id），BullMQ 只做调度（`ai/ai-jobs.service.ts:8-17, 106-161`）。
4. **幂等键 = 这次任务的输入**：jobId 形如 `task-targetType-targetId-dedupeKey`（BullMQ 自定义 jobId 不许含冒号，`ai-jobs.service.ts:83-85`）。同 jobId 再 add 会被**静默忽略**（已完成的 job 只要还在 `removeOnComplete` 保留的最近 N 个里就占着 id）——这个坑本仓「已踩 4 次」（`render.service.ts` 注释、ADR-055、`docs/06-dev-guide.md` §4 末）。
5. **补偿扫描**：`studio_compensate` 每 5 分钟（maintenance 队列）捡回「排队超时没人认领 / 处理中失联 / 终态没收尾」的行，**每条业务线各判各的失联**，不合成一个判定（`docs/06-dev-guide.md` §7 末；`packages/services/src/studio/compensate.ts`）。
6. **队列 attempts 必须与库里判终态的上限一致**（都是 3）：否则 BullMQ 已放弃而库里被写回 pending，永远卡住（`queue/queues.ts:99-104`）。

注意：最早的通用实现 `aiJobs.enqueue()` 是「建行 → push → 回写 queueJobId」三步、不在一个事务里（`ai-jobs.service.ts:106-136`），靠「复用未完成的行」与补偿扫描兜底；没有 outbox 表。

【推断】新产品里「支付成功 → 套餐生效 / 积分到账 → 通知」「审核通过 → 生成工单 + 扣减积分」这类链路，资金与积分变更必须在同一个数据库事务里完成，通知与后续任务才走「提交后入队 + 补偿」。如果团队想少写补偿逻辑，可以评估 transactional outbox（参考工程未采用）。

### 2.11 BullMQ 队列划分、重试、限速、优先级

| 队列 | 并发 | 重试 / 退避 | 用途 | 位置 |
| --- | --- | --- | --- | --- |
| `ai-tasks` | 2 | 3 次，指数 5s；`removeOnComplete/Fail: 200` | 模型调用类任务；定时扫描也挂在上面按 `job.name` 分流；后台批任务带 `priority = 10`（ADR-066） | `queue/queues.ts:72-77`；`apps/worker/src/index.ts:43-47` |
| `push` | 4 | 1 次（授权是一次性的，不重试） | 微信订阅消息 | `queues.ts:153-161` |
| `maintenance` | 1 | 3 次，指数 10s | 每日清理、封面抽帧、补偿扫描 | `queues.ts:80-85` |
| `downloads` | env（默认 3）+ **队列级限速** `limiter: { max: 20, duration: 60s }` | 3 次，指数 15s | 打外部平台接口 / 下载 | `index.ts:66-70`；`queues.ts:91-96` |
| `render` | 写死 1 | 3 次，固定 30s | ffmpeg 渲染（内存受限） | `index.ts:80-83`；`queues.ts:108-113` |

- 队列名唯一源 `queue/names.ts`；生产者封装 `createQueues()`，api 与 worker 都只经这里入队（`queues.ts:116-178`）。
- 「按任务名分队列」`queueFor`（`context.ts:245-250`）。
- 分队列的判据（ADR-051 / 061 / 066）：**独立队列 = 独立并发 + 独立限速 + 可单独暂停**；只想调先后用 `priority`，不另开队列。
- 可重试 vs 不可重试：服务层执行器返回 `"retry"` / `"failed"`，或以 `AppError` = 永久、普通 `Error` = 可重试区分（ADR-019、ADR-051）。
- 运维 CLI `queue-admin.js pause|resume|status <queue>`，部署时先暂停 render 队列（`infra/deploy.sh` 的 `render_queue`）。

【推断】新产品 V1.0 的队列大致是：`notify`（订阅消息 / 短信 / 站内）、`media`（素材转写、识别、封面、转码回调处理）、`billing`（积分发放、清零、到期处理、对账账单下载）、`export`（报表与列表导出）、`maintenance`。`downloads` / `render` 在 V1.0 不需要（成片由剪辑师人工制作上传），V1.1「批量合成模板」与 V2.0 自动化时再启用，ADR-061 的护栏经验届时直接可用。

### 2.12 定时任务

- BullMQ Job Scheduler：`queue.upsertJobScheduler(id, { pattern, tz } | { every }, template)`，时区 `APP_TIMEZONE`（`apps/worker/src/index.ts:158-200`、`apps/worker/src/schedules.ts`）。
- 定时表抽成纯数据（`AI_TASK_SCHEDULES`），可以不连 Redis 做单测（`schedules.ts:4-16`、`apps/worker/test/schedules.test.ts`）。
- 定时任务的套路是**「扫描只查库、只入队，重活由逐条任务做」**，且扫描本身要幂等、可重试（每周扫描给 3 次、隔 5 分钟，`schedules.ts:34-39`）。
- cron 时刻与给用户看的文案共用 `@liyo/shared` 的同一份常量（`packages/shared/src/constants.ts` 的 `DAILY_DIGEST_CRON` 等）。
- worker 被要求**单实例**（`infra/ecosystem.config.cjs:28-31`：「定时任务不可重复：只允许 1 个实例」）。

【推断】新产品的定时任务明显更多、且涉及钱：每月按开通日发放套餐积分、到期日 24:00 清零与冻结、到期前 7/3/1 天提醒、上线日前提醒、使用期结束前 30/7/1 天下架任务、版权到期前 90 天提醒、每日下载微信支付账单对账、工单 3 天自动解决、30 分钟响应超时升级（PRD 2.2、2.3、2.5、7.2、7.8、7.9）。这些必须做成**按业务键幂等**（如 `grant:{主体}:{周期}:{月序}` 唯一约束），不能依赖「worker 只有一个实例」来保证不重复。

### 2.13 文件直传（presign / confirm）

1. `POST /uploads/presign {kind,mime,size,ipId?}` → 成员断言 → mime 白名单 + 大小上限 → 生成不可猜 key（`<prefix>/<yyyy>/<mm>/<16 字节随机>.<ext>`，`packages/shared/src/id.ts:29-35`）→ 先写 `media_assets(status=pending)` → S3 presigned POST（policy 带 `content-length-range` 与 `Content-Type` 相等条件）。`media/media.service.ts:66-96`、`providers/storage/s3.ts:33-45`。
2. 端上 `Taro.uploadFile(url, formData=fields)` 直传。
3. `POST /uploads/confirm {key}` → 只认本人的登记 → `HEAD` 核对存在与大小（超限则删对象删行）→ `confirmed`。`media.service.ts:98-131`。
4. 未确认的登记 24h 后由 maintenance 清理。
5. 上传类别登记表（扩展名 → MIME、上限、别名）在 `packages/shared/src/uploads.ts`，服务端、契约、小程序共用（ADR-032）。
6. 读取：**公有读桶 + 随机 key**（ADR-008 / D6），`publicUrl(key)` 直接拼；私有桶 + 签名 URL 被列为「V1.1」，至今未做。
7. `StorageProvider` 另有 `get(key,{maxBytes})`（带上限读回）、`put`、`putStream`（流式、带 ContentLength）、`delete`（`providers/types.ts`）。

【核对结论】`StorageProvider` **没有**：签名下载 URL（未引 `@aws-sdk/s3-request-presigner`）、分片上传（Multipart）、STS 临时密钥、CDN 鉴权、转码 / 水印。默认上限：图片 5MB、视频 50MB、音频 10MB（登记表另写 100MB）、文件 20MB（`config/env.ts` 的 `UPLOAD_MAX_*_MB`）。

### 2.14 日志与可观测

- 全仓唯一日志构造 `createLogger()`：pino JSON → stdout，开发期可选 pino-pretty（`packages/services/src/logger.ts`）；ESLint 禁 `console.log`（`eslint.config.js:39`）。
- 每请求 `requestId`（hono/request-id）+ 子 logger + 访问日志（method / path / status / ms / userId），5xx 记 error、4xx 记 warn（`apps/api/src/middleware/logger.ts`）。
- Sentry：有 DSN 才初始化，`tracesSampleRate: 0`（只报错不做追踪）；未知异常报 error，「兜住了但说明有处校验漏了」报 warning（`apps/api/src/observability.ts`、`middleware/error.ts:42-51`）。
- 生产日志由 PM2 落 `/var/log/liyo/*.log`（`infra/ecosystem.config.cjs`）。不建 Loki / Grafana（ADR-015）。
- 无指标（metrics）、无链路追踪、无业务审计（除后台 `admin_audit_logs`）。

【推断】新产品「关键操作记录日志，建议保留不少于 3 年」（PRD 7.12.5）是**业务审计**，要落库（操作人、对象、前后值、原因、审批单号），不能靠运行日志。财务链路（支付回调、退款、对账差异、积分调整）还需要告警，而不仅是 Sentry 报错。

### 2.15 健康检查

- `GET /health`（无前缀、公开）：`status(ok|degraded)`、`version`、`time`、`db`、`redis`，可选 `worker(ok|down|unconfigured)`（`packages/services/src/health/health.service.ts`、`apps/api/src/routes/health.ts`）。各探测 1.5s 超时。
- worker 心跳（ADR-064）：每 30s 写 Redis `liyo:worker:hb:<name>`，TTL 90s（`queue/heartbeat.ts:18-28, 67-92`）；api 读它。三条边界：只回聚合值（`/health` 对公网开放）、worker 不进 `status`、字段可选。
- 部署脚本用 `/health` 等新进程起来，并逐进程核对 `/proc/<pid>/environ` 与 `.env`（`infra/deploy.sh` 的 `wait_health` / `check_env`、`infra/check-proc-env.sh`）。

### 2.16 测试分层

| 层 | 做法 | 位置 |
| --- | --- | --- |
| 组织 | 根 `vitest.config.ts` 用 `projects: ["packages/*", "apps/api", "apps/worker", "infra"]` | 根 |
| 单元 | 纯逻辑不连库：shared、contract、services 里的纯函数（状态机、编译器、参数解析） | `packages/**/**.test.ts` |
| 数据库集成 | **连真实 PostgreSQL**，services 与 api 各用独立 schema（`test_services` / `test_api`），globalSetup 自动 `prisma migrate deploy`，每个用例前 `resetDatabase()`；`fileParallelism: false` | `packages/services/vitest.config.ts`、`src/testing/global-setup.ts`、`testing/index.ts:68-82` |
| 安全阀 | `resetDatabase` 在非 `test_*` schema 上直接拒绝；`createPrismaClient` 把 `?schema=` 同时落到适配器与 `search_path` | `testing/index.ts:68-76`、`packages/db/src/index.ts:13-37` |
| api 集成 | `buildApiHarness()` 组装真实服务层 + 假 Provider + 内存限流器，`h.as(token).post(...)` 走 `app.request()` | `apps/api/test/helpers.ts` |
| 替身 | 假微信 / 短信 / 存储 / LLM / ASR / 队列 / Redis / 渲染器 / 时钟，随 `@liyo/services/testing` 导出 | `packages/services/src/testing/index.ts`（1030 行） |
| 契约 | `contract.test.ts` + CI 的 `contract:check` | 见 §2.1 |
| 基建 | 部署脚本也有测试 | `infra/test/deploy.test.ts`（543 行） |
| golden | ffmpeg 渲染在 CI 独立 job 真跑（与生产同大版本） | `ci.yml:71-120`、`packages/services/vitest.render.config.ts` |
| 小程序 | 无自动化；真机用例清单 `docs/09-qa-checklist.md` | `apps/mobile/package.json` 的 `test` 是 echo |

---

## 3. 管理后台现状（ADR-063）

### 3.1 实现方式

【资料】`docs/02-architecture.md` ADR-063、`docs/04-api-contract.md` §3.8、`docs/03-data-model.md` §9 末、代码：

- **页面**：`apps/api/src/routes/admin-page.ts`，一个 `adminPage(): string` 返回的 HTML 字符串（284 行，含内联 CSS 与原生 JS），由 `app.get("/admin", …)` 直接吐出（`routes/admin.ts:165`）。**没有构建步骤、没有框架、没有路由**。三个面板：闭测名单（登记 / 列表 / 撤回）、成片草稿抽检（列表 / 详情 / 放行 / 重写 / 重出）、操作留痕。
- **接口**：12 条 `/api/v1/admin/*`（契约 `packages/contract/src/routes/admin.ts`，实现 `apps/api/src/routes/admin.ts`）。
- **挂载**：只在配了 `ADMIN_SECRET_KEY` 且有 Redis 时挂载，否则整组 404（`apps/api/src/app.ts:107`；装配 `context.ts:376-384`）。
- **身份**：`admin_accounts`（邮箱 + scrypt 密码 + TOTP，TOTP secret 用 AES-256-GCM 可逆加密、恢复码 sha256 一次性）与小程序 `users` 是两个身份空间、互不提权（`packages/db/prisma/schema.prisma:879-897`；`admin/crypto.ts`、`admin/totp.ts` 自己实现 RFC 6238，不引 otplib）。
- **会话**：Redis，8 小时；cookie `__Host-liyo_admin`（HttpOnly + Secure + SameSite=Strict）；写操作另要自定义头 `x-liyo-admin: 1`；登录连错 5 次锁 15 分钟 + 路由限流 10 次/分；停用账号 / 重置动态码立即踢下线（`admin/admin-auth.service.ts:27-33, 130-227`；`apps/api/src/middleware/admin-auth.ts:23-34`）。
- **账号管理**：只能用 worker CLI（`admin:create` / `admin:reset-mfa` / `admin:disable`，`docs/06-dev-guide.md` §7）。
- **留痕**：`admin_audit_logs`（admin_id、action、target、detail jsonb、ip、created_at），只增不改，不记正文与密钥（`admin/admin.service.ts` 的 `audit`）。
- **业务规则**：一条都不重写，转调 services 的 `studioMembers` / `draftAdmin`，与 CLI 同一套判定。

### 3.2 能力边界（核对代码得出）

| 维度 | 现状 |
| --- | --- |
| 角色 / 权限 | **没有**。`requireAdmin` 只判「有没有有效会话」；所有后台账号能做所有事。无菜单权限、无按钮权限、无数据范围 |
| 账号自助 | 无页面；建号、重置、停用全靠 CLI；无改密码、无企业微信绑定 |
| 列表 | 只有 `limit`（1–200）与少量筛选；**无分页、无排序、无导出** |
| 审批 / 二次确认 | 无 |
| 文件 | 无上传、无预览、无下载 |
| 前端工程 | 无组件库、无路由、无状态管理、无国际化、无表单校验框架；页面逻辑约 150 行原生 JS |
| 审计 | 有表，但路由传入的 actor 只有 `{id,email}`（`routes/admin.ts:49-52`），`ip` 列实际恒为 null |
| 测试 | `apps/api/test/admin.test.ts`（185 行）+ 服务单测（auth / crypto / totp） |

### 3.3 为什么不足以支撑新产品的运营后台

【资料】新产品的要求：PRD 3.2–3.3（8 类内部角色、13 个模块的权限矩阵、「菜单＋按钮＋数据范围」三级、主管看本组、敏感操作二次确认 + 审批 + 留痕）、PRD 7（「所有列表支持筛选、分页和导出」）、PRD 8.2（56 个画板）、PRD 7.12（员工账号、角色权限、数据字典、参数配置、操作日志）、PRD 10.2（后台登录须二次验证）。

【推断】逐项对照：

1. **形态不成立**：ADR-063 明确选择「纯字符串、不引框架」是为了「别为一个内部工具再养一条前端流水线」。56 个画板里有复杂表单（短剧编辑含四组字段 + 剧集管理 + 大文件上传）、日历（上线日历）、并排审核（证照原图 vs OCR）、报表图表、工单会话流——用字符串拼 HTML 不可维护，必须是独立的 SPA 工程（`apps/admin`），有组件库、路由、构建与部署。
2. **权限模型不存在**：要新建员工、角色、权限点（菜单 / 按钮）、数据范围（本人 / 本组 / 全部）、岗位主管关系，以及服务端的权限断言与查询过滤。
3. **列表能力不存在**：分页 / 排序 / 多条件筛选 / 导出要成为后台接口的通用规约（参考工程的 `PaginationQuerySchema` / `paginated()` 可直接用，但后台接口当时没用它）。
4. **审批与二次确认不存在**：退款两步、积分调整审批、改价审批、归属变更审核、补偿审批都是新流程。
5. **账号生命周期不存在**：员工的新增 / 禁用 / 重置密码 / 绑定企业微信要有页面。

**可以沿用的部分**（这些恰好对上 PRD 10.2「后台登录须二次验证」）：
- 员工身份与商家身份分两个空间、互不提权；
- Redis 会话而不是 JWT（即时吊销）；`__Host-` cookie + SameSite=Strict + 写操作自定义头；
- scrypt + TOTP + 恢复码的实现与测试向量（`admin/totp.test.ts` 钉了 RFC 官方向量）；
- 登录失败锁定 + 不泄露账号是否存在；
- 审计表「只增不改、不记敏感正文」的口径，以及「业务规则不在后台重写一份」的原则。

需要调整：`ADMIN_SECRET_KEY` 未配置就整组 404 的做法，对一个常驻的生产后台不适用（后台是必备件）；同源部署（后台静态资源与 `/api` 同域）才能继续「不开 CORS」；`revokeAllSessions` 用 `SCAN` 全量扫会话键（`admin-auth.service.ts:217-227`），员工数上来后应改成「按账号维护会话集合」。

---

## 4. 全部 ADR 要点表

说明：ADR 位于 `docs/02-architecture.md` §2（第 97–175 行）。ADR-001～066 是一张大表里的行，ADR-067 起改成小节。**ADR-030 重号**（两条）、**ADR-060 / 065 空号**（`docs/02-architecture.md:165-169`）。「借鉴」列：✅ 直接沿用 / 🔧 调整后沿用 / ⛔ 不适用（业务专属或已被新需求否定）。

| # | 决定（要点） | 借鉴 | 对新项目的说明 |
| --- | --- | --- | --- |
| 001 | 本期只做微信小程序，其他端等明确需求再立项 | ⛔ | 新产品 V1.0 就是「小程序 + PC 后台」两端；但「不预建无消费方能力」（P4）的原则可留 |
| 002 | 独立 Hono 服务 + Zod → OpenAPI 3.1 单一契约，不用 tRPC | ✅ | 两个消费端共用一份契约，价值更大 |
| 003 | Node 24 LTS，`engines` 强约束 | ✅ | |
| 004 | NutUI React Taro 3.0 稳定线，不用 4.0 beta | ✅ | 仅小程序端；PC 后台组件库另选 |
| 005 | Prisma 7 + `@prisma/adapter-pg`，生成器 `prisma-client` 输出到 `packages/db/src/generated` | ✅ | 新增金额 / 积分列时注意类型选择（参考工程没有 Decimal 列） |
| 006 | LLM 走国内 OpenAI 兼容端点直连，OpenRouter 仅可选 | 🔧 | V1.0 若做素材自动识别就需要；注意该 ADR 后来在生产被事实推翻（主链路走了境外 OpenRouter，`docs/00-project-plan.md` R10） |
| 007 | 语音转写以腾讯云 ASR 服务端为主路径 | 🔧 | 门店素材的录音 / 视频转写（PRD 6.16.3）可用 |
| 008 | 对象存储公有读桶 + 随机 key；私有桶 + 签名 URL 列 V1.1 | ⛔ | 与 PRD 10.2（播放地址签名、防盗链、成片包签名下载 7 天有效）直接冲突，必须一开始就私有桶 |
| 009 | BIGINT 主键以十进制 string 传输 | ✅ | |
| 010 | 单机 + Compose 中间件 + PM2 + Caddy | 🔧 | 实际生产是阿里云 ECS + 宿主机 nginx；新产品有 99.9% 可用性与每日备份要求（PRD 10.1、10.2），单机形态要重新评估 |
| 011 | 只做身份模型 + JWT 双 token，OIDC / 设备码 / API Key 不建 | 🔧 | 商家端沿用；另加员工身份（会话制） |
| 012 | 错误双通道：HTTP 语义状态 + body `{code,message}` | ✅ | |
| 013 | 业务与身份接口统一 `/api/v1/*`，`/health` 无前缀 | 🔧 | 沿用前缀；后台接口单独分组 |
| 014 | 同行参考只 fetch og 元数据，不引抓取框架 | ⛔ | 业务专属 |
| 015 | Pino stdout + PM2 日志 + Sentry + 探活，不建 Loki / Grafana | 🔧 | 起步可沿用；需补业务审计与财务告警 |
| 016 | 小程序错误上报：评估 sentry-miniapp，不行则自建 `/client-logs` | ✅ | 结论仍待评估，照此处理 |
| 017 | 工作区包直接导出源码，api / worker 用 tsup 内联 | ✅ | 后台 SPA 用 Vite 可直接消费 `types.d.ts` |
| 018 | 审计列 `created_by / updated_by` 不建外键只建索引 | ✅ | 新项目要区分操作人是商家用户还是平台员工（两个身份空间） |
| 019 | 任务执行器在 services，worker 薄壳；可重试交 BullMQ 退避，不可重试直接 failed；库表记产品可见状态 | ✅ | 表名不必叫 `ai_jobs`，建议通用 `jobs` |
| 020 | 录音分片 ≤60s，一句话识别同步接口 | 🔧 | 素材录音「单条最长 5 分钟」（PRD 6.16.3）应直接用录音文件识别（见 043 / 050） |
| 021 | og 解析失败占位不入队 | ⛔ | 业务专属 |
| 022 | 上线期继续 PM2 跑宿主机 Node，容器化推迟 | 🔧 | 需架构师决定新项目是否一开始就容器化 |
| 023 | IP 头像先建后传（presign 是 IP 维度） | 🔧 | 教训可用：presign 的作用域设计要覆盖「资源还不存在」的场景（建档中的门店） |
| 024 | 当前 IP 切换入口收敛到一处 | 🔧 | 「切换门店」（PRD 6.16.1）同类交互，一个动作一个入口 |
| 025 | presign 的 `ipId` 可选，省略即用户维度上传 | 🔧 | 上传作用域要扩成：用户 / 门店 / 主体 / 平台员工 |
| 026 | 单次邀请被拒即作废并留痕 | 🔧 | 店员邀请（24 小时有效、待接受占名额，PRD 6.16.2） |
| 027 | 三个提示词统一先读 IP 身份语境 | ⛔ | 业务专属（V2.0 AI 可参考） |
| 028 | IP 资料与转让迁到独立二级页 | ⛔ | 交互专属 |
| 029 | 邀请必须定向到手机号（微信无法控制转发） | 🔧 | PRD 只写「卡片发给微信好友、手机号验证后加入」，没说定向；该 ADR 的理由对新产品同样成立，需产品确认 |
| 030a | 录音改走微信同声传译插件，服务端 ASR 兜底 | ⛔ | 交互专属；如素材录音要即时出字可参考 |
| 031 | 附件按录音分组，单条附件上限 60 | ⛔ | 业务专属 |
| 030b | 停用 IP 是访问闸门：不级联改子资源，旁路任务各自过滤 | 🔧 | 「套餐过期」正是这种闸门（不能新订购，在制与已上线不受影响，PRD 2.3）；不级联 + 旁路自查的口径直接可用 |
| 032 | 上传类别 / MIME / 上限由 `@liyo/shared` 登记表按扩展名判定；超限图片先压缩 | 🔧 | 登记表模式直接用；上限按 PRD 重定（图片 5MB 先压缩与 PRD 10.1 一致） |
| 033 | 导入的音频不转写（后被 043 修订） | ⛔ | 已被取代 |
| 034 | 视频封面两级生成：端上缩略图直传，缺的由 worker ffmpeg 抽帧回填 | 🔧 | 门店素材视频、预告片封面可用；若上云点播则由点播截图 |
| 035 | 需要反查的引用关系走关联表，不放 JSONB；模型侧用行号不用真实主键 | 🔧 | 「素材被哪些订购采用」「工单关联订单」同理走关联表 |
| 036 | 「哪一天」按应用时区由服务端算；搜索统一 `escapeLike`；jsonb 数组子串匹配用原生 SQL | ✅ | 报表按日口径、后台列表搜索都会遇到 |
| 037 | 识图同步直出表单草稿，不建 job、不落库；只收本站前缀 URL；端上只填空字段 | 🔧 | 营业执照 OCR「识别后商家核对提交」（PRD 6.3.4）是同一形态；建议用专门 OCR 接口而非通用视觉模型 |
| 038 | 附件先逐个理解再汇总；结果按对象 key 缓存；隐私红线（人脸不与真名同调用） | 🔧 | 门店素材自动识别打标签（PRD 6.16.3）可复用管线；「含顾客正脸需肖像授权」可借隐私规则 |
| 039 | 素材卡改信息流四层 | ⛔ | 交互专属 |
| 040 | 素材浏览器：一附件一屏 | ⛔ | 交互专属（素材详情页可参考） |
| 041 | 录音原话逐段落库，文字类附件批量出描述与标签 | 🔧 | 素材「语音转文字与自动提炼的要点」（PRD 6.16.3） |
| 042 | 视频配额与「重读」入口；dedupeKey 用 `manual-<ts>` | 🔧 | 「重新识别」类入口的幂等键写法 |
| 043 | 长音频优先走腾讯云录音文件识别（建任务 + 轮询），音频模型为后备 | 🔧 | 素材录音 / 音频转写的首选路线，有实测数据支撑 |
| 044 | 网关 200 空回包重发一次并写清上游；读失败的行不算缓存命中 | 🔧 | 仅当用到聚合网关；「失败结果不当缓存」通用 |
| 045 | 流转页改满幅信息流、吸顶、FAB | ⛔ | 交互专属 |
| 046 | 素材详情页收口 | ⛔ | 交互专属 |
| 047 | 思考 token 与正文共用 `max_tokens`：默认关思考并重估预算 | 🔧 | 用推理模型时必读 |
| 048 | 提示词要求引文用「」，`extractJson` 补转义内层引号 | 🔧 | LLM 出 JSON 的通用防线 |
| 049 | 视频按时长抽帧（曲线 + 封顶），超长建「跳过」行 | 🔧 | 素材视频（≤5 分钟）识别可简化沿用 |
| 050 | 视频口播整支交录音文件识别（mp4 是合法输入），不抠音轨不落桶 | 🔧 | 素材视频转写直接可用 |
| 051 | 抓抖音无水印视频走 App feed 接口；首次引入**队列级限速**；流式落桶 | 🔧 | 业务不适用；但「链接核验」若想自动取作品信息可参考（未公开接口，合规与稳定性风险自担）；限速与流式写入模式可用 |
| 052 | 抖音拆解改两阶段：先取真元数据再分析 | ⛔ | 业务专属 |
| 053 | 视频号支持与取数平台抽象 `MediaSource`；凭据等级决定降级边界 | 🔧 | 同上；抽象方式可借 |
| 054 | 抓抖音评论（web + X-Bogus）；不存昵称与用户 id | ⛔ | 业务专属；个保处理口径可参考 |
| 055 | 拆解读评论；幂等键 = 这次任务的输入 | 🔧 | 幂等键教训通用 |
| 056 | 只在 tab 页开转发，落点首页，不带参数 | 🔧 | 新产品要带渠道码 / 邀请码做来源追踪（PRD 6.1.4），结论相反，但「详情页转发别让人误会」的考虑可留 |
| 057 | 邀请卡片端上 Canvas 现画，失败回落固定图 | 🔧 | 店员邀请卡片可用 |
| 058 | 另配线路时 BASE_URL 与 API_KEY 成对校验，半配启动即失败 | ✅ | 「成对配置启动即失败」的模式通用（如支付商户号 + 证书 + APIv3 key） |
| 059 | 成片最小闭环一次建 8 张表；唯一约束做幂等；外键 RESTRICT；留证表只增不改；契约先行 api 暂不挂 | 🔧 | 表不适用；四条数据设计口径可用 |
| 061 | 自建 ffmpeg 分段渲染：独立队列并发 1、资源护栏、能力探测、CI golden、升级路径与迁移阈值 | 🔧 | V1.0 人工制作不需要；V1.1 批量合成 / 水印 / V2.0 自动化时是现成经验 |
| 062 | AI 显式标识做成 env 开关，开发期关、上线前开；CI 两种都跑 | 🔧 | 「合规项做成开关而不是删实现」；新产品 AI 标识与「广告」标识同样待法务定样式（PRD 12.3） |
| 063 | 管理后台挂在 api 进程里的极简控制台 | ⛔ | 形态不适用；安全模型沿用（见 §3） |
| 064 | worker 心跳写 Redis，`/health` 只回聚合值 | ✅ | |
| 066 | 后台批任务在同一队列上用 `priority` 排后，不另开队列 | ✅ | 例如「月度积分发放」排在交互任务之后 |
| 067 | 功能开关一处关住所有入队点；大文件上限与超时单列；`wx.downloadFile` 单次最大 200MB | 🔧 | **200MB 限制直接约束成片包下载设计** |

---

## 5. 文档与工程规范

### 5.1 文档目录（参考工程）

| 文件 | 内容 | 行数 |
| --- | --- | --- |
| `docs/00-project-plan.md` | 目标与原则 P1–P7、范围、选型定稿（带「差异」列）、系统架构、monorepo 结构、领域模型概览、接口规约、小程序规划、里程碑与任务拆分、质量门禁、环境变量、风险 R1–R12、待拍板项 D1–D10、版本变更 | 620 |
| `docs/01-srs.md` | 需求规格（FR / NFR 编号、状态图例） | 407 |
| `docs/02-architecture.md` | 架构总览图、运行时上下文、请求生命周期、认证、异步任务、直传；**ADR 表**；目录与依赖方向；安全边界 | 206 行 / 462KB |
| `docs/03-data-model.md` | 约定 + 按域列表结构 + 关系图；事实源声明为 `schema.prisma` | 318 |
| `docs/04-api-contract.md` | 通用规约、错误码、限流表、端点清单（带「已实现 / 已定义 / 规划」状态）、上传限制、工作流 | 379 |
| `docs/05-mobile-guide.md` | 小程序工程指南 | 325 |
| `docs/06-dev-guide.md` | 本地开发、命令、环境变量分组、测试策略、排错、开发者 CLI | 157 |
| `docs/07-platform-config.md` | 微信 / 腾讯云 / 阿里云 / 大模型控制台核对表 | 177 |
| `docs/08-deployment.md` | 部署手册、日常更新、回滚、运维 | 354 |
| `docs/09-qa-checklist.md` | 真机回归用例 | 332 |
| `docs/10-privacy-policy.md` | 隐私保护指引草稿 | 107 |
| `docs/11-douyin-extraction-api.md` | 抖音取数接口说明 | 520 |
| `AGENTS.md` | 协作规范（人与智能体）：技术栈固定表、目录、14 条硬性规则、端 / 服务端约定、命令、运维、文档同步 | 91 |

文档纪律（AGENTS.md §8）：改契约 → 04；改表 → 03；架构决策 → 02 追加 ADR（不改历史）；新增环境变量 → 06 与 `.env.example`。每份文档头部有「文档版本 / 编制日期 / 状态 / 上游或事实源」表。

### 5.2 ADR 写法与它的问题

- 约定：「编号 ADR-xxx 只增不改；被替代的决策标注 superseded」（`docs/02-architecture.md:95`）。
- 形式：一张五列表（# / 决策 / 结论 / 理由 / 日期），**一条 ADR 一行**。后期每条写得很长（**背景 / 决定 / 理由**，带实测数字与被推翻的旧判断）。
- 问题（核对所得）：
  1. Prettier 会把 Markdown 表格按最宽单元格补齐空格，导致这张表每行 6.6KB–8.4KB，整个文件 206 行却有 **462KB**，常规工具无法整文件读取、diff 不可读。ADR-067 起已改成「小节 + 段落」（`docs/02-architecture.md:171-175`）。
  2. **ADR-030 重号**：两个并行分支各取了同一个空号，事后不改号（已写进迁移与注释），只能加「编号说明」。
  3. ADR-060、065 空号；ADR-063 那一行缺「理由 / 日期」两列。
  4. 大量 ADR 是 UI / 交互细节（039、040、045、046、056、057），与架构决策混在一起，稀释了真正的架构决策。

【推断】新项目建议：一条 ADR 一个文件（`docs/adr/NNNN-标题.md`，含状态、背景、决定、理由、影响、替代方案），`docs/02-architecture.md` 只留索引表（短行）；编号在合并时分配或由 PR 号派生以避免并行撞号；交互决策另放（如 `docs/design-decisions.md`）；把 `docs/adr/` 之外的宽表格加进 `.prettierignore` 或避免长单元格。

### 5.3 提交与分支规范

- conventional commits（`commitlint.config.js` 继承 `@commitlint/config-conventional`；`.husky/commit-msg` 跑 `pnpm commitlint --edit`）。实际提交用 `type(scope): 中文一句话`，类型分布：feat 97 / fix 92 / docs 49 / refactor 9 / chore 7 / test 6 / ci 2 / perf 1（不含合并提交）。
- 功能与修复在 `feat/*` / `fix/*` 分支，起 PR，CI 通过后合并，不直接推 main（AGENTS.md 规则 12）；约 110 个 PR、120 个合并提交。
- `.husky/pre-commit` 只跑 `lint-staged`（ESLint --fix + Prettier），**不含 typecheck / test**；规范要求本地提交前手动跑 `pnpm typecheck && pnpm test`。
- 改 `schema.prisma` 必须附迁移；改契约必须附生成产物。

### 5.4 质量门禁

- 本地：`pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm contract:check`（README）。
- CI（`.github/workflows/ci.yml`）`verify` job：带 postgres:16 与 redis:7 服务 → `prisma validate` → `migrate deploy` → lint → format:check → typecheck → test → contract:check → build api / worker。另有 `render` job（ffmpeg golden）。同一 ref 新推送取消旧运行。
- TS 预设（`packages/config/tsconfig/base.json`）：`strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`、`verbatimModuleSyntax`、`module: NodeNext`、`noEmit`。
- ESLint：禁 `any`、强制 `import type`、禁 `console.log`、禁 axios；小程序目录禁 `window / document / localStorage / fetch`。
- 未做：覆盖率门槛、依赖方向检查、小程序自动化测试、密钥扫描。

### 5.5 新项目 docs/ 如何对齐（建议）

【推断】沿用编号文档族 + 头部信息表 + 「事实源」声明 + 文档同步纪律；按新产品两端调整：

```
docs/
  00-project-plan.md        原则、范围、选型定稿、里程碑、风险、待拍板项
  01-requirements.md        指向 PRD（外部 artifact）的需求追踪：FR 编号 ↔ PRD 章节 ↔ 画板 ↔ 状态
  02-architecture.md        架构总览 + ADR 索引（短表）
  adr/NNNN-*.md             一条一个文件
  03-data-model.md          事实源 = schema.prisma
  04-api-contract.md        规约、错误码、限流、端点清单（商家端 / 运营端分节）
  05-miniapp-guide.md       商家端小程序工程指南
  06-admin-web-guide.md     运营后台前端工程指南（新增）
  07-dev-guide.md           本地开发、环境变量、测试策略、CLI
  08-platform-config.md     微信小程序 / 微信支付 / 企业微信 / 云厂商 / 短信 控制台核对表
  09-deployment.md          部署与运维
  10-qa-checklist.md        验收用例
  11-security-compliance.md 权限矩阵落地、审计、数据脱敏、合规项开关（新增）
AGENTS.md                   协作规范（技术栈固定表 + 硬性规则）
```

---

## 6. 踩过的坑与教训

来源：ADR 正文、`docs/06` / `docs/08`、代码注释、`git log` 标题。按主题归并，每条附出处。

### 6.1 部署与运行

1. **改了 `.env` 不等于线上生效**：`pm2 reload --update-env` 刷不掉 `dump.pm2` 里的旧 env 快照，2026-09-08「换模型上线」静默失效一整天，而 `.env`、文档、代码三处都显示已切换。现在的脚本是 `delete + start + save`，并逐进程核对 `/proc/<pid>/environ`（`docs/08-deployment.md:307-320`；提交 `5b3e38f fix(infra): 部署重建 PM2 进程并核对进程环境`）。另：`dump.pm2` 明文存着 API key。
2. **部署前先校验 env**：api / worker 启动时 `loadEnv` 不过就起不来、被 PM2 反复拉起；所以在迁移和删旧进程之前先用新构建跑 `check-env`（`apps/api/src/check-env.ts`；`eb869f0`）。
3. **部署脚本要防打断、可钉版本**：`DEPLOY_REF`、临界区不理 Ctrl+C、放进 tmux 跑、整段逻辑放函数里最后才调 `main`（因为 `git checkout` 会改写脚本自身）（`infra/deploy.sh:1-16`）。
4. **小内存机器的资源争用**：2 核 1.8G 上构建会被 OOM killer 打断，要先挂 swap；构建与渲染不能同时跑，所以部署时暂停 render 队列；启动时的补封面任务推迟 30 分钟（`docs/08-deployment.md:33-35`；`apps/worker/src/index.ts:169-187`）。
5. **重复的安全头**：nginx 与 api 都发 HSTS 会收到两个头（`c4f8a8e`；`infra/nginx-api.conf:38-40`）。
6. **远程执行别用 heredoc 喂 stdin**：脚本本身就是 stdin，被里面读 stdin 的命令吞掉，输出静默截断（「踩过三次」，`docs/06-dev-guide.md` §7）。
7. **文档与生产形态漂移**：规划写「腾讯云 CVM + Caddy」，实际是「阿里云 ECS + 宿主机 nginx」，直到 2026-09-16 才统一校正（提交 `07e6bae docs(deploy): …按生产形态校正`；AGENTS.md §7）。`apps/worker/package.json` 的 description 至今仍写三条队列，`rate-limit.ts:48` 注释仍写 Caddy。
8. **异地备份没做**：每日 `pg_dump` 落在本机，保留 14 天，「异地副本（COS 私有桶）还没做」（`docs/08-deployment.md:340`）。新产品要求「每日备份，保留 30 天」（PRD 10.2）。

### 6.2 队列与异步

9. **BullMQ 同 jobId 静默去重**（本仓踩 4 次）：幂等键必须等于「这次任务的输入」；重试、补推、手动重跑都要换键（ADR-055；`render.service.ts` 注释；`3ba1947 补推换 jobId`、`cfcb58b 超时换 jobId 补推`）。
10. **jobId 不能含冒号**（`ai-jobs.service.ts:83-85`）。
11. **队列 attempts 与库里的终态判定必须一致**（`queue/queues.ts:99-104`）。
12. **worker 被 SIGKILL 时处理器的收尾一行都跑不到**：失联次数要由补偿扫描自己记（`docs/06-dev-guide.md` §7 末；`4741b06`）。
13. **在途的任务别被补偿扫描当成卡住**，否则唯一的告警信号被刷成常态（ADR-066）。
14. **订阅消息字段名必须对齐真实模板**，否则「发一条挂一条」（`a2a14d8`、`f8df8f0`、`04ae923`）；订阅消息是一次性授权，要事先拿授权（ADR-030b）。
15. **并发不能代替限速**：保护自己用 concurrency，保护上游用 limiter（ADR-051）。

### 6.3 数据与契约

16. **外部字符串写进定宽列 → 500**：跳转后的超长 URL 溢出 varchar（`05372f2`、`504f854 url 放宽为 TEXT`）；HEAD 回来的 Content-Type 也要归一化截断（`media.service.ts:116-124`）；`c9d816f unit_key 收敛`。
17. **id 超出 BIGINT / version 超出 int4 → 500**：收紧 `IdSchema` / `VersionSchema`，并在错误中间件加第二道保险（`6ad3dca`、`e5c17ca`、`bd5d40f`、`bf2f232`）。
18. **路由写了却没进 `allRoutes`**：线上能用但生成物与 `/docs` 里看不到，后来加了测试钉住（`48f0c40`；`contract.test.ts:103-117`）。
19. **OpenAPI 生成的两个陷阱**：`z.coerce.number()` 的路径参数被判成可空；`.nullable()` 的命名组件会把组件本身登记成可空（`0780602`；`contract.test.ts:125-148`）。用 `.max()` 会改生成物，所以范围用 `refine`（`common.ts:5-9, 19-23`）。
20. **路由注册顺序**：静态段要排在参数段之前（`packages/contract/src/index.ts` 注释、`apps/api/src/routes/archive.ts`）。
21. **Prisma `contains` 不转义 LIKE 通配符**，搜「100%纯棉」会捞回全部；jsonb 数组子串匹配要用原生 SQL（ADR-036）。
22. **`pg_advisory_xact_lock` 必须在交互式事务里拿**，在普通客户端上语句一结束锁就放了且不报错（`draft.service.ts:174-195`）。
23. **Prisma 7 不再自动读 `.env`**，`?schema=` 也不被 pg 驱动识别（`packages/db/prisma.config.ts:5-9`、`packages/db/src/index.ts:13-36`）。
24. **时间必须带时区**：`new Date("2026-10-08")` 是 UTC 零点，法务记录会差 8 小时（`apps/api/src/routes/admin.ts:98-103`）；「哪一天」由服务端按应用时区算（ADR-036）。
25. **测试库隔离**：`resetDatabase` 只允许 `test_*` schema（`dc2dc14`、`60a793e`；AGENTS.md 规则 14）。

### 6.4 原则与现实

26. **原则 P5「国内可达」在生产被打破**：LLM 主链路 / 视觉 / 音频都走境外 OpenRouter，P02「境内模型」至今未做，隐私政策须如实披露（`docs/00-project-plan.md` §10 现状、R10）。
27. **合规项被推迟**：成片显式 AI 标识生产仍关着（R12）；隐私政策、广告法词表、角标数值都在「待律师定稿」。
28. **短信从未在生产启用**（驱动仍是 console，`docs/02-architecture.md:60`）。
29. **调研结论被推翻过多次且都如实记在 ADR 里**（ADR-043、050、051、053）：先实测再下结论，推翻时写明错在哪。这个习惯值得保留。
30. **免费 / 聚合网关的坑**（仅当新项目用 LLM）：`:free` 模型硬额度、200 空回包、思考 token 吃预算、引文引号破坏 JSON（ADR-038、044、047、048）。

### 6.5 小程序平台约束

31. **`wx.downloadFile` 单次最大 200MB**；存相册必须先 downloadFile（ADR-067）。
32. **直传需要把对象存储域名加入 uploadFile / downloadFile 合法域名**，POST policy 细节易错（`docs/00-project-plan.md` R2）。
33. 主包体积、分包、`lazyCodeLoading`（Phase 4.2）；小程序退后台录音会被挂起（R3）。

---

## 7. 领域差异导致「不能照搬」的地方

对照新产品 PRD（`scratchpad/src/PRD.md`，下称 PRD）与两套原型画板清单。左列是新产品要求【资料】，中列是参考工程现状【核对】，右列是结论【推断】。

| # | 新产品要求 | 参考工程现状 | 结论 |
| --- | --- | --- | --- |
| 1 | **微信支付**：套餐与加购积分付款、原路退款、每日账单对账；**对公转账**凭证 + 财务确认（PRD 2.1、6.15、7.5、7.9） | `WechatProvider` 只有 code2session / getPhoneNumber / 订阅消息 / 内容安全四个方法（`providers/types.ts`）；全仓无支付相关代码 | 全新：PayProvider、付款单、支付回调（验签、幂等、原始请求体）、退款单、对账任务与差异处理 |
| 2 | **积分账本**：套餐积分（按月发放、周期末清零）+ 加购积分（长期有效、过期冻结）；冻结 → 扣减 → 退回；先扣快到期的；跨周期冻结；手动调整审批（PRD 2.3、2.4、2.7、2.8、7.3.5） | 只有常量 `LIYO_POINTS_GRANT = 8000`，「计费未上线、不扣减」（`packages/shared/src/constants.ts:45-55`；`identity.service.ts:415`） | 全新：按主体的积分账户、分批次（来源 + 到期日）余额、流水（发放 / 冻结 / 扣减 / 退回 / 清零 / 调整）、强一致事务与行锁、与订购单 / 广告任务的业务键幂等 |
| 3 | **金额与收入口径**：月费、差价按天折算、退款、发票、预收款与收入确认、积分负债报表（PRD 2.2、2.9、7.9、7.10） | schema 无 Decimal 列、无任何金额字段（`grep Decimal schema.prisma` = 0） | 全新：金额统一用整数「分」或 Decimal；四舍五入规则集中一处（PRD 2.4 的 `round`） |
| 4 | **两层租户**：经营主体（营业执照）→ 门店 → 成员；套餐 / 积分 / 合同 / 发票挂主体，订单 / 工单 / 素材 / 发布账号挂门店；门店数与成员名额受套餐限制（PRD 2.2、6.16） | 单层 `ips` + `ip_members`；一切资源挂 `ip_id` | 模型重做；`assertMember` 的思路（服务层断言 + 行级归属 + 停用闸门）沿用 |
| 5 | **商家侧角色**：老板 / 店员（V1.1 管理员、服务商）；店员看不到金额与积分（PRD 3.1、6.16.2） | 线性四级 rank | 改成权限点 + 可见性规则；DTO 需按角色裁剪字段 |
| 6 | **平台 RBAC**：8 类岗位、菜单 + 按钮 + 数据范围、主管看本组、敏感操作二次确认 + 审批 + 留痕（PRD 3.2、3.3、7.12） | 后台无角色无权限（§3.2） | 全新：员工、角色、权限点、数据范围、审批单、操作日志 |
| 7 | **PC 运营后台 56 个画板**，所有列表筛选 / 分页 / 导出（PRD 7、8.2） | 284 行 HTML 字符串，3 个面板 | 新建 `apps/admin` SPA 工程；新增导出能力（异步任务 + 签名下载） |
| 8 | **大体积视频**：短剧每集原片、预告片、样片、成片包；素材视频「单条不超过 5 分钟、500MB」（PRD 6.16.3）/「视频单个不超过 200MB，支持断点续传」（PRD 10.1）；多码率自适应、CDN、首帧 ≤1.5s（PRD 10.1） | 单次 presigned POST，视频默认上限 50MB；无分片、无转码、无 CDN 鉴权 | 存储层重做：分片 / 断点续传（小程序端与浏览器端各一套）、转码与多码率（云点播或媒体处理）、CDN |
| 9 | **视频防护**：预告片与样片加水印、播放地址签名有效期、防盗链；成片包下载链接签名 7 天有效、仅订单商家可下载（PRD 10.2） | 公有读桶 + 随机 key（ADR-008）；`StorageProvider` 无签名读 | 一开始就用私有桶 + 签名 URL / CDN 鉴权；下载授权按订单归属断言 |
| 10 | **成片包下载**：按集下载或打包下载（PRD 6.10.1） | ADR-067 实测 `wx.downloadFile` 单次 ≤200MB | 小程序内只能按集下载；「打包下载」需另想办法（复制链接到浏览器 / 网盘式分享），需产品确认 |
| 11 | **订单与交付工作流**：订购单状态流转、交付工单（方案 → 广告 → 合成 → 质检 → 样片 → 成片）、发布任务、链接核验、下架核查、巡检（PRD 5.2、5.3、7.6、7.7） | 有成片草稿状态机与补偿扫描（`studio/draft-state.ts`、`compensate.ts`），但业务完全不同 | 状态机写法、「锁 + 状态迁移 + 留痕」模式可借；业务全新 |
| 12 | **客服工单**：优先级、轮流自动分配、转派、SLA 超时升级、3 天自动解决（PRD 7.8） | 无 | 全新；SLA 用定时扫描实现 |
| 13 | **通知**：订阅消息 + 短信；到期 / 上线 / 下架多节点提醒；企业微信联系（PRD 2.2、6.10.1、7.11.4、7.12.1） | 订阅消息有 push 队列与三个模板位，字段已按真实模板对齐过（提交 `a2a14d8`、`f8df8f0`）；短信驱动有代码但生产是 console；无企业微信 | 订阅消息与 push 队列可沿用；短信要补生产验证；企业微信全新；需要统一的通知服务与模板管理 |
| 14 | **资质审核与 OCR**：营业执照、食品经营许可证识别后核对（PRD 6.3.4、7.4.3） | 有「识图同步直出表单草稿」（ADR-037），用的是通用视觉模型 | 形态可借，能力建议换专用 OCR |
| 15 | **门店素材自动处理**：六类素材、自动转写、识别内容、打标签（PRD 6.16.3） | 素材理解管线完整（`ai/media-understanding.ts` 833 行；ASR、视觉、文档抽取、封面） | **可调整后复用**，是最大的一块可复用业务资产；注意境内模型与隐私披露（§6.4 第 26 条） |
| 16 | **内容配置**：Banner、推荐位、协议版本管理（变更后重新同意）、数据字典、参数配置（PRD 7.11、7.12） | 无；参数全在 env | 全新：运营可改的参数要落库，不能继续用 env |
| 17 | **数据报表与埋点**（PRD 7.10、第 9 章） | 无 | 全新；报表口径依赖积分流水与订单事实表的设计 |
| 18 | **合规**：许可信息与版权有效期管理、授权书按订购生成、广告标识、AI 标识、操作日志保留 ≥3 年（PRD 7.2、10.3、7.12.5） | 仅有 AI 标识开关（ADR-062）与后台审计表 | 模式可借；文档生成（授权书 PDF）全新 |
| 19 | **可用性**：99.9%、核心接口 P95 ≤500ms、每日备份保留 30 天（PRD 10.1、10.2） | 单机 2 核 1.8G、worker 单实例、备份只在本机 | 部署形态需重新决策（至少托管数据库 + 异地备份 + api 多实例） |
| 20 | **登录**：微信手机号快捷登录，一个手机号一个账号（PRD 6.1） | 微信静默登录 + 一键手机号 + 短信兜底 + 凭证合并规则（`identity.service.ts` 506 行） | 身份服务可裁剪复用（以手机号为主键简化合并规则） |
| 21 | **来源追踪**：渠道码 / 邀请码，记录注册来源用于业绩归属（PRD 6.1.4；V1.1 返佣） | ADR-056 明确「不带分享人 id、不做来源统计」 | 结论相反，需新建归因字段与规则 |
| 22 | V1.1 **服务商**：代开通、代订购、返佣结算、数据范围（PRD 2.10、7.13） | 无 | V1.0 的数据模型要预留「商家归属服务商」「代操作人」字段（只留位，不建功能） |

---

## 8. 对新项目的沿用清单（建议）

【推断】供架构设计直接引用。

**直接沿用（拷骨架）**
- 根配置：`package.json` scripts 结构、`pnpm-workspace.yaml`（含 `onlyBuiltDependencies`）、`.npmrc`、`.nvmrc`、`tsconfig` 预设、`eslint.config.js`、Prettier、commitlint、husky + lint-staged、`vitest.config.ts`（projects）、`.github/workflows/ci.yml` 的 verify job。
- `packages/contract` 的 `common.ts` / `errors.ts` / `scripts/generate.ts` / `contract.test.ts` 骨架。
- `packages/services` 的 `errors.ts`、`logger.ts`、`config/env.ts` 写法、`providers/unconfigured.ts` 模式、`queue/*`、`health/*`、`identity/jwt.ts` + `tokens.ts`、`media/media.service.ts`、`providers/storage/s3.ts`（作为起点）、`providers/wechat/wechat.ts`、`providers/sms/*`、`providers/asr/tencent.ts`、`testing/*`。
- `apps/api` 的 `app.ts` 结构、全部 middleware、`server.ts`、`check-env.ts`、测试 harness。
- `apps/worker` 的 `index.ts` 结构、`schedules.ts`、`queue-admin`。
- `infra/deploy.sh` + `check-proc-env.sh` + 其测试（如果仍用 PM2）。
- `packages/shared` 的 `id.ts`、`assert.ts`、`time.ts`、`uploads.ts` 登记表模式。
- AGENTS.md 的 14 条硬性规则（逐条适用，第 8 条 axios 禁令对后台 SPA 是否保留需确认）。

**调整后沿用**
- 后台认证：ADR-063 的安全模型 → 扩成员工体系 + RBAC。
- 租户与权限：`assertMember` → 主体 / 门店两层 + 权限点 + 数据范围。
- 存储：公有读 → 私有桶 + 签名读 + 分片上传 + 转码。
- 任务状态表：`ai_jobs` → 通用 `jobs`。
- 素材理解管线：expressions → 门店素材。
- 限流：修 XFF 取值与原子性；为支付回调与导入导出开例外通道。
- refresh 轮换：放进事务并加重放检测（后台不用 JWT）。

**全新建设**
- 支付、付款单、退款、对账、发票；积分账户与流水；套餐生命周期（开通 / 续费 / 升降级 / 到期）；订购单与交付 / 发布 / 下架工作流；客服工单；审批流；RBAC；操作日志；导出；报表；内容与参数配置；`apps/admin` 前端工程；通知中心；授权书生成。

---

## 9. 风险与待拍板（汇总）

### 9.1 技术风险 / 与 PRD 的冲突

1. 参考工程的存储是公有读桶（ADR-008），与 PRD 10.2 的签名播放 / 签名下载 / 防盗链冲突；沿用代码会留下合规缺口。
2. 参考工程直传只有单次 presigned POST、视频默认 50MB；PRD 要 200MB–500MB 且断点续传，后台还要传整部剧的原片与成片。
3. `wx.downloadFile` 单次 ≤200MB（ADR-067）与 PRD 6.10.1「打包下载」冲突。
4. 参考工程没有任何资金 / 积分一致性实践（无 `FOR UPDATE`、无 Decimal、无 outbox），积分冻结扣减与支付回调是全新高风险区。
5. 单机 + worker 单实例的部署形态达不到 PRD 10.1 的 99.9%；定时任务若仍假设「只有一个 worker」，扩容时会重复发放积分 / 重复提醒。
6. 短信链路未经生产验证；订阅消息需事先授权、一次一发，覆盖不了「7/3/1 天」多节点提醒的全部触达。
7. 按 IP 限流可被伪造 `X-Forwarded-For` 绕过（`rate-limit.ts:49-53` + `nginx-api.conf:53`）；登录与短信接口受影响。
8. `requireAuth` 不查账号状态，禁用后 2h 内 token 仍有效；refresh 轮换非原子、无重放检测。
9. 依赖方向没有工具强制；新增 `apps/admin` 后更容易被破坏。
10. ADR 大表格式不可维护（462KB / 206 行），并发撞号；照搬会重蹈覆辙。
11. 参考工程生产 LLM 走境外网关（违背其自身原则 P5）；新产品若复用素材理解管线处理门店素材（可能含顾客肖像、证照），数据出境与隐私披露风险更高。
12. `apps/api` 1MB 请求体 / 30s 超时 / nginx 2MB 的加固，会挡住支付回调之外的 Excel 导入与大列表导出，需要异步化设计。
13. 后台审计表的 `ip` 列在参考实现里实际未写入（`routes/admin.ts:49-52`），照抄会得到一张缺来源 IP 的操作日志。

### 9.2 需要拍板的问题

1. 运营后台前端技术栈与部署方式（独立 SPA、是否与 api 同源、是否继续「不开 CORS」）。
2. 视频存储与分发方案：对象存储 + 自建转码，还是云点播（转码 / 多码率 / 水印 / 防盗链一体）；云厂商选型（参考工程是阿里云主机 + 腾讯云 COS 跨云）。
3. 素材视频上限到底是 200MB（PRD 10.1）还是 500MB（PRD 6.16.3）；断点续传是否 V1.0 必须。
4. 成片包「打包下载」在小程序内如何实现（受 200MB 限制）。
5. 部署形态：是否仍单机 PM2；数据库是否上托管 RDS；是否一开始容器化；99.9% 是硬指标还是建议值。
6. 积分与金额的数据类型与取整规则；积分账本是否按「批次」建模以支持「先扣快到期的」。
7. 支付回调 / 积分 / 通知之间用「提交后入队 + 补偿扫描」还是 transactional outbox。
8. 商家端是否沿用 JWT 双 token；后台是否用 Redis 会话 + TOTP（对应 PRD「登录须二次验证」），还是企业微信扫码登录。
9. V1.0 是否上素材自动转写 / 识别（PRD 6.16.3 写了自动处理）；若上，模型与 ASR 用哪家、是否必须境内。
10. 店员邀请是否定向到手机号（参考工程 ADR-029 的安全考虑 vs PRD 的「卡片发给微信好友」）。
11. V1.0 数据模型为 V1.1 服务商预留到什么程度（归属、代操作人、返佣基数）。
12. ADR 的组织形式（单文件 vs 一条一文件）与编号分配规则。
13. 运营可调参数（积分价、折扣、提醒节点等）落库后的生效时间与变更留痕口径（PRD 要求「调价只影响之后提交的订购」）。
