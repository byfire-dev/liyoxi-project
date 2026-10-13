# apps/weapp：商家端小程序

Taro 4.2.1（Vite 编译器）+ React 18 + NutUI React Taro。依据：[D7](../../docs/appendix/design/d7-platform.md) 第 3、4 节；[约定](../../docs/api/00-conventions.md) C3、C17–C23、C48；[规范](../../design/design-spec.md) 第 4 节。工程与请求层由 W0-27a 交付，W1-05②交付登录、协议正文、我的，以及账户启动与恢复接线。

## 命令

在仓库根目录跑。都不读 `.env`，要改的值在命令前给环境变量。

| 命令 | 做什么 |
| --- | --- |
| `pnpm weapp:build` | 出小程序包 `apps/weapp/dist/`，由模板生成 `project.config.json`，再过体积门禁（主包 ≤1,500KB、分包 ≤800KB）。超限即失败 |
| `pnpm --filter @liyoxi/weapp dev` | 开发：改了就重新构建（不压缩，不过体积门禁） |
| `pnpm --filter @liyoxi/weapp test` | 请求层、四个端上封装、账户编排、页面清单的用例（Node 环境）。只跑一个文件：后面加 `src/lib/request.test.ts` |
| `pnpm weapp:shots` | 给已建的页各出一张截图到 `apps/weapp/shots/dist/png/`（宽 375）。只出一页：`pnpm weapp:shots -- --page pages/home/index`；本机没装 Playwright 自带的 Chromium 时前面加 `LYX_E2E_CHANNEL=chrome` |
| `node apps/weapp/scripts/build-tabbar-icons.mjs` | 重新导出标签栏的 8 张图标（改图标或改颜色时才跑，产物入库） |
| `pnpm weapp:shots -- --component Button` | 只出某个组件的预览图（整页），可给多次。不带参数时，页面之外另出组件陈列的目录页与每个组件各一张 `gallery__<组件名>.png` |
| `pnpm weapp:shots -- --sheet colors` | 只出某张基础样张的图（整页），可给多次：`colors`、`typography`、`spacing`、`status-tone`。不带参数时每张样张各出一张 `gallery__sheet-<样张名>.png` |
| `WEAPP_GALLERY=1 pnpm weapp:build` | 出带组件陈列分包的小程序包（看样用）。不给时生产包不带；H5 截图构建与 `dev` 一律带 |

构建用的环境变量（都可不给）：

| 变量 | 含义 | 缺省 |
| --- | --- | --- |
| `WEAPP_APPID` | 小程序 AppID，写进生成的 `project.config.json` | 测试号占位 `touristappid` |
| `WEAPP_API_BASE_URL` | 接口基址，不含 `/api/v1` | 空：请求以 `NOT_CONFIGURED` 结束，不发出去 |
| `WEAPP_VERSION` | 小程序版本号，随请求头 `X-Client-Version` 带出 | `0.1.0` |
| `WEAPP_SENTRY_DSN` | 错误上报的 DSN（公开部分，不是密钥） | 空：错误上报不发请求 |
| `WEAPP_GALLERY` | 组件陈列分包进不进构建：`1` 带，`0` 不带 | 不给：H5 与开发构建带，生产的小程序包不带 |

用微信开发者工具看：先 `pnpm weapp:build`，再导入 `apps/weapp` 目录（`project.config.json` 是生成物，不入库，不手改 appid）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `config/index.ts` | Taro 构建配置：`designWidth` 375，样式文件里的 px 照原型原样写；每个 `.scss` 自动可用 `$lyx-*` 变量 |
| `src/pages.ts` | 页面清单：49 个路由一行一条。全局配置的页面、分包、预下载由它拼出；`docs/plan/pages.md` 的小程序部分由它生成 |
| `src/app.config.ts`、`src/app.ts`、`src/app.scss` | 全局配置（原生标签栏、隐私总开关、超时）、入口、全局样式 |
| `src/lib/` | 请求层与四个端上封装，见下 |
| `src/stores/` | `session`（令牌与用户概要）、`context`（当前门店）、`bootstrap`（引导数据）；一个 store 一个文件 |
| `src/components/NavBar/` | 自绘导航栏，只给首页与登录页用；其余页面用原生导航栏 |
| `src/components/` 其余目录 | 通用组件（W0-27b）及任务指定的业务组件 `StoreSwitcher`、`ConsentPopup`，一个组件一个目录 |
| `src/gallery.ts`、`src/sub/gallery/` | 组件陈列（开发用的分包）：登记、目录页、预览页、各组件的预览 |
| `src/lib/toast.ts`、`cx.ts`、`percent.ts` | 轻提示；拼类名；进度取整 |
| `src/styles/_mixins.scss` | 组件共用的 mixin：点击区补足到 44、单行省略 |
| `src/styles/nutui.ts` | NutUI 组件样式的唯一入口（只留 7 个组件） |
| `scripts/` | 构建、截图、截图的受影响范围、标签栏图标 |

## 页面里怎么用

```ts
import { captureError, newIdempotencyKey, request, track, withPrivacy, withSubscribe } from "@/lib/runtime";
```

| 要做的事 | 写法 |
| --- | --- |
| 调接口 | `request<T>("/m/…", { method, data, idempotencyKey })`。门店头、令牌、请求编号、超时与重试、401 后静默登录并重放都在请求层里；页面只按 `ApiError.error`（符号名）判断 |
| 幂等键 | 进入确认页或打开确认弹层时 `newIdempotencyKey("orderSubmit")` 生成一次，存在页面状态里；这次意图下的重试都用它，改了内容换新的 |
| 订阅授权 | `onClick={withSubscribe("order_submit", handler)}`。点位取契约的常量；没有可请求的模板时直接执行处理函数 |
| 隐私接口 | `const result = await withPrivacy(() => Taro.chooseMedia(…))`；`result.ok` 为假是用户没同意隐私指引 |
| 埋点 | `track("mall_view", { mode: "list" })`。事件名与属性取契约登记，写错了类型检查过不去 |
| 报错误 | 全局错误自动收集；页面里接住、但值得知道的，用 `captureError("handler", error)` |

新加页面：建 `src/pages/<页>/` 或 `src/sub/<分包>/<页>/` 下的 `index.tsx`、`index.config.ts`，把 `src/pages.ts` 里那一行的 `implemented` 改成 `true`（占位页同时去掉 `placeholder`），再跑 `node infra/ci/pages/generate.mjs`。

## 通用组件

依据：[规范](../../design/design-spec.md) 第 4、12 节。第一批由 W0-27b 交付；看样（W0-29）确认后冻结，页面包不改组件，要改、要加走单独的构件 PR。

```tsx
import { Button } from "@/components/Button";
import { merchantStatusByEnum, StatusTag } from "@/components/StatusTag";
```

| 分组 | 组件 |
| --- | --- |
| 基础 | `Icon` 图标；`PageBody` 内容区；`FooterBar` 底部操作栏；`NavBar` 自绘导航 |
| 按钮 | `Button`（主、次、主色描边、危险；特大 48、大 46、中 40、小 32；`loading`、`disabled`）；`PillButton` 胶囊小按钮；`TextButton` 文字按钮与文字链；`IconButton`；`AddButton` 虚线添加 |
| 标签与角标 | `StatusTag`（`tone`，`plain` 为纯文字状态）；`InfoTag`；`Badge`（数字角标、`dot` 红点） |
| 卡片与列表 | `Card`（`default`、`item`、`list`、`dark`、`subtle`）；`Section`；`List` 与 `ListRow`（菜单行、双行行）；`DescList` 键值网格 |
| 表单 | `Field`；`Input`；`TextArea`；`SelectEntry`；`SearchBar`；`Checkbox`（`shape="round"` 为单选）；`Switch`；`Chip` 选项胶囊；`OptionCard` |
| 页签、分段与筛选 | `Tabs` 下划线页签；`Segmented` 分段控件；`FilterChips` 筛选胶囊 |
| 提示与反馈 | `Note` 提示条；`Sheet` 底部弹层；`Empty` 空状态；轻提示用 `toast()`（`@/lib/toast`） |
| 步骤与进度 | `StepBar` 分段步骤条；`Timeline`（`progress` 进度时间轴、`record` 记录时间轴）；`ProgressBar` |
| 上传与其他 | `UploadGrid`（含上传中、上传失败）；`Avatar` 字形头像；`IconTile` 图标块；`Cover` 短剧封面 |
| 补充状态 | `Skeleton` 首次加载；`LoadError` 加载失败；`ListFooter` 触底加载。提交中是 `Button` 的 `loading`；按下态各可点的组件自带（不透明度 0.7） |

各组件的属性写在它 `index.tsx` 的类型注释里，用法照 `src/sub/gallery/previews/<组件名>.tsx`。写页面时守这几条：

| 事 | 做法 |
| --- | --- |
| 颜色 | 组件与页面都不写色值（`pnpm lint:colors`）。样式里用 `$lyx-*` 变量；图标的颜色跟随外层文字色 |
| 状态色 | 不自己挑：`merchantStatusByEnum("表.列", 取值)` 给出色调与商家端的叫法，再交给 `StatusTag`。对应关系只有一份，在 `@liyoxi/shared/design/status-tone` |
| 筛选与取值 | 筛选、切换视图用深色选中的 `FilterChips`、`Segmented`、`Tabs`；表单里取值用橙色选中的 `Chip`、`OptionCard` |
| 文案 | 组件不带业务文案，都由属性传。带了缺省文字的只有规范写明的几句：“重新加载”“加载中……”“没有更多了”“上传失败”“重试”“关闭”，也都能换 |
| 确认 | 商家端不设居中确认框，要确认的地方用 `Sheet`：放弃在左、确认在右，危险操作的确认键用 `variant="danger"` |
| 下拉刷新 | 用小程序原生的：页面配置里开 `enablePullDownRefresh`，不另做组件 |
| 尺寸 | 写在 `.scss` 里，不写行内 `style`。选择器里带 `nut-` 的规则不做单位转换（构建配置如此）：给 NutUI 的组件改尺寸，写在自己的类名上或用它的 `--nutui-*` 变量 |
| NutUI | 按组件的路径引（`@nutui/nutui-react-taro/dist/es/packages/<组件>`），不从包的根上引；样式在 `src/styles/nutui.ts` 登记 |

第一批没有的（用到的页面包之前走构件 PR 补）：会员等级胶囊、剧目宫格卡、金额明细行、统计格、积分包卡、序号步骤、文件行、广告视频预览、音频、对话气泡、结果页头、选择器弹出。

### 组件陈列

`src/sub/gallery/` 是开发用的分包：目录页 `sub/gallery/index/index` 列出全部通用组件，预览页 `sub/gallery/preview/index?name=<组件名>` 看一个组件的各种状态。它不是业务页面，不在页面清单里。生产的小程序包缺省不带它；`WEAPP_GALLERY=1 pnpm weapp:build` 出带它的包，在开发者工具里用编译模式打开目录页。

看样也用它（W0-29）：目录页照规范的章节先后分组，每组标着规范的节号与要对的要点，预览页顶上也有同样一段。除了组件，另有四张基础样张（颜色、文字、间距圆角与描边、状态取色表），预览页用 `?sheet=<样张名>` 打开，登记在 `src/gallery.ts` 的 `GALLERY_SHEETS`，内容在 `src/sub/gallery/sheets/`。分组的节号与要点在 `GALLERY_GROUP_SPEC`。业主怎么在开发者工具与真机上打开、逐项看什么，见[看样清单](../../docs/plan/sample-review/W0-29.md)。

新增通用组件：建 `src/components/<组件名>/`（`index.tsx`、`index.scss`），在 `src/gallery.ts` 加一行，写 `src/sub/gallery/previews/<组件名>.tsx` 并登记进同目录的 `index.ts`。少了哪一样，`src/gallery.test.ts` 或类型检查会指出来。

## 账户与服务端接线

请求层与四个封装都写成不依赖小程序运行时的模块（接口在 `src/lib/platform.ts`，真实实现在 `platform.taro.ts`），服务端调用经 `src/lib/server.ts` 的 `connectServer({ … })` 接入。`account-runtime.ts` 接上引导、静默登录、重拉账号、协议同意与版本提示五个调用；11条账户接口都经生成契约类型与中央 `runtime.request` 调用。W2-18 PR1的`client-reporting.ts`补订阅结果、埋点与错误上报三调用，均用生成operation类型与同一个中央request。

| 调用 | 接口 | 由谁接 |
| --- | --- | --- |
| `fetchBootstrap`、`silentLogin`、`reloadMe`、`askConsent`、`showUpdatePrompt` | `m.bootstrap.get`、`m.session.create`、`m.me.get`、协议同意 | W1-05②已接（后端 W1-04 / W1-04b） |
| `reportSubscribeResult`、`sendAnalytics` | `m.subscribeResult.create`、`m.analyticsEvent.batchCreate` | W2-18 PR1实际接线 |
| `sendClientError` | `m.clientError.create` | W2-18 PR1实际接线 |

订阅保留真实accept/reject/ban/filter与原精确幂等键；埋点网络/5xx交回原队列重试，4xx/未配丢弃，不增加adapter重试。信封以原文与`application/x-sentry-envelope`传输，不JSON重编码。未配`API_BASE_URL`不装配埋点/错误发送器，保留本地开发降级；公开DSN构建变量为`WEAPP_SENTRY_DSN`，空值沿原封装关闭采集。DSN仅含公开项目key；真实项目与服务端FILE白名单按W2-27移交，尚未验证真实平台收件或微信授权。`pnpm --filter @liyoxi/weapp test`中的client-reporting用例真实经过中央request，覆盖原文字节/头、四结果、网络/5xx与4xx分支。

## 账户流程（W1-05②）

`src/lib/account-controller.ts` 只编排生成 DTO 与可注入端口；`account-runtime.ts` 装配三个既有 store 与五个 server 调用。冷启动首触来源先到先得（空来源同样占位），引导后有令牌取 me，无令牌静默登录，needPhone 保持游客。accessToken 沿 C3 与既有 persistence 落盘，用户概要不落盘；首触来源和本机替身码不保存号码。登录页的 PhoneForm 是 M1 替身：11位号码作为 phoneCode，取不到平台登录码时才用本机固定串；真实凭证组件在 G2-B 替换此表单。

登录成功恢复原页面；非标签页恢复编码后的查询参数，标签页用原生 switchTab。协议版本过期重拉版本并清空表单勾选。me 与五个并发428共用阻断式协议层；同意回执确认没有 pending 即释放等待，由服务端重放时再次校验，后续 me 只刷新概要，刷新失败不挂起原请求。仍有未签协议时保持可见且可操作的阻断层；只可不同意并退出，30秒内不重复弹。正文页可阅读，返回后仍阻断。切店先改本地/清聚合，再重拉、记住选择、埋点和提示；保存失败不回滚、同一意图重试保留幂等键。generation、令牌和 contextRev 丢弃旧账号、旧门店迟到响应。协议生效日复用 shared/format/datetime 的北京时间显示，不截UTC日期。

我的套餐积分卡与统计只按 overview.viewerRole=owner 展示；店员不显示资金、订单与发布入口。不做金额、积分或订购判断。未来入口只在 pages.ts 对应页 implemented=true 时显示，钱包指向 sub/billing/wallet/index。无门店显示账号与未绑定说明。退出登录已随W2-13迁入账号设置页。

登录按钮和首次说明文案键分别为 `login.button`、`login.firstLogin`，没有覆盖时使用任务默认；本包无订阅按钮点位，替身表单不调用隐私能力。埋点 `app_launch` 不带邀请凭证，`store_switch` 只带 fromPage；两者按契约调用，接收口未到时空转。

## 账户八态离线样张

固定 DTO 在 `shots/account-fixtures.ts`，场景清单在 `shots/account-scenes.ts`。截图脚本用路由参数 `lyxShot` 标明场景并在加载前显式注入同名 H5 标记；H5 接线经 connectServer 与可注入调用喂数据。小程序构建不包含此分支，生产仍中央 request。每图独立浏览器上下文；场景外发网络一律失败，严格检查页面异常与 console.error。这些是固定离线界面截图，不能作为真实接口证据。

运行 `LYX_E2E_CHANNEL=chrome pnpm weapp:shots -- --scene login-unchecked --scene login-checked --scene agreement --scene mine-owner --scene mine-clerk --scene mine-guest --scene store-switch --scene reconsent`，产物 `shots/dist/png/account__<场景>.png`。不带参数会自动附上八态；`--scene` 可多次，`--no-build` 只用于源码未变时复用产物。未勾选图实际点击登录触发提示，已勾选图实际切换复选框，门店图实际点开切换层。

两个业务组件按任务位于 components/，在以上业务使用位置看样，不进入冻结通用陈列。gallery.test.ts 精确登记这两个例外，原通用组件的目录、预览与入口覆盖完整保留。

## 截图与真机的差异

`pnpm weapp:shots` 截的是 Taro 的 H5 构建，是近似，不是小程序的渲染层：原生导航栏在 H5 下不出现（没有标题栏与胶囊），标签栏是 Taro 的 H5 仿制件，高度与字体都与微信不同；自绘导航取不到胶囊位置，用的是兜底值；H5 下页面底色没有铺满，内容区是白的。真机上的样子以微信开发者工具与手机为准。

组件预览的图同样是 H5 近似：原生的输入框、多行输入、开关、弹层在微信里的样子，以及点击区、按下态、弹层正文的内部滚动，以真机为准（W0-29 看样时看）。

## 消息页与未读角标（W2-19）

W2-13 设置页已补本人账号操作源码，入口与通知复用关系、幂等/未决换绑和外部验证边界见
[`sub/service/settings/README.md`](src/sub/service/settings/README.md)。只登记设置一页，
我的页沿原八态菜单开放设置并移出退出；登录 PhoneForm 仅替换为真实号码授权凭证。
本域8组风险单测及8个H5场景交ROOT选择性验收，不替代真机结论。

`sub/service/messages/index` 使用原生导航，固定八类页签，默认 all/20；游标不解码，续页按 messageId 去重，下拉刷新替换。首页与我的消息入口只显示服务端 summary 的未读真值；无门店时仍能读账号通知。token、contextRev、门店、账号、成员角色和可进门店变化时清除本页缓存及旧角标，旧成功和旧错误均不能回写。消息标题、正文与金额取真实服务端 DTO，店员文案不在页面重造。

单读和全读都按实际 required 契约保留同次意图的键；全读固定首次列表顶部 upToMessageId 与 tab，重试不把新到消息纳入旧意图。成功后读取真实列表/summary，失败不乐观减计数。点击先确认 read 成功，再进入已落地且当前角色允许的目标；跨店提示先切店，未来客服/广告/积分明细目标提示不可访问。协议目标以服务端固定 key 查询现有协议列表，取得真实 currentVersionId 后进入已交付正文页。转账驳回的 payment.detail 与 payment.result 复用已落地付款页、原 owner 准入和真实付款资源 GET，不扩权限。

本页底部订阅设置 Sheet 展示 on/off/rejected/banned/unavailable。选择按钮直接同步调用既有 withSubscribe("notify_settings")，模板与槽位来自已在内存中的 bootstrap；真实 accept/reject/ban/filter 由 W2-18 接线报告，页面不伪造授权或额度。报告成功后经该次点击的可选回调再次读取当前设置；旧 GET 不能覆盖新请求结果，切换 scope 或卸载后不回写。原业务 handler 不等待上报、afterReport 仍刷新 bootstrap，报告或当前页回调失败不产生未处理拒绝。未配置仍保留站内消息和不可用状态。

十态固定场景在 `shots/message-scenes.ts`、`shots/message-fixtures.ts`，运行 `LYX_E2E_CHANNEL=chrome pnpm weapp:shots -- --scene messages-owner --scene messages-clerk --scene messages-category --scene messages-more --scene messages-all-read --scene messages-empty --scene messages-no-store --scene messages-unavailable --scene messages-loading --scene messages-error`；PNG 为 `shots/dist/png/message__<scene>.png`。无店模式使用真实空 memberships/currentStoreId，经中央 RequestLayer 的假 send 记录缺少 X-Store-Id；这仍是离线接口接线证据，不代表真实 API/微信平台结果。原截图场景、外发网络、console.error/pageerror 守卫保持。

真机清单（尚未执行）：已授权测试号检查原生导航/安全区、横向页签的 44px 点击区、下拉与触底、切店/切账号后无旧内容、老板降店员后无老板专属消息；单读/全读后的入口角标；实际模板授权 accept/reject/ban 与后端额度相符。H5 截图不能代替上述验收，W2-30 合流演示另行登记。


## 首页与商城四页（W1-18 PR1）

首页、商城、短剧详情与选剧单消费正式生成的 DTO；所有生产请求走现有中央 request。店员首页只读 city+banners，店员/游客选剧单不发 cart 请求。商城按配置给的筛选和 sort 加载，游标续页按 dramaId 去重；本域 revision、令牌与 contextRev 丢弃切店/卸载后的旧成功和旧错误。价格确认发送服务器当前原价 P，网络重试沿用同一次意图的 key；成功或 C50 重放后重新 GET 选剧单。选中合计只累加服务器逐项实扣 S，不在端上重算价格。确认订购页属 PR2，本轮入口明确显示“订购即将开放”。

十一态夹具在 `shots/catalog-fixtures.ts`，清单在 `shots/catalog-scenes.ts`。运行 `LYX_E2E_CHANNEL=chrome pnpm weapp:shots -- --scene home-owner --scene home-clerk --scene home-guest --scene mall-default --scene mall-end --scene mall-empty --scene detail-owner --scene cart-default --scene cart-invalid --scene cart-price-changed --scene cart-clerk`，产物为 `shots/dist/png/catalog__<场景>.png`。不带场景参数时旧账户八态、建档九态和支付十一态仍保留；每场景独立上下文与既有外发网络、console.error、pageerror 守卫全部生效。

截图同时实际执行分页、复选/取消、删除、价格确认网络重试与自然重复加入；价格确认验证 P=1200、同 key 重试和 C50 重放后的 GET，不把固定离线图当真实 API 证据。H5 选剧单底栏仅在本页私有样式里为仿制标签栏让出 50px；小程序使用原生标签栏。原生导航、胶囊、安全区、下拉刷新与触底手势仍须 E16/E7 在开发者工具和真机上手验。

## W1-20 商家交付五页

方案 `sub/order/plan/index?deliveryPlanId=…`，样片和上线记录带 `orderItemId`，发布任务可带 `orderId` 或待办 `launchTaskId`，逐集下载带 `orderItemId`。全部只供当前门店老板；店员直接打开也不发本域业务请求。页面私有 API 工厂消费生成 merchant operations，生产仍经中央 request，不改已有封装。

`shots/delivery-scenes.ts` 登记十五态，产物 `shots/dist/png/delivery__<scene>.png`：plan-pending/revising/confirmed/change、sample-unsaved/viewed/confirmed、tasks-todo/verifying/live/submit、downloads-default/expired、record-default/returned。保存样片场景实际调用签发并重新 GET，再勾选；下载场景连续两次点击分别签发单集，不缓存 URL。默认截图保留实际主干原五十一态与全部错误守卫。H5 相册函数明确空转，仅验证界面与请求结构；真正微信 downloadFile → saveVideoToPhotosAlbum → 临时文件清理经可替换私有边界单测，真机效果仍等 V7。

本域同步锁先于订阅请求，确认分别用 plan_confirm、sample_confirm，成片保存 package_download，链接回填 link_submit；隐私拒绝不签发。写意图在所见版本/请求体不变时复用幂等键，C50 重放后重新 GET；下载无业务幂等键，每次独立签发。token、store、contextRev、role 改变或卸载后丢弃旧成功/错误，并停止后续相册操作。

## 确认订购、订单与发布账号（W1-18 PR2）

四页消费实际合入的 merchant DTO，生产仍走中央 request。选剧单与详情的“确认订购”进入 checkout；一次意图网络重试复用 key，账号、重点、模型或报价变化换 key。提交 expect 和协议版本都取当次报价；QUOTE_CHANGED 与 AGREEMENT_VERSION_STALE 按符号名刷新并重新勾选。C50 后重新 GET 订单及选剧单，再更新订单/账号/角标修订号。

本域十二态：`LYX_E2E_CHANNEL=chrome pnpm weapp:shots -- --scene checkout-default --scene checkout-points --scene checkout-qualification --scene checkout-quote-changed --scene orders-default --scene orders-empty --scene order-detail-default --scene order-detail-producing --scene order-success --scene accounts-default --scene accounts-rejected --scene accounts-bind`。夹具在 `shots/order-fixtures.ts`、`shots/publish-fixtures.ts`，场景清单分别为 `order-scenes.ts`、`publish-scenes.ts`。同域交互核对请求体、重试 key、报价变化、新版 expect、C50 后 GET、订单游标及切页签、账号绑定/核验重提；每场景保留独立上下文、外发网络、console.error 与 pageerror 守卫。旧账户8、建档9、支付11、商城11态及其断言全部保留。

主页截图由 `withPrivacy` 包选图，正式环境只用公共 `prepareTaroFile/createTaroUpload`，分类 `channel_screenshot`；最多3张，图片上限取公共 `UPLOAD_LIMITS.imageMaxMb`（5MB），通道由登记接口的 mode 决定。H5 截图的入库文件ID是显式离线替身，不是真实上传证据。订单交付入口由 W1-20 接通：方案取实际方案ID，剧目卡按本项阶段与时间线进入样片、成片、发布任务和上线记录；目标页写按钮仍按实时 GET 的 actions。广告、参考素材、视频、解绑、授权书及取消入口均不出。原支付结果状态保持。

H5 仍缺少原生导航栏、胶囊与真实安全区；下拉/触底、订阅授权、隐私授权和微信文件直传须在 E16/E7 到位后手验。本域离线图不能当作真实接口或微信授权/上传证据。

## 搜索页面（W3-13）

首页和商城的搜索入口以 navigateTo 打开 `sub/catalog/search/index`，原商城分类、筛选、排序和游标保留；详情只传既有 dramaId。热词取已发布 `m.mallConfig.get`，不硬编码运营词。本机历史只在真实提交时记归一后的关键词，最多十条、去重置顶、可清空；使用唯一登记的 `lyx.searchHistory`，不上报或写服务端。

输入去空白和中点、1–20 Unicode 码点。输入防抖300ms在页面私有 `SEARCH_DEBOUNCE_MS`，确认和热词/历史点击立即执行。query代次与现有contextRev/store/token共同保护首屏、更多、配置、错误和finally；换店/身份清结果与游标。三角色的价格与套餐、三字段匹配顺序、industry_fallback与totalApprox都取服务器真值，不按端上规则重算。接口未返回主演姓名，cast匹配仅显示“主演匹配”；标题/题材使用实际matchedFields切分Text高亮，禁止HTML。

八态清单在 `shots/search-scenes.ts`，运行 `LYX_E2E_CHANNEL=chrome pnpm weapp:shots -- --page sub/catalog/search/index` 或固定 `--scene search-idle/search-owner/search-clerk/search-guest/search-fallback/search-empty/search-error/search-more`（多态分别传多次参数）。产物 `shots/dist/png/search__<scene>.png` 为固定离线H5接线与交互证据，不能当真实API或微信真机验收。真实 mounted API 已以隔离库验证三角色配置/搜索/详情及实际换店晚响应；5条场景按首次4条通过、失效凭据定点1条通过分别记录。公开搜索的坏 token 按现有 optional-auth 返回游客字段；受保护 `/m/me` 的401触发中央恢复后，旧搜索响应不能写回，新游客资源重新查询。离线网络错误另行注入验证，不冒称后端故障。八态图与原首页/商城6场景分轮通过：原商城筛选/排序、搜索与详情往返保持；加载更多首次失败保留20条，重试同游标后24条去重。真机键盘、取消/确认、网络、原生导航与安全区、正式运营热词仍需外部手验。

## 素材库与详情只读阶段（W3-17）

`sub/asset/lib/index` 与 `sub/asset/detail/index` 消费既有 `m.storeAsset.list`、`m.storeAsset.summary`、`m.storeAsset.get` 三个 GET；老板和店员从“我的”进入素材库，详情路由只携带 storeAssetId。列表类型、状态、标签、本人和关键词筛选使用真实 DTO，分页按素材 ID 去重；类型计数、整理中及采用数均显示服务端 summary，不按当前页推算。详情展示原文、说明、全部文件、逐文件转写优先、整理要点、结构化条目、三维标签、复核与肖像材料事实、需求及使用记录。仅老板的已有短剧订单记录可跳转真实订单详情。

读取与预览绑定当前 token、主体成员、角色、可进门店、currentStoreId/contextRev 和请求代次；切店、失权、隐藏及卸载废弃旧结果，停止音视频并取消下载。文件现签缺失或过期时明确重取当前详情，再按原 fileId 查找；图片/音视频消费真实原生端口，文档经 downloadFile 后 openDocument，不猜文件类型，临时文件随后清理。生产请求使用中央 request，H5 仅在显式 asset scene 下装入离线夹具。

本阶段源码及轻量静态检查先交付，类型、完整旧新单测、生产体积与默认完整截图待串行验收；17 个新增候选场景登记在 `shots/asset-scenes.ts`，实际数量与 PNG 路径以本轮产出为准。纯端口测试覆盖同 token 的成员角色/范围变化及授权/下载迟到；当前 H5 回归没有相应 mutation 控制，不能当浏览器已证明。真实云签名内容、微信原生预览/播放/文档格式、隐私与安全区仍待真机手验。

上传、上传中心、反馈与补交授权操作、首页摘要和订单参考选择继续后续阶段；这两页没有未实现入口，两项 W3-17 留桩仍未回补，整包保持进行中。

## 微信分块上传平台构件（W3-17 后续准备）

`lib/upload/multipart.ts` 通过文件范围读取与原生 ArrayBuffer PUT 消费既有 multipart grant，不增加 SDK、依赖、HTTP 接口或云权限。块大小取服务端 `chunkSize`（当前 8MiB），端上块并发取 `min(chunkParallel, 2)`（当前 grant 上限 4）；原 POST 摘要和上传链保持。SHA1/HMAC-SHA1 使用 UTF-8/纯字节实现；COS 二次 HMAC 的 key 是第一次签名的十六进制文本。依据：[COS 签名](https://cloud.tencent.com/document/product/436/7778)、[UploadPart](https://cloud.tencent.com/document/product/436/7750)、[ListParts](https://cloud.tencent.com/document/product/436/7747)、[微信官方类型](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts)。

恢复记录只保存完整用户/成员/主体/角色/门店范围、原 fileId/对象、完整分块 MD5、UploadId、阶段和确认键，不含会话令牌、STS、签名 URL 或文件路径，写入后读回验证。重选文件逐块比较字节摘要；分页 ListParts 校验真实归属、分块大小与 MD5，只有云端确认的块计入进度。初始化前先保存 `initiating`；无回执时禁止重复初始化。合并前保存 `completing`，未知结果重试先查询原 UploadId；NoSuchUpload 仅转交原服务端 complete 确认，不当作 stored。取消只走既有 `m.file.cancel`，成功后清理本机记录，不宣称对象已物理删除。

普通 file 凭证没有 ListMultipartUploads 权限。本机第一次可保存 journal 后初始化一次；已有未知/损坏 journal 不自动重建 MPU。彻底清除本机记录后不能发现旧孤块，也不能证明没有旧 MPU；后续界面的“重新上传”须先明确取消原任务成功，再建立新意图。退出原账户清理本机记录，清理失败的残留仍由完整 owner 隔离。临时路径不承诺跨重启有效，失效时须重新选择完整相同文件。微信真实域名配置、STS/COS 回包、后台取消、断网重启与 2×8MiB 的实际内存峰值仍待真机/真实云外部验证；H5 保留 POST 近似能力，不假装支持原生分块恢复。

本片仅平台 SOURCE，未新增上传/上传中心页面。新增纯端口/摘要/持久化用例与原上传测试一起交唯一串行窗口验收；本地轻格式、AST/ESLint 不替代 fresh 类型、完整 41 旧测试文件/331 旧用例、默认 152 场景/154 PNG 及生产预算验证。

## 素材上传与当前成员任务（W3-17 A）

素材库进入 `sub/asset/upload/index`；图片、视频、录音、音频、文档和文字消费既有 typed 接口。标签仅取启用的 content 字典项，需求按真实游标单飞去重；文档按实际服务能力支持 PDF/DOCX/TXT。文件沿公共 prepareTaroFile/createTaroUpload，微信自动消费已合 multipart，H5 保留原 POST 能力。录音先隐私与麦克风授权，最长5分钟，可停止和试听；微信聊天文件选择、录音及真机内存仍待外部验证。

页内任务由本域运行时持有，离页只解绑界面，返回同一成员门店仍可见。全部文件实际确认 stored 且未拦截才创建素材，部分成功不重传已入库文件；创建回执未知保留同键同体确认。进度来自原上传器，100%不等于已创建素材。店员提交沿 asset_upload 订阅点位，业务成功计数由服务端直记。

本机意图最多20份文件、24小时，完整 owner 隔离，只有白名单表单、原登记 token/fileId 和确认键；不存路径、会话令牌、STS 或签名 URL，写后读回验证。冷启动须用户重选同一上传字节文件，原 multipart 继续校验完整摘要及真实 ListParts；完全遗失本机记录无法发现旧孤块。切成员/门店/角色/ctxRev 停止旧代次并隐藏任务，不当作服务端取消；换账号清理本域记录，失败残留仍按完整 owner 隔离。

取消未知只能用原 token/fileId/cancelKey 重试，登记回执未知先同 token 找回原登记，绝不初始化新 MPU；确认 expired 后才能新建意图。已入库文件不提供删除，部分入库说明明确保留事实。损坏公共 journal 不擅自清空或修复，保持 recovery_blocked；未知 Init 不盲目重发，未知 complete 沿原查询/确认协议。

四个新完整测试文件和16个 H5候选场景与原44/454、152/154全部一起交串行验证，当前仅 SOURCE 和轻静态检查。独立上传中心、反馈/肖像授权、首页摘要及订单参考仍留后续片；此页不代表 W3-17 整包退出。H5平台替身只证明接线和界面，不代表真实微信授权、云传输或跨杀进程恢复。


### W3-17 独立上传中心 B

`sub/asset/uploader/index` 从上传页“上传中心”进入，也可由中心进入“上传新素材”。两页消费同一当前成员任务仓；页面离开只清理本页选择器，不销毁共享上传任务。进度、入库和提交回执均读原上传器/服务端事实；失败重试、同意图取消、取消未确认阻止重新上传、冷启动重选完整相同文件均沿 A 的既有协议。

H5 新增 empty/active/failed/recovery/cancel-error/scope-late 六场景，验证真实 Taro 跨页与返回留存、请求次数、错文件零请求、取消同 key 和 ctxRev 迟到拒写。原 48 whole/601 cases、168 场景/170 PNG 保留，候选目标为 174 场景/176 PNG；通过数量以新完整验证原始报告为准。真机大文件、app hide/show、微信权限、临时文件与真实云续传仍待外部验证，B 不宣称新增实测。

## 素材详情反馈与肖像材料

详情页仅按既有 `StoreAssetDetail.actions` 提供反馈和补授权入口。反馈为1–200字，
可指定标签维度；未知回执保留原正文及幂等键，已满每日次数显示服务端错误。
补授权独立使用 `portrait_auth` 的图片/PDF分类、正式文件上传与确认链；全部真实
stored且未block才可提交。部分失败保留已入库材料，重试原job；取消未知保留原
文件登记及取消键，确认后才能重新选择。既有素材上传任务仓与公共上传协议不变。

本页只在内存保存本批材料，离页停止未完成上传，不承诺跨页面恢复；已入库文件由
服务端保留规则处理。完整成员/主体/角色/店范围、token与contextRev守卫异步；隐藏
暂停，回前台复用原job结果。授权提交成功后重取详情，重放与刷新失败均不撤销已
确认补交，材料仍等待交付经理确认。商家端不签发或预览安全桶授权材料。

六个独立 `asset-action-*` H5场景只验证详情交互，不代表微信隐私授权、真实图片/PDF
内容、云存储或重启恢复。2026-10-13 调度验证通过 weapp 类型、三个相关文件的48项
测试、生产/H5构建及六个新场景；文案/浏览器断言修正后未重复旧全量。消费已合
W3-14写口和既有W3-15读侧，不代表W3-15或W3-17整包完成。


## 订单参考素材（W3-17）

确认订购新增可选参考区域，消费真实 `m.storeAsset.list?isSelectableAsReference=true`、
服务端每项可参考标记及游标，最多9条；需肖像授权的素材可以参考，选择不等于采用。
参考ID只附加到原create提交，空选择仍省略该字段，不进入报价请求，不重算积分或
变更协议/原订购意图。显式选择或移除沿原changed换key，同意图网络重试保持原key。
后台刷新只更新展示与可参考性，不删除已选ID或改变提交key；失效项由用户明确移除，
最终合法性仍由服务端原守卫裁决。订购在途同步锁阻止选择改变。

详情读取订单返回的真实referenceStoreAssetIds，再按ids模式取卡片；缺失素材明确
提示无法查看，当前不可参考的历史引用仍可回显。完整成员/主体/角色/门店范围、
token/contextRev及卸载/隐藏使晚结果失效，签名不进入路由或持久化。

2026-10-13 ROOT验证通过weapp类型、两个相关文件14项测试（含7组新增关键测试）、
生产构建（总计913.1KB，原体积门槛通过）、H5构建及3个独立order-reference场景。
唯一独立审查已收口后台刷新换意图的竞态，无剩余生产阻断；截图定位到本片参考区域。
仅执行本片定点及最小旧回归，未重复旧全量或声明远端CI。订单参考留桩已回补，
首页摘要仍留后继，整包W3-17继续进行中；真机/真实云不在本轮验证。
