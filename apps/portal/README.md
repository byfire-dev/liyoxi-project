# 电脑端下载页

下载页使用独立的React应用和授权会话。页面实现状态以`src/pages.ts`登记为准；W6-10.PR1只交共享安全壳，原业务页面计数保持。

开发工具`@playwright/test`固定为`1.63.0`，由本应用声明并经自己的pnpm入口使用。Playwright工具PR282与API工具PR284均已实际合入；API私有入口使用API自身声明的tsx，不借其它应用loader。工具前置、代码检查与X-01/V8及M6退出分别核实。

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

完整HTTPS首轮已通过：基于`0617b66dbca3a4a539236a9353e81ce6db8491ab`执行上述live命令，run `63efe2a275b9`的3场景全部成功，runner耗时8035ms，cleanup confirmed。6个白名单文件已核对，其中4张1440×900截图已目视；owned数据库/连接、Redis前缀与临时目录均已清理。91项定点及原工作流96项检查通过；最终services/API类型与5156模块分层检查通过；[PR290](https://github.com/byfire-dev/liyoxi-project/pull/290)的[CI41772693876](https://github.com/byfire-dev/liyoxi-project/actions/runs/41772693876)全19项通过后实际合入`7f18e559e`，下游按原其余依赖消费安全壳。

入口为`scripts/live.mjs`，最终经白名单检查的结果目录为`dist/e2e-live-safe/<runId>`；原始测试输出不上传。

每轮独占临时目录、数据库与Redis前缀；本机临时证书只用于本轮回环HTTPS，不改变系统信任。独立API进程经API自身声明的tsx正常加载原源码，以真实商家HTTP创建身份/成员，再批准浏览器真实票据。Secure/HttpOnly/SameSite=Strict Cookie由实际交换响应自然写入；浏览器使用正式生产客户端和会话模型，不注入Cookie或伪会话。

保留原三例覆盖授权/吊销、退出、错误配对不认证与同源/Host拒绝；PR288新增两例从实际页面读取公开短码，经真实商家批准后核Cookie、列表/吊销、拒绝换码/退出与公开落地页，合计五例。读取窗口比较七张相关表零写。每例60秒、断言10秒、单worker且不自动重试；不改限流或生产预算。授权context禁用trace、录像、自动截图、HAR与storageState。只保留固定安全JSON和已检查的主动会话截图；不上传TLS材料、原始响应、令牌或票据secret。关闭必须获得API清理确认；没有确认的清理不能计成功。

本地HTTPS验证证明技术授权与Cookie链，不能替代微信扫码、真实设备、外部存储或正式签名验收。真机未测、V10未执行，4新页仍未完成；W6-10.PR2仍按原X-01 actual、V8和E2/E4/E7条件推进，整包保持进行中。

## PR288页面候选与实际接口验证

本分支按业主授权接入 `createAuthRoutes(runtime)` 的登录与 `/a` 叶页，保留既有安全壳。
登录页自动读取当前会话，未授权时生成二维码和短码；小程序确认后交换Cookie并重新读取会话。
成功后在本页显示真实授权门店、时间、刷新状态和退出；`/items` 由后继PR289接入，当前不提前导航到该地址。登录及落地页提示从小程序设置的“已授权的电脑”进入授权或手输。

小程序审批页以迁移候选纳入构建；该草稿分支的源码登记不代表actual main已交付。
设置页已接本人在当前主体的有效电脑授权列表、显式吊销、required幂等与实际读回；审批页补取消、错数字、过期、身份/门店变化、隐私拒绝和重试恢复。安全壳已实际交付，当前页面候选仍待最终验收及X-01/V8条件，整包未完成。
迁移背景和依赖快照见 `docs/plan/changes/W6-10-local-page-migration.md`。

本轮实际HTTPS首轮run `a77f072dd2e4` 五例全过，耗时16969ms，cleanup confirmed；安全输出13文件含11张截图，新增7张页面图已目视。该结果来自本地候选工作树，不替代当前PR的CI或真机V8。
