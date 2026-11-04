# 电脑端下载页

下载页使用独立的React应用和授权会话。页面实现状态以`src/pages.ts`登记为准；W6-10.PR1交共享安全壳；W6-12交广告只读预览和公开授权书验真两页，样片按Q9只保留小程序查看说明。

开发工具`@playwright/test`固定为`1.63.0`，由本应用声明并经自己的pnpm入口使用。Playwright工具PR282与API工具PR284均已实际合入；API私有入口使用API自身声明的tsx，不借其它应用loader。工具前置、代码检查与X-01/V8及M6退出分别核实。

## W6-10.PR1：安全客户端与会话边界

本片交固定同源 `/api/v1/portal/` 的生成类型客户端、内存票据流程和真实会话边界。非GET沿既有 `X-LYX-Portal` 与浏览器Origin；不生成Bearer、Idempotency-Key或本地会话。票据secret只在闭包，终态与离开时释放；并发交换只发起一次，未知结果不重试。并发401只清理当前会话，迟到响应不能恢复已失效身份；429保留服务端冷却，维护态通过显式刷新恢复。

`src/lib/runtime.ts` 提供单一运行实例，`src/lib/routes.ts` 声明叶项owner与公开/需会话边界。W6-12接广告与匿名验真、正式安全错误writer；W6-11接列表/下载，均消费本片实际合入的公口。PR1本身不增加页面登记，隔离测试入口不属于产品页面；PR1不选择二维码形态或完成X-01/V8。

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

完整HTTPS首轮已通过：基于`0617b66dbca3a4a539236a9353e81ce6db8491ab`执行上述live命令，run `63efe2a275b9`的3场景全部成功，runner耗时8035ms，cleanup confirmed。6个白名单文件已核对，其中4张1440×900截图已目视；owned数据库/连接、Redis前缀与临时目录均已清理。91项定点及原工作流96项检查通过；最终services/API类型与5156模块分层检查通过；[PR290](https://github.com/byfire-dev/liyoxi-project/pull/290)的[CI 41772693876](https://github.com/byfire-dev/liyoxi-project/actions/runs/41772693876)全19项通过，PR1已实际合入`7f18e559e`。

入口为`scripts/live.mjs`，最终经白名单检查的结果目录为`dist/e2e-live-safe/<runId>`；原始测试输出不上传。

每轮独占临时目录、数据库与Redis前缀；本机临时证书只用于本轮回环HTTPS，不改变系统信任。独立API进程经API自身声明的tsx正常加载原源码，以真实商家HTTP创建身份/成员，再批准浏览器真实票据。Secure/HttpOnly/SameSite=Strict Cookie由实际交换响应自然写入；浏览器使用正式生产客户端和会话模型，不注入Cookie或伪会话。

保留原三例覆盖授权/吊销、退出、错误配对不认证与同源/Host拒绝；PR288新增两例从实际页面读取公开短码，经真实商家批准后核Cookie、列表/吊销、拒绝换码/退出与公开落地页。当前合流候选完整运行12例（PR288原5例＋已交付PR291新增7例），不传文件筛选参数；预览准备前观察7表，准备后观察16表。每例60秒、断言10秒、单worker且不自动重试；不改限流或生产预算。授权context禁用trace、录像、自动截图、HAR与storageState。只保留固定安全JSON和已检查的主动会话截图；不上传TLS材料、原始响应、令牌或票据secret。关闭必须获得API清理确认；没有确认的清理不能计成功。

本地HTTPS验证证明技术授权与Cookie链，不能替代微信扫码、真实设备、外部存储或正式签名验收。真机未测、V10未执行，4新页仍未完成；W6-10.PR2仍按原X-01 actual、V8和E2/E4/E7条件推进，整包保持进行中。

## PR288页面候选与实际接口验证

本分支按业主授权接入 `createAuthRoutes(runtime)` 的登录与 `/a` 叶页，保留既有安全壳。
登录页自动读取当前会话，未授权时生成二维码和短码；小程序确认后交换Cookie并重新读取会话。
成功后在本页显示真实授权门店、时间、刷新状态和退出；`/items` 由后继PR289接入，当前不提前导航到该地址。登录及落地页提示从小程序设置的“已授权的电脑”进入授权或手输。

小程序审批页以迁移候选纳入构建；该草稿分支的源码登记不代表actual main已交付。
设置页已接本人在当前主体的有效电脑授权列表、显式吊销、required幂等与实际读回；审批页补取消、错数字、过期、身份/门店变化、隐私拒绝和重试恢复。安全壳已实际交付，当前页面候选仍待最终验收及X-01/V8条件，整包未完成。
迁移背景和依赖快照见 `docs/plan/changes/W6-10-local-page-migration.md`。

PR288合流前实际HTTPS首轮run `a77f072dd2e4` 五例全过，耗时16969ms，cleanup confirmed；安全输出13文件含11张截图，新增7张页面图已目视。该结果来自本地候选工作树，不替代当前PR的CI或真机V8。

同步PR291实际main后，合流候选139项定点及完整12例HTTPS通过：run `ed67700226f6`、67587ms、cleanup confirmed，白名单为29文件含27图。合流登录、播放过期/重取与待修订验真4图已另行目视。完整链保留真实票据限流，最后一例若实际429则核对错误码及Retry-After，只在原剩余预算内真实等待后明确再次取票；该例实际40706ms，未增加超时或自动重试。当前PR新提交的CI与真实V8结论另核。


## W6-12：广告预览与公开验真

`/preview/ad/<adId>` 使用共享会话边界，先读广告当前已推送版本，点击播放才签发地址并留下访问记录。新版本要求重新确认播放，地址到期后显式重取；吊销、跨店、通道不可用均以实际API拒绝为准。页面不提供广告确认、修改或计费入口。

`/preview/sample/<id>` 只显示返回小程序查看与确认的说明，不请求样片详情、生成播放地址或提供查看确认按钮。历史路由标题不表示重新开放电脑样片。

`/v?code=<验真码>&rev=<版次>` 匿名开放，`rev`原值传给接口的`revNo`，不先转换或修正无效输入。页面分别展示当前授权状态、当前已出件版和本次核对版；有待出件修订时仍展示现行已出件版。只使用公开投影，无老板联系方式、私有PDF地址或下载入口。验真页说明不代替PDF阅读器的数字签名验证。

全应用错误上报仅在公开构建配置`VITE_CLIENT_ERROR_DSN`有效时启用，经既有同源`portal.clientError.create`送出安全信封。只保留固定分类、请求ID/状态和经过清理的正式构建帧，不保留错误原文、查询参数、身份、Cookie、pollSecret或签名地址；按指纹去重、限量并在离开时清理。上报失败不改变会话、维护态或业务结果；未配置时不收集。

本包定点检查：

```sh
pnpm --filter @liyoxi/portal exec vitest run src/features/preview src/features/verify src/lib --maxWorkers=1 --no-file-parallelism
pnpm --filter @liyoxi/portal typecheck
pnpm portal:build
node infra/ci/pages/generate.mjs --check
```

广告与授权书隔离验收复用PR1的真实商家HTTP、自然Cookie和同一runtime，不伪造主体或会话。既有SHA绑定MP4用于实际浏览器解码；底层存储由本地Provider替身承载，临时媒体代理每次核对本轮授权、签名有效期与原存储读取，再处理Range。授权书通过正式收敛、领取和完成出件过程形成状态，历史订单为明确夹具输入，PDF字节和封面使用测试替身。本地有效期、版本和页面验证不表示真实云签名、PDF制作或合法授权已验收。

真实样张二维码的code/rev核对、E8/E11和签后V12仍按原台账完成；本包不关闭X-01/V8、V7或云端5GB ZIP的V10。

PR291独立隔离验收使用上述带本地公开参数及`LYX_BUILD`的`e2e:live`命令，原3例加新增7例全部执行，原60秒/断言10秒/单worker/零自动重试保持；新增读取窗口覆盖16张表，当时导出清单为10例、20张截图及2份安全结果文件。run `1c4bb7bb1596`已10/10通过，20854ms，cleanup confirmed，新增16图已目视。最后一例按与服务端相同的固定3601秒跨度推进浏览器时钟，验证页面正式到期计时器；旧地址实际410和新地址再次签发/解码均保留，没有用已缓冲视频的load事件推断过期。

验收覆盖当前/旧版/待修订/缺失版/无效原值、过期/作废/无效码的真实匿名投影，全部无Cookie或current请求；同源错误信封实际返回202仅证明接口接收，不表示外部Sentry送达。代码侧132项定点、类型、lint、生产构建与页面清单通过；PR291已在CI41780037563全19项成功后实际合入`1a716466711d0ee3bb83261f62ccdccd84d8ca22`，本地main已同步。PR288合流候选另核完整12例和新head CI，仍不代替真实扫码。
