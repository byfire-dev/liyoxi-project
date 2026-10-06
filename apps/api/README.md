# apps/api：接口进程的骨架

W0-22 交付骨架，W0-22b 交付限流与中间件的装配顺序。各域的接口包往后只写“一条契约路由配一个薄壳处理器”，其余由骨架给。依据：[约定](../../docs/api/00-conventions.md) C1、C7、C17–C27、C47–C50、C75；[h01](../../docs/api/h01-hooks.md) 第 2.5、3.11–3.15 节；D7 第 2.2、2.3、3.1、9.1、9.5 节；任务书 `docs/plan/tasks/W0-22.md`。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `src/server.ts` | 进程入口：读环境变量 → 建运行时 → 建应用 → 启动自检 → 监听；收到 SIGTERM 排空后退出 |
| `src/check-env.ts` | 只校验环境变量的入口（发布时先跑它） |
| `src/app.ts` | 应用的装配：全局中间件、探活、四组、出错与 404 |
| `src/http/` | 请求编号、访问日志、客户端 IP、Host 判断、入参校验、错误映射与成功体、限流与额度表、幂等上下文 |
| `src/routing/` | `defineHandler`、挂载与“声明即挂载”的核对、装配顺序与登记表（`pipeline.ts`）、规则表 |
| `src/routes/index.ts` | 全部处理器的清单，各域加一行 |
| `src/probes.ts` | 探活 5 条 |
| `src/testing/` | 接口测试支架 |
| `scripts/build.mjs` | 构建 |

业务逻辑不在这里：数据库、Redis、事务入口、配置、健康检查的取数都在 `@liyoxi/services` 的进程运行时（`packages/services/src/runtime.ts`）。本包不引 `@liyoxi/db`。

## 2. 写一条接口

```ts
// src/routes/<域>.ts
export const orderHandlers = [
  defineHandler(orderCreateRoute, async (c) => {
    const input = c.req.valid("json"); // 已按契约校验
    const { runtime, identity } = c.var;
    const order = await submitOrder(runtime, identity, input, { idem: idemOf(c) });
    return ok(c, order); // { code: 0, message: "ok", data }
  }),
];
// src/routes/index.ts 里加一行：...orderHandlers
```

- 路由对象取自 `@liyoxi/contract`（构造器的产出），元数据与结构都以契约为准。
- 出错就抛 `AppError("符号名")`：状态码、数值码、可否重试按契约的表出。别的错误一律 500 `INTERNAL`，不带内部信息。
- 写用例把 `idemOf(c)` 交给 `runtime.tx.run(fn, { idem })`。`required` 的路由没交即报错（防漏用）。一个上下文只进一次 `tx.run`；接口层不在进程内重试 `BUSY`，由端上重试。
- 接口层测试放本包的 `*.test.ts`，用 `useTestApi()`；用例里以字符串字面量写出 operationId（“已落地”的判定按它认）。

## 3. 声明即挂载与装配顺序

建应用时逐条核对：路由声明了什么，它的中间件链里就得有对应的槽位（`src/routing/requirements.ts`）。漏了即抛 `MountError`，进程起不来，问题一次列全。

| 声明 | 要有的中间件（槽位） | 现状 |
| --- | --- | --- |
| `x-auth` 不是 `public`、`signed` | `auth` | 商家与后台有（W1-04、W1-01a）；下载页没到 |
| `x-auth: signed` | `signature` | 没到（回调验签） |
| 设了能力点或权限点（不含 `assert-in-handler`） | `authz` | 商家与后台有（W1-04、W1-01a）；其余没到 |
| 限流档位（每条路由都有，见 3.2） | `rateLimit` | 有 |
| `x-idempotent`；三段式（`x-three-phase` 或约定 C51 的登记） | `idempotency` | 有 |
| `x-auth: member` | `membership` | 有（W1-04） |
| 后台的非 GET 路由（约定 C4） | `csrf` | 有（W1-01a） |
| 后台路由的 `x-permission` 标了再验证、没有声明 `x-step-up: skip` | `stepUp` | 有（W1-01a） |

商家与后台的鉴权链分别见第 7、8 节。

新的声明（开关、再验证等）由交付它的包往规则表里加行。入参校验不在表里：它由 `app.openapi()` 按契约的 `request` 结构自带。挂载器按同组、同方法的路径段排序，固定段优先于 `{param}`，参数名不影响后续固定段的优先级，避免 `/summary` 被动态 UUID 路径抢先校验；路由内中间件链仍只按 PIPELINE_ORDER。

### 3.1 装配顺序：只在 `src/routing/pipeline.ts` 一处

- `PIPELINE_ORDER` 是槽位的先后（约定 C7，加上 D4 第 7.4 节的后台三件）：`versionGate` → `surface` → `auth` → `signature` → `membership` → `consent` → `csrf` → `authz` → `stepUp` → `featureFlag` → `rateLimit` → `idempotency`。全局的四件（请求编号 → 访问日志 → 客户端 IP → Host 判断）在 `app.ts`，排在它们之前；入参校验排在它们之后。
- `ROUTE_MIDDLEWARES` 是登记表，一件一行：槽位、适用的组（不写即四组都给）、工厂。链的先后只看槽位，不看登记在第几行。
- 加一件中间件：在 `src/http/` 下写自己的文件，导出一个 `RouteMiddlewareFactory`（`(route, runtime) => 处理函数 | null`，这条路由用不着就返回 `null`，配置不对就抛错），在 `ROUTE_MIDDLEWARES` 末尾加一行。鉴权按组各一条链：商家、后台、下载页各登记一行并写 `groups`。不改 `PIPELINE_ORDER`，不在别处 `app.use()`（`test/pipeline.test.ts` 会扫）。
- 同一个槽位同一组登记了两件、槽位不在顺序表里：建应用即失败。要加一种新的中间件，先在 `PIPELINE_ORDER` 里给它排位。
- 鉴权链除了 `c.var.identity`，把会话行的 id 放进 `c.var.sessionId`（按会话限流的档位用它）；客户端 IP 取 `c.var.clientIp`，不自己读转发头。

### 3.2 限流

- 档位按 operationId 登记在契约里（`packages/contract/src/routes/rate-limits.ts`，对应约定 C68 的表）。一条路由的生效档位 = 名下登记了它的专用档位 + 它自己写的 `x-rate-limit` + 所在组的缺省档位（`m.global`、`admin.global`、`portal.global`；回调是 `hooks.ip`），同时生效。根路径探活不限流。
- 额度在 `src/http/rate-limit-quotas.ts`（初始值照约定 C68）：每个档位几条规则，各写按什么数（来源 IP、用户、会话、路径参数）、一个窗口几次。档位没有额度，api 起不来。
- 超限回 429 `RATE_LIMITED`，带 `Retry-After`（超限窗口的剩余秒数），并记一条 `evt: ratelimit.hit` 的日志（带档位）。限流排在幂等上下文之前。
- 计数在 `runtime.rateLimiter`（`packages/services/src/rate-limit.ts`）：Redis 上的固定窗口。Redis 命令报错或 200 毫秒没回：改用进程内计数、限额减半，随后 5 秒不再试 Redis（日志 `ratelimit.degraded`、`ratelimit.restored`）。
- 加一条要单独限流的接口：把 operationId 写进契约里对应的档位；新档位另在额度表里加一项，同 PR 改约定 C68 的表。
- 用例里：每个 `testApi.start()` 出来的应用有自己的来源 IP，互不挤占额度；`rateLimitQuotas` 换小额度，`request(path, { peer })` 换来源，`redisUrl` 配故障注入的转发口（`createRedisOutage`）验降级。

## 4. 探活

| 路径 | 语义 |
| --- | --- |
| `/healthz` | 进程能应答即 200 |
| `/readyz` | 启动完成且未在排空才 200，否则 503；不看数据库与 Redis |
| `/health` | 聚合状态；`degraded` 回 503 |
| `/internal/health/finance`、`/internal/health/flow` | 只有框架：各指标为 `null`，回 503。留桩见 `docs/plan/stubs/` |

## 5. 命令

```sh
pnpm exec vitest run --project api      # 本包的用例（要本地的 PostgreSQL、Redis 与连接参数，CLAUDE.md 第 9 节）
pnpm --filter @liyoxi/api build         # 出 dist/server.js、dist/check-env.js
node apps/api/dist/server.js --port 3000 --trusted-proxy-hops 1 --trusted-proxy-cidrs 10.0.0.0/8
```

- 构建：`@liyoxi/*` 内联，第三方包留给运行时从 `apps/api/node_modules` 解析，所以产物引到的第三方包都要写进本包的 `dependencies`（源码里不引；构建完会核对）。镜像标签取构建环境的 `LYX_BUILD`，没给即 `dev`。
- 已挂载清单 `dist/mounted-operations.json` 由 `test/probes.test.ts` 写出，随 `pnpm test` 生成；`node infra/ci/landed.mjs --check` 读它。文件不入库，没有它时探活 3 条按待落地算，所以待落地基线本包没有降（留在 613；状态文件偏差 13）。
- 监听端口走命令行参数（`--port`，缺省 3000；`--host`，缺省 `0.0.0.0`），不是环境变量。
- 客户端 IP 按可信代理的跳数取（D4 第 9.5 节）：对端在可信网段内才看 `X-Forwarded-For`，从右数第 N 个。`--trusted-proxy-hops` 缺省 1，`--trusted-proxy-cidrs`（逗号分隔）缺省回环与私有网段；负载均衡的回源网段在预发实测后照实填。请求协议共用同一信任边界：跳数大于 0 且套接字对端可信时，才采纳单值 `http`、`https` 的 `X-Forwarded-Proto`；直连优先看连接是否 TLS，无连接对象时取请求 URL，结果放在 `c.var.requestProtocol`。

## 6. 已知的限度

- Host 判断只看域名的第一段（`api`、`admin`、`portal`），不比完整域名；完整的一层在网关。
- 回调的应答要按 Provider 的协议：处理器里自己接住错误再应答，抛出去的会变成通用的错误体。
- `fieldErrors` 的文案是 Zod 的原文（契约里没给中文文案的字段是英文）。
- 限流的额度是代码里的初始值（`rate-limit-quotas.ts`），还没接成按环境可调的配置；手机号登录的“每 openid”一条、短信的号码限频、账号锁定不在中间件里，由各自的域按数据库计数。
- 没有事件循环看门狗；排空时不等负载均衡摘节点，等待时长由发布编排定。

## 7. 商家鉴权链（W1-04）

五件都登记在 `ROUTE_MIDDLEWARES`，只给 `m` 组；`x-auth: member` 另要求有 `membership`：

| 槽位 | 文件 | 做什么 | 哪些路由不挂 |
| --- | --- | --- | --- |
| `versionGate` | `src/http/version-gate.ts` | `X-Client-Version` 低于开关 `client.min_version` 回 426 `CLIENT_OUTDATED`；没带或写法不对的按 `0.0.0` 算 | 契约 `VERSION_GATE_EXEMPT_OPERATIONS` 的 5 条 |
| `auth` | `src/http/merchant-auth.ts` | `Authorization: Bearer <令牌>`，每请求点查会话。没带回 401 `AUTH_REQUIRED`，无效回 401 `SESSION_INVALID`；`optional` 路由上没带或无效都按匿名 | `public`、`signed` |
| `membership` | `src/http/merchant-membership.ts` | `X-Store-Id` 现查成员关系：缺失或进不去回 403 `NOT_A_MEMBER`；店员调 `x-clerk-view: none` 的路由回 403 `ROLE_FORBIDDEN` | 不是 `member` 的 |
| `consent` | `src/http/merchant-consent.ts` | 登录用户有未同意的现行用户级协议回 428 `CONSENT_REQUIRED`，`details.pendingConsents` 给出缺的协议。常态只比指纹，不查同意记录 | `public`、`signed`；契约 `CONSENT_WHITELIST_OPERATIONS` 的 9 条 |
| `authz` | `src/http/merchant-membership.ts` | 按路由的 `x-capability` 查能力点矩阵：店员没有回 `ROLE_FORBIDDEN`，已停用门店的老板超出收尾范围回 `STORE_ARCHIVED` | 没声明能力点、或声明 `assert-in-handler` 的 |

- 这几件都排在限流与幂等上下文之前：401、403、426、428 不落幂等行，“同意后用同一个键重放”沿用原来的键。
- 处理器里取当前会话用 `merchantSessionOf(c)`；`member` 路由上 `c.var.identity` 带角色、主体与门店，`c.var.membership` 是成员关系（`storeMode` 为 `archived` 即收尾上下文）；要数据范围用 `@liyoxi/services` 的 `storeScopeOf(c.var.identity)`、`entityScopeOf(…)`。
- 商家端各域的服务从 `merchantServicesOf(c.var.runtime)` 取（`src/merchant/services.ts`：`identity`、`tenant`、`docs`），一个运行时建一次。微信能力取运行时上的 `providers.wechat`（local、test 是本地的假微信，用例经 `createRuntime` 的 `providers` 换成替身；真实驱动到位之前 stg、prod 是未配置的那一个，两条登录回 503 `WECHAT_UNAVAILABLE`），出站事件也用运行时上的那一个；密钥环在第一次登录时才从环境变量里的密钥文件造。
- 手机号登录的“每 openid 5 次 / 小时”不在限流中间件里：用例在换出 openid 之后回调处理器，处理器调 `runtime.rateLimiter.hit`（`src/routes/sessions.ts`）。第 6 节末条“由各自的域按数据库计数”对这一条不再成立。
- 用例里的登录态：`src/testing/merchant.ts` 的 `seedUserAgreements`（一个测试库一次）与 `signInAsMerchant(api)`，走真实的手机号登录（假微信在 `api.wechat`）。`fakeAuth` 仍可用：它顶替鉴权时，生产链里要真实会话的四件（版本门槛、成员关系、协议同意、能力点）一并拿掉，成员关系补一个空转的占位。

```sh
pnpm exec vitest run --project api apps/api/test/merchant-auth.test.ts
```
## 8. 后台接口（W1-01a）

后台的鉴权链登记在 `ROUTE_MIDDLEWARES`，文件在 `src/http/admin/`，先后照 D4 第 7.4 节：

| 槽位 | 文件 | 做什么 | 不过时 |
| --- | --- | --- | --- |
| `auth` | `session.ts` | 校验会话 Cookie（未吊销、未过期、员工仍是启用），把 `identity`、`sessionId`、`staff` 放进上下文；`x-auth: public` 的不挂 | 401 `AUTH_REQUIRED`、`SESSION_INVALID` |
| `csrf` | `csrf.ts` | 非 GET：`X-LYX-Admin: 1`，且 `Origin` 的协议、主机与端口与请求一致、这个 Host 属于后台；默认端口按 `requestProtocol` 归一化，网关保留请求端口。登录前的公开接口也查 | 403 `ORIGIN_REJECTED` |
| `authz` | `authz.ts` | 模块等级 × 权限点（“仅主管”已算在内） | 403 `PERMISSION_DENIED` |
| `stepUp` | `authz.ts` | 权限点在注册表里标了再验证、会话的再验证超过 10 分钟；`x-step-up: skip` 的不挂 | 403 `STEP_UP_REQUIRED` |

四件都排在限流与幂等上下文之前：再验证之后拿原幂等键重放即可。

后台路径的响应（含登录前、鉴权失败等错误响应）返回 `X-Admin-Build`（约定 C18），取 `src/version.ts` 的构建号；本地源码运行时为 `dev`，构建产物取 `LYX_BUILD`。在请求编号中间件统一附加。

### 8.1 登记一条后台接口：`defineAdminHandler`

```ts
// src/routes/admin/<域>.ts；在 src/routes/index.ts 里加一行展开
export const refundHandlers = [
  defineAdminHandler(adminRefundExecute, { module: "finance", need: "view" }, async (c, staff) => {
    const body = c.req.valid("json");
    const refund = await executeRefund(c.var.runtime, c.var.identity, staff.scope, body, { idem: idemOf(c) });
    return ok(c, refund);
  }),
];
```

签名（合并后不轻易改，全部后台接口包都用它）：

```ts
defineAdminHandler(route, requirement: { module: AdminModuleKey; need: "view" | "edit" } | null, handler: (c, staff: AdminStaff) => Response)
```

- 要会话的后台路由（`x-auth: staff`）一律用它登记；没用它登记的，建应用即失败。公开的后台路由仍用 `defineHandler`。
- 第二个参数是模块等级的要求：`view` 要求等级不是 `n`，`edit` 要求 `e` 或 `o`；没有模块要求写 `null`。契约的路由元数据里没有“模块等级”这个键，所以在这里声明；权限点只取路由的 `x-permission`，这里不重复写。带权限点的路由通常只要求 `view`。
- 处理器不自己写判定。第二个入参 `staff`：

| 字段 | 用途 |
| --- | --- |
| `principal`、`ctx` | 会话校验的结果（员工、角色行、分组、当前会话）与判权用的上下文（`ctx.permissions`、`ctx.moduleLevels`） |
| `scope` | 数据范围，交给带范围的仓储函数（`authz.storeScope(scope)` 等）：范围之外与不存在都是 404 |
| `taskScope` | 声明的模块等级是“本人任务”（`o`）时只含本人、不带待分配池，否则同 `scope`。任务类资源的写操作（与约定 C58 的“本人任务”列表）一律用它取资源：`o` 级只能动分派给自己的任务，这一条只在这里定，处理器与仓储不另判 |
| `assertPermission(key)` | `x-permission: assert-in-handler` 的路由取到对象后调：没有这个权限点 403 `PERMISSION_DENIED`，标了再验证且已过期 403 `STEP_UP_REQUIRED` |

- 二次确认回显在事务里、锁住对象之后调 `authz.assertConfirm(body.confirm, { … })`，比哪几个字段由接口自己列。

### 8.2 接口测试的登录态与权限矩阵

```ts
import { signInAsStaff } from "@liyoxi/services/testing";

const testApi = useTestApi();
const { request } = await testApi.start();
const finance = await signInAsStaff(await testApi.db.prisma(), { roleKey: "finance", isLead: true });
const response = await request("/api/v1/admin/…", { method: "POST", json: {…}, headers: { ...finance.headers, "Idempotency-Key": key } });
```

- `signInAsStaff(db, { roleKey?, isLead?, now?, staffGroupId?, staff?, origin? })`：直接建员工与会话行（库里没有那个角色就照种子补上），返回 `{ staff, sessionId, sessionToken, headers }`；`headers` 是会话 Cookie、`X-LYX-Admin`、`Origin`，原样带上即可。会话从可拨时钟的缺省起点算起，时钟拨过 60 分钟不活动或 12 小时照常过期，要别的时刻传 `now`。
- 测试支架的运行时带现造的假密钥（`fakeKeyEnv`）：`runtime.staffAuth` 装得起来；字段加密那两份与测试数据工厂的密钥环同一组字节。要真走一遍登录（引导、激活、绑定）的照 `test/admin-auth.test.ts`，库要先播种（`runSeed`）。
- 权限矩阵回放 `test/admin-matrix.test.ts`：生产清单里全部要会话的后台路由 × 8 个角色 × 主管与否，期望由上面两处声明与角色的代码默认配置算出，先对黄金文件 `golden/admin-permission-matrix.txt`（一条路由一行），再逐格请求比“是不是 403 `PERMISSION_DENIED`”（回放时处理器换成空壳，不执行业务）。加了后台接口后重写黄金文件，只应多出自己路由的行，不手改：

```sh
LYX_UPDATE_GOLDEN=1 pnpm exec vitest run --project api test/admin-matrix.test.ts
```

### 8.3 已知的限度

- 密钥没配（本地默认）：进程起得来，`/api/v1/admin/auth/*` 与要会话的后台接口回 500；启动自检在 `local`、`test` 下只记一条告警，`stg`、`prod` 下不过。
- 后台来源 IP 白名单（槽位 `surface`、`IP_NOT_ALLOWED`）默认不启用，没有做。
- 再验证失败不单独计数，穷举靠 `admin.login` 档按会话的限流。

## 9. 商家读侧与店员回放（W1-04②）

引导七块独立取数，失败的块用 m08 第 3.1 节默认并列入 `degraded`；匿名个人块为 `null`。无权的门店头不贡献主体白名单上下文；“我的”门店与额度由 tenant 取，其它业务只经事实端口，未登记的键保留默认。`docsOf` 的装配移至 `src/merchant/docs.ts`，`routes/agreements.ts` 仍重导出，避免装配与响应裁剪成环。

公共引导的三个角色完全共用无 `viewerRole` 的 `BootstrapSchema`，直接 parse 原始结果并回包；不额外查询观察者角色，避免成员查询失败后把 `context` 的独立降级变成 500。全块失败的 `INTERNAL` 仍回 500。其它商家处理器调用 `respondByRole(c, { owner, clerk, guest }, rawResult)`，角色由请求观察者决定；未提供该角色结构即 `ROLE_FORBIDDEN`。服务用例的 `tx.run(..., { idem })` 保存原始结果，调用裁剪必须在事务闭包外，重放时仍调用。角色结构用 Zod 的默认 strip 对象；嵌套对象也要 strip。

每个新商家接口包交一份真实店员回放样例（造数据、调用一次），在 `test/clerk/samples.ts` 登记 operationId 与 `play`。框架枚举生产 `HANDLERS` 全部 `/m/*`，缺、重复或未挂载样例即失败；`none` 样例断言 `403 ROLE_FORBIDDEN`，`trimmed` 与 `same` 递归检查禁用键并与黄金文件对照。样例中的退出或身份变更需独立会话，不能破坏其它样例。

`flags`、`versions.dict`、`versions.site`、`copy` 的字典键按完整路径登记为动态键，但字典值中的对象键照常递归扫描。目录标价例外只能按 operationId 与完整字段路径登记，不允许按字段名称全局放行。既有 m01 的 `needPhone` 与字面 `phone` 模式冲突：经调度会话确认，只放行 `m.session.create` 顶层 `data.needPhone` 的布尔值，字符串、嵌套同名、其它路由与其它含 phone 的布尔键仍拒绝；它表达登录流程状态，不含号码。

m04 第 3.3 节的公共商城配置三个角色同形，既定契约带 `filters.price` 筛选开关与 `filters.priceBands` 标价分档。这两个键与 C57 的 `price` 模式冲突，经调度会话确认单独作为 `gate-change`：仅放行 `m.mallConfig.get` 的这两条完整 `data` 路径，开关必须是布尔值；分档须通过既有 `MallConfigSchema` 的严格数组结构（每项仅 `key`、`label`、`min`、`max`，契约的文字、整数、区间、数量及唯一性约束全部沿用）。放行后继续递归扫描，其它路由、嵌套同名、错误类型或多余键仍拒绝；不改禁用正则、目录标价路径登记机制、既有黄金或 C57 正文。纯扫描回归在 `test/clerk/mall-filter-fields.test.ts`。

设置公开的本地 PG/Redis 连接与自己的 `LYX_TEST_SESSION` 后，运行：

```sh
pnpm clerk:snapshot # 命令生成黄金文件，提交前审查字段路径差异
pnpm exec vitest run --project api apps/api/test/clerk apps/api/test/merchant-views.test.ts
pnpm gates:selftest --only clerk-visible
```

根 `pnpm test` 已包含这套回放，更新命令仅在显式设置 `LYX_CLERK_UPDATE=1` 时重写黄金文件。后续包只增自己路由条目，不手改黄金文件；变更的门禁分类由 CI 按 main 的规则判定。

### 真实接口浏览器验收的 Redis 隔离

W1-02 的 `admin:e2e:live` 起构建产物时传 `--test-redis-prefix lyx:test:admin_live_<本轮标识>:`，将限流与缓存放在本轮专属键空间。只允许 `APP_ENV=test`，前缀须符合 `lyx:test:[a-z0-9_-]{1,48}:`；其他环境或格式立即拒绝。省略参数时仍使用 runtime 原默认前缀。清理仅删本轮前缀，不运行 FLUSHDB。


## 10. 套餐购买与对公付款（W1-11b）

商家七条与后台六条处理器分别在 `src/routes/billing.ts`、`src/routes/admin/billing.ts`；业务交 `Runtime.billing`，最终 JSON DTO 才交事务幂等保存。七条商家接口只允许老板，后台确认/驳回按权限点、再验证、范围和回显校验；队列计数与列表同源。账号明文只在商家本次响应，Cache-Control=no-store，同键重放为 null；后台只给脱敏串，不签凭证 URL。完整服务约定与 M4 留桩见 [付款 README](../../packages/services/src/billing/payment/README.md) 第 6 节。
