# 电脑端下载页

下载页使用独立的React应用和授权会话。页面实现状态以`src/pages.ts`登记为准；W6-10.PR1只交共享安全壳，原业务页面计数保持。

开发工具`@playwright/test`固定为`1.63.0`，由本应用声明并经自己的pnpm入口使用。API私有入口使用API自身声明的tsx，不借其它应用loader。工具前置、代码检查与X-01/V8及M6退出分别核实。

## W6-10.PR1：安全客户端与会话边界

本片交固定同源 `/api/v1/portal/` 的生成类型客户端、内存票据流程和真实会话边界。非GET沿既有 `X-LYX-Portal` 与浏览器Origin；不生成Bearer、Idempotency-Key或本地会话。票据secret只在闭包，终态与离开时释放；并发交换只发起一次，未知结果不重试。并发401只清理当前会话，迟到响应不能恢复已失效身份；429保留服务端冷却，维护态通过显式刷新恢复。

`src/lib/runtime.ts` 提供单一运行实例，`src/lib/routes.ts` 声明叶项owner与公开/需会话边界。W6-12接广告与匿名验真、正式安全错误writer；W6-11接列表/下载，均消费本片实际合入的公口。页面登记仍未实现，测试入口不属于产品页面；本片不选择二维码形态或完成X-01/V8。

## 本地隔离HTTPS验收

需Node24、仓库指定pnpm、本地PostgreSQL/Redis与本应用声明的Playwright Chromium；先冻结安装、生成Prisma客户端。只用compose公开本地连接参数，不加载`.env`、用户浏览器或真实云/微信配置。

```sh
pnpm install --frozen-lockfile
pnpm db:generate
docker compose -f infra/compose/local.yml up -d --wait postgres redis
pnpm --filter @liyoxi/portal exec playwright install chromium
pnpm --filter @liyoxi/portal typecheck
pnpm --filter @liyoxi/portal test
pnpm portal:build
APP_ENV=test DATABASE_URL=postgresql://liyoxi:lyx-local-dev@localhost:5442/liyoxi \
REDIS_URL=redis://localhost:6389/0 LYX_BUILD=local-verification \
pnpm --filter @liyoxi/portal e2e:live
```

本片当前在实现与验证中，完整HTTPS链尚未计通过。入口为`scripts/live.mjs`，最终经白名单检查的结果目录为`dist/e2e-live-safe/<runId>`；原始测试输出不上传。

每轮独占临时目录、数据库与Redis前缀；本机临时证书只用于本轮回环HTTPS，不改变系统信任。独立API进程经本应用tsx正常加载原源码，以真实商家HTTP创建身份/成员，再批准浏览器真实票据。Secure/HttpOnly/SameSite=Strict Cookie由实际交换响应自然写入；浏览器使用正式生产客户端和会话模型，不注入Cookie或伪会话。

固定三例覆盖授权/吊销、退出、错误配对不认证与同源/Host拒绝，读取窗口比较七张相关表零写。每例60秒、断言10秒、单worker且不自动重试；不改限流或生产预算。授权context禁用trace、录像、自动截图、HAR与storageState。只保留固定安全JSON和已检查的主动会话截图；不上传TLS材料、原始响应、令牌或票据secret。关闭必须获得API清理确认；没有确认的清理不能计成功。

本地HTTPS验证证明技术授权与Cookie链，不能替代微信扫码、真实设备、外部存储或正式签名验收。W6-10.PR2仍按原X-01 actual、V8和E2/E4/E7条件推进，整包保持进行中。

## 本地页面迁移候选

本分支按业主授权接入 `createAuthRoutes(runtime)` 的登录与 `/a` 叶页，保留既有安全壳。
登录页自动读取当前会话，未授权时生成二维码和短码；小程序确认后交换Cookie并重新读取会话。
`/items` 由独立W6-11迁移分支提供；本片不实现下载后端或重复的会话框架。

小程序审批页以迁移候选纳入构建；该草稿分支的源码登记不代表actual main已交付。
设置页电脑会话管理、X-01/V8和原整包条件尚未完成；本分支不得作为已经交付的安全壳或扫码整包。
迁移背景和依赖快照见 `docs/plan/changes/W6-10-local-page-migration.md`。

## W6-11 下载页面迁移候选

本后继分支组合 `createAuthRoutes(runtime)` 与 `createDownloadRoutes(runtime)`，提供
`/items` 和 `/items/$id`。列表使用正式 `limit`/cursor，下载复用正式W6-06/W6-07接口，
支持单集、ZIP状态与显式失败重试、发布清单复制和文本文件退路。
广告预览只链接到W6-12约定地址，该叶页尚未在本迁移中实现。

本分支没有旧演示的自建后端、生产假数据或本机媒体桥。以下浏览器检查仅验证真实UI
与正式契约的兼容性：假响应只由Playwright在测试进程拦截，所有fixture经正式schema校验，
未知API请求直接失败。实际下载字节由测试进程的临时回环媒体服务提供；不启动数据库，
不加载根配置，不使用用户浏览器。

```sh
pnpm --filter @liyoxi/portal build
pnpm --filter @liyoxi/portal exec playwright test --config playwright.migration.config.ts
```

检查独占回环端口5194，不复用已有服务器；产物位于 `dist/e2e-migration/`。
该检查不替代安全壳真实HTTPS/Cookie/API链、W6-12集成、V7/V8或真实ZIP文件验收。
正式页面登记与工作包状态仍按实际交付更新；本分支为隔离迁移候选。
