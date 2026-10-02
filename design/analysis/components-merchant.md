# 狸有戏 · 商家端小程序组件规格（从原型提取）

依据：`prototype/merchant/src/*.dc.html`（47 个画板，390×844）、`stats.json`、渲染截图、PRD 8.3。
出处写法：`画板名:行号`（行号指 `.dc.html` 源码行）。数值一律照抄源码内联样式。
标记：**【源码】** = 原型里明确如此；**【建议】** = 本报告的归纳或实现建议，需评审确认。
"N 处 / M 板" 为脚本对内联样式的计数（同一写法出现次数 / 涉及画板数）。

---

## 0. 尺寸换算（先读）

| 项 | 内容 |
| --- | --- |
| 原型基准【源码】 | 根容器 `width: 390px; height: 844px`（全部 47 板）；横向几乎全是弹性布局（`flex-grow`、`grid repeat(n, minmax(0,1fr))`、`aspect-ratio`），页面左右边距固定 16px |
| 参考工程做法 | `apps/mobile/config/index.ts`：`designWidth: 375`，`deviceRatio{375: 2}`，即样式里 1px → 2rpx；`pxtransform.selectorBlackList: ["nut-"]`（NutUI 自带样式按 375 处理，不再转换）；`docs/05-mobile-guide.md` §样式："行内 style 不过 pxtransform，所以尺寸一律写在样式文件里" |
| 【建议】换算方式 | **保持 `designWidth: 375`，原型里的 px 数值 1:1 照抄进 `.scss`（不乘 375/390）**。理由：① PRD 8.3 的字号层级（17/15/13/12）与原型一致，按 375 基准照抄后在 375 宽设备上正好是这些值，在 390 宽设备上等比放大 4%；② NutUI 组件按 375 出样式，改成 390 会让 NutUI 部件与自写部件差 4%；③ 原型横向是弹性的，内容区从 358 变 343 不会破版 |
| 需要改写而非照抄的"绝对值"【建议】 | 弹层 `max-height: 760px`（=844−84）→ `90vh`；AdDetail 全屏预览 `390px × 693px`（AdDetail:60）→ `100vw` + `aspect-ratio: 9/16`；Trailer 里的绝对定位坐标（`top: 300px`、`bottom: 136px` 等，Trailer:33-50）→ 改相对底部/安全区定位；聊天气泡 `max-width: 286px`（Ticket:48）→ `calc(100% - 40px)`；胶囊占位 `87×32`（见 §1）→ 运行时取 `getMenuButtonBoundingClientRect()` |
| 动态值【建议】 | 状态色不要用行内 style 传 px；用 className 修饰符（`--ok/--info/--warn/--danger/--neutral`）。只有来自设备的 px（胶囊位置、状态栏高）才走行内 style（参考 `src/utils/nav.ts`） |
| 边线【建议】 | 原型全部是 `1px solid`；参考工程 token 用 `0.5px` 发丝线。二选一需设计拍板（见开放问题） |
| 色值与 token | 原型主色 `#C4501B`、文字 `#1D1A16`、页面底 `#F6F3EE`，与参考工程 `tokens.scss` 的 `$liyo-brand #d75011` 等**不同**，需按原型另建一份 token（由设计令牌报告负责），本报告直接写色值 |

---

## 1. 页面骨架

### 1.1 原型里的结构【源码】

```
根容器 390×844，flex column，overflow hidden，background #F6F3EE，color #1D1A16
├─ header            高 48，flex-shrink 0                （47 板都有）
├─ 副栏（可选）       标签栏 / 步骤条 / 搜索行，flex-shrink 0   （10 板在 header 与 main 之间）
├─ main              flex-grow 1，min-height 0，overflow-y auto ← 唯一纵向滚动区
├─ footer 底部操作栏   高 72（23 板）  或  底部标签栏 高 64（5 板）；Cart 两者都有
└─ 遮罩 + 弹层        position absolute，盖住包括 header 在内的整页
```

| 区域 | 规格（照抄源码） | 出处 |
| --- | --- | --- |
| 导航栏 | `height: 48px`，标题居中 `font-size: 17px; font-weight: 600`（45 板）；无底色（透出页面底 #F6F3EE）；**原型未画状态栏** | Orders:23-25 等 |
| 返回按钮 | `position: absolute; left: 2px; top: 2px; width: 44px; height: 44px`，图标 24×24 `stroke-width="2"`，色 #1D1A16（38 板）。无返回的 9 板：Cart、Join、Login、Main、Mall、Mine、PayResult、StoreSwitch、Trailer | Orders:24 |
| 胶囊占位 | `right: 8px; top: 8px; width: 87px; height: 32px; border: 1px solid #E2DBD0; border-radius: 16px; background: #FFFFFF`（`aria-hidden`，46 板同一写法） | Orders:26 |
| 导航栏特例 | Main：标题为衬线字标 `'Noto Serif SC'; 19px; 900; letter-spacing: 2px`；Orders：`background: #FFFFFF`（与下方白底标签栏连成一体）；Trailer：`position: absolute` 叠在画面上，白字，返回为"‹ 列表"文字（15px），胶囊 `border rgba(255,255,255,0.35); background rgba(0,0,0,0.25)`；Login：无标题 | Main h1；Orders:23；Trailer:22-25 |
| 内容区 main | 主流写法 `padding: 4px 16px 20px; display: flex; flex-direction: column; gap: 12px`（22 板）；底部留白 24px 的 13 板；顶部 0/2/4/12px 都有；Main `gap: 16px`；MyDramas、Search `gap: 14px`；Detail 无左右 padding（卡片自带 `margin: 0 16px`，头图通栏） | 见 §1.3 |
| 副栏 | 步骤条 `padding: 6px 16px 12px`（Profile* 4 板）；下划线标签栏通栏白底（Orders、Publish）；分段/筛选条 `padding: 0 16px 8~10px`（Contracts、Invoices、Messages、MyDramas）；均不随 main 滚动 | ProfileStore:32；Orders:32 |
| 底部操作栏 | `height: 72px; padding: 0 16px 8px; background: #FFFFFF; border-top: 1px solid #ECE6DD; display: flex; align-items: center; gap: 12px`（23 板）；内放 1~2 个 46 高按钮，等分 `flex-grow: 1; flex-basis: 0` | AdDetail:54 |
| 操作栏特例 | Detail：`height: 76px; padding: 0 16px 10px; gap: 8px`，左侧两个 44 宽图标+文字（图标 22，文字 12px #6F665B），右侧两个按钮；Join：`height: 80px`；Cart：`min-height: 64px; padding: 8px 16px`，位于标签栏之上（全选 + 合计 + 按钮）；PayResult：无底色无边线 `padding: 12px 16px 24px; background: #F6F3EE`；Ticket：操作栏里放输入条（§7） | Detail:44-48；Cart:37-43 |
| 底部标签栏 | `height: 64px; padding-bottom: 8px; background: #FFFFFF; border-top: 1px solid #ECE6DD; display: grid; grid-template-columns: repeat(4, minmax(0,1fr))`；4 项：首页 / 短剧商城 / 选剧单 / 我的；图标 24×24 `stroke-width 1.8`，文字 12px，图标与文字 `gap: 2px`；未选 #6F665B，选中 #C4501B 且文字 `font-weight: 600`；出现在 Main、Mall、Cart、Mine、StoreSwitch | Main 末尾 nav |
| 标签栏角标 | `top: 5px; left: 50%; margin-left: 6px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: #C4501B; color: #FFFFFF; font-size: 11px; font-weight: 600; line-height: 16px`（选剧单数量） | Cart:47 |
| 层次（自下而上） | 页面内容 → 副栏/操作栏/标签栏 → 遮罩 `rgba(15,14,12,0.5)`（16 处）→ 底部弹层 → 全屏预览（#000000） | AdDetail:59-64 |

### 1.2 小程序实现【建议】

| 主题 | 建议 |
| --- | --- |
| 导航栏 | PRD 8.3 第 1 条要求"使用原生导航栏，胶囊区不放操作"。二级页全部用原生导航：`navigationBarBackgroundColor: "#F6F3EE"`、`navigationBarTextStyle: "black"`，标题写在 `index.config.ts`，页面内**不再画** 48px 的 header。Orders 一页把导航栏底色设为 `#FFFFFF` |
| 必须自绘导航的页面 | Main（衬线字标）、Trailer（沉浸式白字）、Login（无标题）。用 `navigationStyle: "custom"` + 参考工程 `PageHeader` 的做法：行顶 = 胶囊 `top`，行高 = 胶囊 `height`，均取 `getNavMetrics()`（设备 px，行内 style） |
| 胶囊避让 | 自绘页头右侧留白 = `窗口宽 − 胶囊.left + 8`；取不到时回落 87 + 8 = 95px（原型占位值；参考工程 token 为 `$liyo-nav-inset: 88px`）。该区域不放任何可点元素；Trailer 的"静音"按钮（`left: 24px; top: 72px`）在胶囊下沿之外，可保留 |
| 标签栏 | 用**微信原生 tabBar**（参考工程结论：Taro 4.2 Vite 不产出 `custom-tab-bar`）：`color #6F665B`、`selectedColor #C4501B`、`backgroundColor #FFFFFF`；图标按原型 24 网格线性图标导出 PNG（未选/选中两套）；角标用 `Taro.setTabBarBadge`。原生不支持：选中文字加粗、自定义角标色、`#ECE6DD` 顶边线 |
| 底部操作栏 | `position: fixed; bottom: 0`，内容高 64 + `padding-bottom: calc(8px + env(safe-area-inset-bottom))`；页面内容底部补 `72px + 20px` 留白（参考工程有 `$liyo-fab-safe`、`liyo-dock` 同类做法）。Cart 在 tab 页内，操作栏贴在原生 tabBar 之上，不需安全区 |
| 滚动 | 用页面级滚动，不套整页 `ScrollView`；副栏用 `position: sticky; top: 0`（自绘导航页为胶囊下沿），底色必须不透明。只在三处用局部滚动：横向筛选条 / 横滑推荐（`overflow-x: auto`）、弹层正文（`max-height` 内滚动）、Ticket 对话区（进入时滚到底部） |
| 通栏横滑 | AssetLib 筛选行 `margin: 0 -16px; padding: 0 16px`（顶出页边距做满幅，源码写法），其余横滑条照此处理 |
| 加载与失败 | 原型**没有**任何加载中 / 骨架 / 加载失败画面（全量搜索 0 处），需补（见开放问题）。建议沿用参考工程"三态"：有内容 / 确实为空 / 还没拉到 |

### 1.3 长页面的滚动区域【源码】

| 画板类型 | 固定不动 | 滚动 |
| --- | --- | --- |
| 详情/表单（AdDetail、OrderDetail、Checkout、Profile* 等 23 板） | 导航栏、（步骤条）、底部操作栏 72 | main：卡片纵向堆叠 gap 12 |
| 列表（Orders、Publish、Contracts、Invoices、Messages、MyDramas） | 导航栏、标签/分段/筛选副栏 | main |
| Tab 首页（Main、Mall、Mine、Cart） | 导航栏、（Mall 的搜索+分类+排序三行，位于 main 之外）、标签栏 | main；Main 内含横滑推荐 `gap: 10px` |
| Ticket / TicketDone | 导航栏、底部输入条 | main `padding: 4px 16px 16px` |
| Trailer | 整屏不滚动，绝对定位 | — |

---

## 2. 按钮

### 2.1 规格【源码】

| 变体 | 尺寸 / 圆角 | 底色 · 描边 | 文字 | 出处（代表） |
| --- | --- | --- | --- | --- |
| 主按钮（大） | `height: 46px; padding: 0 16px; border-radius: 23px` | `background: #C4501B; border: none` | `15px / 600 / #FFFFFF` | AdDetail:55、Wallet:49、TopUp:53、Members:48（46 高写法合计约 40 处） |
| 次按钮（大，中性描边） | 同上 | `background: #FFFFFF; border: 1px solid #C9C0B3` | `15px / 600 / #1D1A16` | AdDetail:55、Ticket:68、OrderDetail:120 |
| 次按钮（大，主色描边） | `height: 46px; border-radius: 23px`（Cart 为 44/22） | `background: #FFFFFF; border: 1px solid #C4501B` | `15px / 600 / #A63F12` | Detail:47（加入选剧单）、Cart:41、Orders:48 |
| 主按钮（中） | `height: 44px; border-radius: 22px`；Cart `padding: 0 20px` | 同主按钮 | `15px / 600` | Cart:40、Ticket:53、Accounts/Sample/Service |
| 主按钮（小） | `height: 40px; padding: 0 16px; border-radius: 20px` | 同主按钮 | `14px / 600`（Search 为 15px） | Ticket:52（发送）、Search:34、Ads |
| 主按钮（迷你） | `min-height: 34px; padding: 0 14px; border-radius: 17px` | 同主按钮 | `13px / 600` | Ads |
| 主按钮（特大） | Login `height: 50px; border-radius: 25px`；Trailer `height: 48px; border-radius: 24px` | 同主按钮 | `16px / 600`，Login 带 20 图标 `gap: 8px` | Login footer、Trailer:52 |
| 胶囊小按钮 | `min-height: 32px; padding: 0 12px; border-radius: 16px` | `background: #FFFFFF; border: 1px solid #E7E1D8` | `13px / 常规 / #1D1A16`；带图标时图标 16，`gap: 4px` | Members、PlanPick、TopUp:62（复制）、Mine:35（切换，`padding: 0 10px`）、OrderDetail:99（约 35 处） |
| 中号描边 | `height: 42px; border-radius: 21px`；Orders `min-height: 36px; padding: 0 14px; border-radius: 18px; 14px` | `border: 1px solid #C9C0B3`（Orders 为 #E7E1D8） | `14~15px / 600` | Wallet:38、AssetUpload、Orders |
| 文字按钮 | `min-height: 32px; padding: 0 4~10px; border: none; background: none` | — | `13px`；主色 #A63F12（Messages:36 全部已读、Ledger）；弱 #6F665B（Ticket:37 撤回工单）；绿 #256A42（PlanPick、TopUp） | 见左 |
| "查看更多"链接 | 文字 + 右箭头 14（`stroke-width 2`），`gap: 2px` | — | `13px / #A63F12`（卡片标题右侧，10 板）；弱化版 `13px / #6F665B` + "›"（Main:全部订单 ›） | OrderDetail:69、Wallet:36、AdDetail:48 |
| 图标按钮 | 点击区 `44×44`，图标 22~24 | 无底 | 关闭图标色 #6F665B | 返回（§1）、弹层关闭 AdDetail:67 |
| 深底描边按钮 | `height: 40px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.4)`；AdDetail 全屏 `44px / rgba(255,255,255,0.6)`；Trailer `48px / rgba(255,255,255,0.7)` | 透明 | `14~16px / 600 / #FFFFFF` | Wallet 深色卡、AdDetail:60、Trailer:51 |
| 虚线添加按钮 | `min-height: 48px; border: 1px dashed #C9C0B3; border-radius: 14px; background: #FFFFFF`，图标 + 文字 `gap: 6px` | — | `15px / #1D1A16`（AssetUpload 为 `min-height: 40px; border-radius: 12px; 14px #4A433B`） | Accounts、AssetUpload |

### 2.2 状态【源码】

| 状态 | 表现 | 出处 |
| --- | --- | --- |
| 禁用（主按钮） | `background: #D6CFC4`；文字 **#FFFFFF**（AdDetail:56"第 2 版制作中"）或 **#4A433B**（Cart:42、Checkout:83"去订购"）——两种写法并存 | 见左 |
| 禁用（透明度） | ProfileReview 重新提交：`opacity: 0.4; cursor: not-allowed` | ProfileReview:110 |
| 禁用（胶囊） | `border: 1px solid #ECE6DD; background: #F6F3EE; color: #6F665B` | TicketDone:53 |
| 已完成切换 | Publish 下载/复制按钮完成后：文字 #256A42、描边 #BFDCC9 | Publish:154-159 |
| 按下 / 加载中 | 原型未定义 | — |

### 2.3 实现【建议】

- 用 NutUI `Button`（3.0.20，props：`type / size / shape / fill / block / loading / disabled / icon`）。主按钮 `type="primary"`；中性描边 `type="default"`；主色描边 `type="primary" fill="outline"`；文字按钮 `fill="none"`。
- 主题在 `app.scss` 用 CSS 变量覆盖：`--nutui-color-primary: #C4501B`、`--nutui-button-large-height: 46px`、`--nutui-button-large-font-size: 15px`、`--nutui-button-border-radius: 23px`（全圆角）、`--nutui-button-default-border-color: #C9C0B3`、`--nutui-button-default-height: 44px`。
- 尺寸收敛为 4 档：大 46（操作栏、弹层）/ 中 40（行内、输入条）/ 小 32（胶囊）/ 特大 48（Login、Trailer）。44、42、36、34 并入邻近档（见不一致清单）。
- 胶囊小按钮、图标按钮、"查看更多"链接自己写（NutUI mini 尺寸与 32 高/16 圆角/#E7E1D8 描边差距大，覆盖成本高于自写）。

---

## 3. 标签与角标

### 3.1 状态标签【源码】

通用形状：`font-size: 12px; font-weight: 600; padding: 1px 6px; border-radius: 4px; white-space: nowrap; flex-shrink: 0`（68 处，约 25 板）。

| 语义（PRD 8.3 第 4 条） | 底色 | 文字色 | 原型里用它的文案（取自静态标签与 script 映射表） |
| --- | --- | --- | --- |
| 成功（绿） | `#E6F2EA` | `#256A42` | 已认证、已确认、已核验、核验通过、审核通过、识别成功、已采用、已解决、处理结果、生效中、上线中、正常、已开具、已质检、门店定制、当前、续费（AdDetail:107、Ticket:101、Contracts:79、Invoices:108、PlanPick:99、AssetLib:50） |
| 进行中（蓝） | `#E8EEF9` | `#2E5AAC` | 处理中、修改中、制作中、样片制作中、整理中、待生效、待接受、开票中（Invoices:108 非"已开具"分支）、新剧（AdDetail:106、Ticket:101、Contracts:79） |
| 待处理（橙） | `#FBEDE5` | `#A63F12` | 待确认、待您确认、样片待确认、待受理、重新打开、积分价已变动、需肖像授权、当前门店、套餐积分、升级、上线任务（AdDetail:105、Ticket:101、Ads:139、Publish:151、Ledger:46） |
| 失效/错误（红） | `#FCEBEA` | `#B42318` | 核验未通过、已失效（Cart）、已过期、证照模糊、无法识别、待处理（Main 待办） |
| 已结束/中性（灰） | `#F1ECE4` | `#4A433B` | 已关闭、已失效（Contracts:79）、店员、补充说明、提交工单、即将开放、V1.1 开放、加购积分、降级（PlanPick:108） |
| 信息标签（灰底深字） | `#F1ECE4` | `#1D1A16`（或继承） | 餐饮 / 火锅、可直接使用、成都 · 火锅（多为 `font-weight` 常规）（Mine:35、Profile、AssetLib:50） |

| 其他标签 | 规格 | 出处 |
| --- | --- | --- |
| 纯文字状态 | 无底色，`13px / 600`，颜色同上表文字色：制作中 #2E5AAC、上线中 #256A42；"已签署" `13px #256A42` | Orders:39,42；OrderDetail:97 |
| 待办标签（首页） | `12px / 600; border-radius: 6px; padding: 3px 6px`（橙、红两色） | Main 待办提醒 3 处 |
| 封面角标 | `left: 10px; top: 10px; 12px / 600; padding: 2px 6px; border-radius: 4px; background: #FFFFFF`，字色：热播 #A63F12、新剧 #2E5AAC | Main、Mall:58 |
| 会员等级胶囊 | `display: inline-flex; gap: 4px; 12px / 600; padding: 1px 8px 1px 6px; border-radius: 10px; background: #1D1A16; color: #F2B48F; line-height: 20px`，前置皇冠图标 14 | Main、Mine:38、Ledger:34、TopUp:37（7 处） |
| 深底权益标签 | `12px; padding: 2px 8px; border-radius: 10px; background: rgba(255,255,255,0.12); color: #F6F3EE` | Wallet:33（7 处） |
| "广告"标识 | `12px / 600; padding: 2px 8px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.8)`，无底 | Sample:33、AdDetail:36 |
| 画面上的说明标签 | `12px; padding: 3px 8px; border-radius: 4px; background: rgba(0,0,0,0.4)`；缩略图时长 `11px; padding: 0 5px; border-radius: 4px; background: rgba(15,14,12,0.55); line-height: 18px` | Sample:32、AssetUpload:41 |
| 数字角标 | 列表行：`min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #C4501B; 12px / 600 白字`；筛选条内：16 高、`background: #B42318`、11px；未读红点：`10×10; border-radius: 5px; background: #B42318; border: 2px solid #FFFFFF`，位于头像右上 `right: -1px; top: -1px` | Mine:57；Messages:33,36 |

### 3.2 实现【建议】

自己写一个 `StatusTag`（props：`tone: ok | info | warn | danger | neutral`，`children`），再集中维护一张"业务状态 → tone"的映射表（订单、工单、广告、合同、发票、素材、成员各一份），页面不得直接写色值。NutUI `Tag` 的圆角、内边距、字重都要覆盖，且参考工程也未使用（`styles/nutui.ts` 注释：标签已由自有组件提供），不建议用。数字角标可用 NutUI `Badge` 或自写（自写更省，一共三种尺寸）。

---

## 4. 卡片与分组

| 项 | 规格【源码】 | 出处 |
| --- | --- | --- |
| 标准卡片 | `background: #FFFFFF; border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 12px`（42 处 / 21 板）；`gap: 10px`（25 处 / 15 板）、`gap: 14px`（8）、`gap: 8px`（6）、`gap: 16px`（表单卡，3）。**无描边、无阴影** | AdDetail:37,43,47；OrderDetail:33 |
| 紧凑卡片 | `padding: 14px 16px`（列表项卡：Orders:39、Main 上线概览、Contracts、Invoices） | Orders:39 |
| 列表容器卡 | `padding: 4px 16px; flex-direction: column`（行自带高度与分隔线，7 板） | Mine:49、Members:40 |
| 头部大卡 | `border-radius: 16px`：Mine 门店卡 `padding: 16px 16px 0`、积分卡 `padding: 14px 16px 12px` | Mine:35,37 |
| 深色卡 | `background: #1D1A16; color: #FFFFFF; border-radius: 16px`：Wallet `padding: 18px 16px 16px`；Main 横幅 `height: 132px; padding: 0 20px`；眉标 `12px; letter-spacing: 2px; color: #F2B48F`，次文 #E9E3DA | Wallet:33、Main 横幅 |
| 剧目宫格卡 | `background: #FFFFFF; border-radius: 12px; padding: 8px 8px 12px; gap: 4px`，两列 `gap: 12px` | Main、Mall:54 |
| 卡内浅底块 | `background: #FAF8F4; border-radius: 10px; padding: 12px`（或 `10px 12px` / `8px 10px; radius 8px`），可带 `border: 1px solid #ECE6DD` | AdDetail:40、Checkout:53、OrderDetail:101 |
| 着色卡 | 橙 `background: #FBEDE5; border-radius: 14px; padding: 12px 16px`（Mine 服务经理）；蓝/绿 `border-radius: 14px; padding: 16px`（Sample、OrderDetail） | Mine:44 |
| 卡片标题 | `h2 margin: 0; font-size: 16px; font-weight: 600`（44 处 / 22 板）；标题行右侧放"查看更多"链接或 12px #6F665B 说明 | AdDetail:44、Checkout:42 |
| 卡外分组标题 | `17px / 600`（Main 为你推荐）；`16px / 600` + 右侧 `12px #6F665B` 计数（Ticket:47）；卡内小分组 `13px / 600 / #6F665B`（Messages、Ledger 按日/月） | 见左 |
| 分隔线 | `1px solid #F0EBE3`（卡内行间，75 处）；`1px solid #ECE6DD`（栏的顶/底边，45 处）；独立分隔 `height: 1px; background: #F0EBE3` | Ticket:43 |

实现【建议】：自写 `Card`（`padding`、`gap` 两个档位参数）与 `Section`（标题 + 右侧动作 + 内容），对应参考工程 `components/Card`、`components/Section`。卡内 `gap` 收敛为 12（内容）/ 16（表单）两档。

---

## 5. 列表行

| 变体 | 规格【源码】 | 出处 |
| --- | --- | --- |
| 菜单行 | `display: flex; align-items: center; gap: 12px; min-height: 52px; border-bottom: 1px solid #F0EBE3`（末行无线）；左图标 22（`stroke #4A433B`，1.8）；标题 `15px`；右值 `13px #6F665B`，需提醒时 `#A63F12`；右箭头 16（`stroke #6F665B`） | Mine:50-59（18 处） |
| 待办行 | `gap: 10px; min-height: 52px`；标签 + `14px` 文案 + 箭头 18 | Main 待办 |
| 双行行（带头像/图标） | 左侧 36~44 的图标块或头像，中间标题 `15px / 600` + 副文 `12px #6F665B`（`gap: 2~3px`），右侧标签或箭头；行高：Checkout 账号 `min-height: 60px`、Profile `64px`、Members `68px`、Contracts `72px; padding: 12px 0`、ProfileService `76px; padding: 10px 0`、Messages/Ledger `padding: 12px 0`（无 min-height） | Checkout:43、Members:40、Messages:36 |
| 入口卡行 | 整张卡是一行：`padding: 14px 16px; gap: 12px`，图标块 `40×40; border-radius: 12px; background: #FBEDE5; color: #A63F12`（图标 22） | Mine:42 |
| 键值行（可复制） | `gap: 8px; min-height: 40px; border-bottom: 1px solid #F0EBE3`；键 `width: 64px; 13px #6F665B`，值 `14px`，右侧"复制"胶囊小按钮 | TopUp:62、PlanPick（8 处） |
| 键值网格 | `display: grid; grid-template-columns: 64px minmax(0,1fr); row-gap: 8px; column-gap: 8px; font-size: 13px; line-height: 1.5`，键色 #6F665B；键宽另有 72px（`font-size: 14px`，OrderDetail:70,88）、96/104px（授权书预览） | AdDetail:45、Ticket:44 |
| 金额明细行 | `display: flex; justify-content: space-between; gap: 8px; font-size: 14px`；数字 `font-variant-numeric: tabular-nums`；合计行 `15px / 700` | Checkout:72-75、OrderDetail:81-83 |
| 统计格 | 三等分网格；数字 `22px / 700`，单位 `13px / 400 / #6F665B`，标签 `13px #6F665B`，`gap: 2px`；Mine 版居中且中间格左右 `1px solid #F0EBE3` | Main 上线概览；Mine:43 |

实现【建议】：自写 `List` / `ListRow`（props：`leading`、`title`、`description`、`value`、`valueTone`、`arrow`、`badge`），对应参考工程 `components/List`；键值网格自写 `DescList`（`labelWidth` 默认 64）。不用 NutUI `Cell`（行高、分隔线缩进、箭头都要覆盖）。双行行的最小高度建议统一为 64。

---

## 6. 表单

| 项 | 规格【源码】 | 出处 |
| --- | --- | --- |
| 字段结构 | 纵向 `gap: 6px`：标签 → 控件 → 说明/错误；字段之间 `gap: 16px`（表单卡） | ProfileBasic:36-55 |
| 标签 | `font-size: 14px; font-weight: 600`（35 处 / 14 板）；必填星号 `color: #B42318`；右侧可带 `12px #6F665B`"选填"或 `13px` 计数"2/3"（超限时 #B42318） | AdDetail:72、ProfileStore:43 |
| 单行输入 | `height: 44px; padding: 0 12px; border: 1px solid #E7E1D8; border-radius: 10px; font-size: 15px; color: #1D1A16; background: #FFFFFF` | ProfileBasic:39、Invoices |
| 多行输入 | `padding: 10px 12px; border: 1px solid #E7E1D8; border-radius: 10px; font-size: 14px; line-height: 1.5; resize: none`，`rows` 2/3/5；计数 `12px #6F665B` 右对齐（"12/500"） | AdDetail:72、AssetUpload:44 |
| 占位符色 | `#6F665B`（每板 `<style>` 第 16 行 `input::placeholder`） | Orders:16 |
| 错误态 | 边框 `#B42318`；错误文案 `role="alert"`，`12px #B42318`（Profile* 等 5 板 8 处）或 `13px #B42318`（AdDetail、Invoices、Plan、Ticket 等 6 处） | ProfileBasic:116、Invoices:134-136、AdDetail:73 |
| 说明文字 | `12px; line-height: 1.5; color: #6F665B` | ProfileBasic:44,49 |
| 选择器入口 | 按钮形如输入框：`height: 44px; padding: 0 12px; border: 1px solid #E7E1D8; border-radius: 10px; justify-content: space-between; 15px`，右箭头 18（#6F665B）；输入框右侧并排按钮同高（"地图选点" 14px，图标 16） | ProfileBasic:53,60 |
| 紧凑输入 | Ticket 输入条：`height: 40px; padding: 0 14px; border-radius: 20px; background: #F6F3EE; 14px`；Publish 链接：`height: 40px; padding: 0 10px; border-radius: 8px` | Ticket:52、Publish:74 |
| 搜索框 | `height: 40px; padding: 0 14px; border-radius: 20px; background: #FFFFFF; border: 1px solid #E7E1D8; gap: 8px`，放大镜 18，字 `14px`，占位 #6F665B；聚焦态（Search 页）`border: 1px solid #C4501B`、字 `15px`、右侧清除钮；旁边"搜索"主按钮 40 高 | Main、Mall:30、Search:33-34 |
| 复选框 | 原生控件 `width: 18px; height: 18px; accent-color: #C4501B`（15 处）；Cart 为 20×20；协议勾选为 16×16；不可选占位 `20×20; border: 1px solid #D6CFC4; border-radius: 4px; background: #F1ECE4` | Checkout:43,59；Cart:33-35 |
| 单选卡（支付方式） | `min-height: 56px; padding: 8px 12px; border-radius: 12px; border: 1px solid {边}; background: {底}`，内含 18 原生单选 + 标题 `15px / 600` + 副文；选中 边 #C4501B / 底 #FFF8F3，未选 边 #E7E1D8 / 底 #FFFFFF | TopUp:49,106 |
| 勾选卡 | `padding: 10px 12px; border-radius: 10px`，颜色同上；标题 `14px / 600` + 说明 `12px` | Checkout:59,113 |
| 开关 | 轨道 `width: 34px; height: 20px; padding: 2px; border-radius: 10px`，滑块 `16×16; border-radius: 8px; #FFFFFF`；开 #C4501B / 关 #D6CFC4；文字 `14px`，`gap: 6px`，整体点击区 `min-height: 44px` | Mall:46,133 |
| 选项胶囊（表单多选/单选） | `min-height: 34px; padding: 0 12px; border-radius: 17px; border: 1px solid; font-size: 13px`；选中 底 #FFF8F3 / 边 #C4501B / 字 #A63F12；未选 底 #FFFFFF / 边 #E7E1D8 / 字 #1D1A16；禁用 底 #F6F3EE / 字 #9A9084（Invoices:116）。大号：`min-height: 40px; padding: 0 14px; border-radius: 20px; 14px`，两列网格 `gap: 8px` | Checkout:50,95；AssetUpload:82；Ticket:64,142 |
| 选项卡片 | `min-height: 52px; padding: 6px 10px（或 10px 12px）; border-radius: 10px`；选中 `border: 2px solid #C4501B` 并把 padding 各减 1px 保持尺寸，底 #FFF8F3（AdDetail:140）或 #FBEDE5（Accounts:99、Ads:119）；未选 `1px solid #E7E1D8` / #FFFFFF | 见左 |
| 积分包卡 | `min-height: 84px; padding: 12px; border-radius: 14px; border: 1px solid`，两列 `gap: 10px`；数字 `20px / 700` + "积分" `13px / 400`；价格 `13px`（选中 #A63F12，未选 #6F665B） | TopUp:42,96 |
| 类型磁贴 | 六列 `gap: 6px`；`min-height: 60px; padding: 6px 0; border-radius: 12px`，图标 20 + 文字 `13px`，`gap: 4px`，选中配色同选项胶囊 | AssetUpload:37,74 |

实现【建议】

| 部件 | 做法 |
| --- | --- |
| 字段外壳 | 自写 `Field`（label / required / hint / error / extra），对应参考工程 `components/Field`；不使用 NutUI `Form`/`FormItem` 的横排样式 |
| 单行输入 | Taro 原生 `Input` 外包一层样式（NutUI `Input` 默认无描边、行式布局，覆盖量大） |
| 多行输入 | NutUI `TextArea`（参考工程已用），打开 `showCount`，覆盖边框与圆角 |
| 复选 / 单选 | 自写 `Checkbox`（参考工程有同名自有组件），统一 18×18、圆角 4、选中底 #C4501B 白勾；单选卡、勾选卡整卡可点 |
| 开关 | NutUI `Switch`（参考工程已用），用 CSS 变量调到 34×20 |
| 选项胶囊 / 选项卡片 | 自写 `Chip`、`OptionCard`，选中统一为 `1px #C4501B + #FFF8F3`（见不一致清单） |
| 选择器 | 入口自写；弹出用 NutUI `Picker` / 微信地图选点 `Taro.chooseLocation` |
| 搜索框 | 自写（参考工程 `components/Search`） |

---

## 7. 标签栏（页内）、分段与筛选

| 变体 | 规格【源码】 | 选中 / 未选 | 出处 |
| --- | --- | --- | --- |
| 下划线标签栏 | 容器 `background: #FFFFFF; border-bottom: 1px solid #ECE6DD; padding: 0 8px`，可横滑 `gap: 4px`（Orders）或三等分（Publish）；项 `min-height: 44px; padding: 0 10px（Publish 0 8px）; font-size: 14px` | 选中 `border-bottom: 2px solid #C4501B; 600; #1D1A16`；未选 透明线 / 400 / #6F665B | Orders:32-34,67；Publish:184-186 |
| 分段控件 | 轨道 `height: 40px; padding: 3px; border-radius: 20px; background: #ECE6DD; gap: 2px`；项 `height: 34px; border-radius: 17px`，字 14px（Mall 为 13px，`padding: 0 12px`） | 选中 底 #FFFFFF / 600 / #1D1A16；未选 透明 / 400 / #6F665B | Contracts:122、Invoices:123、Mall:34-36 |
| 筛选胶囊（深色选中） | `height: 34px; padding: 0 14px; border-radius: 17px; border: 1px solid; font-size: 14px`，横排 `gap: 8px` 可横滑；Messages 为 `min-height: 32px; padding: 0 12px; 13px`，可带数字角标 | 选中 底 #1D1A16 / 字 #FFFFFF / 边 #1D1A16；未选 底 #FFFFFF / 字 #1D1A16 / 边 #E7E1D8 | Mall:41,125-127；Ads:134；MyDramas:66；Messages:94 |
| 筛选胶囊（橙色选中） | Ledger `min-height: 36px; border-radius: 18px; 14px`，四等分 `gap: 6px`；AssetLib `min-height: 32px; padding: 0 12px; border-radius: 16px; 13px` | 选中 底 #FFF8F3 / 边 #C4501B / 字 #A63F12 | Ledger:37,62；AssetLib:67 |
| 标题式切换 | 两个 `17px` 文字按钮 `gap: 18px; min-height: 44px`，— | 选中 #1D1A16 / 700；未选 #6F665B / 400（全原型唯一用 700 表示选中的切换） | Main"热门短剧 / 新剧上架"，Main:152-155 |
| 排序 | 文字按钮 `14px` + 下箭头 14，`min-height: 44px` | — | Mall:45 |

实现【建议】：下划线标签栏可用 NutUI `Tabs`（只用标题栏，覆盖激活线颜色与字号）或自写；分段控件、筛选胶囊自写 `Segment`（必选一个）与 `Chip`（可不选），与参考工程 `components/Segment`、`components/Chip` 的分工一致。规则建议：**筛选/切换视图一律深色选中，表单取值一律橙色选中**。

---

## 8. 提示条与操作反馈

| 组件 | 规格【源码】 | 出处 |
| --- | --- | --- |
| 提示条 | `margin: 0; padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 1.5`；每句一个 `display: block` 的 span（按句换行）；无图标、无关闭 | Cart:32、AdDetail:42 |
| 提示条配色 | 说明（蓝）底 #E8EEF9 / 字 #2E5AAC（19 板）；提醒（橙）底 #FBEDE5 / 字 #A63F12（6 板）；成功（绿）底 #E6F2EA / 字 #256A42（3 板）；错误（红）底 #FCEBEA / 字 #B42318（ProfileCert、WalletExpired） | 见左 |
| 紧凑提示 | `padding: 8px 10px; border-radius: 8px; font-size: 12px`（橙：Mine:40；浅底 #FAF8F4 + 字 #4A433B：Main 套餐到期行，可点，带会员胶囊与箭头 16） | Mine:40、Main |
| 操作反馈条（原型里的 toast） | `role="status"`；形状同提示条但 `font-weight: 600`；**位于 main 内第一个子元素、随文档流**，不是浮层；配色表 `ok: #E6F2EA/#256A42`、`info: #E8EEF9/#2E5AAC`、`warn: #FBEDE5/#A63F12`，默认 ok，**无 error 档** | AdDetail:34,85-87（23 板同一写法） |
| 行内错误 | 见 §6 错误态 | — |
| 说明小字 | `12px; line-height: 1.5; color: #6F665B`，卡片底部或卡外 | Checkout:44,64 |

实现【建议】：提示条自写 `Note`（`tone: info | warn | ok | danger`，对应参考工程 `components/Note`）。操作反馈有两种做法，需产品定：A. 照原型做成页内顶部条（自写，需自动滚到顶并定时消失）；B. 改用浮层轻提示（NutUI `Toast` 或 `Taro.showToast`，文案超过 7 个汉字时用 `icon: "none"`）。原型文案普遍较长（如"已提交修改意见，剩余免费修改 1 次"），倾向 A 或 NutUI `Toast` 的纯文本模式。

---

## 9. 弹层

| 项 | 规格【源码】 | 出处 |
| --- | --- | --- |
| 遮罩 | 整页按钮 `position: absolute; top/right/bottom/left: 0; background: rgba(15,14,12,0.5)`，点击关闭 | AdDetail:63 |
| 底部弹层 | `position: absolute; left: 0; right: 0; bottom: 0; max-height: 760px; overflow-y: auto; padding: 16px 16px 24px; border-radius: 16px 16px 0 0; background: #FFFFFF; display: flex; flex-direction: column; gap: 16px`（16 处 / 13 板：AdDetail、Ads、Contracts、Invoices、Members、Mine、Plan、PlanPick、ProfileService、StoreSwitch、Ticket、TicketDone、TopUp） | AdDetail:64 |
| 弹层标题区 | 左：标题 `17px / 600` + 说明 `13px; line-height: 1.5; #6F665B`（`gap: 4px`）；右：关闭 `44×44; margin: -10px -10px 0 0`，图标 22（`stroke-width 2`，#6F665B）；无拖动条 | AdDetail:65-67 |
| 弹层内容 | 表单字段（§6）、选项组、提示条、键值行；选项列表外框 `border: 1px solid #ECE6DD; border-radius: 12px`，行 `min-height: 64px; padding: 10px 12px`，选中行底 #FFF8F3 + 右侧对勾 20（#C4501B，`stroke-width 2.4`） | Mine:75；StoreSwitch:99 |
| 弹层底部 | 单个通栏主按钮 `height: 46px; width: 100%`，或两个等分按钮 `gap: 12px`（取消文案如"再想想"在左，主操作在右） | AdDetail:75、Ticket:68 |
| 全屏预览 | `position: absolute; 四边 0; background: #000000`，视频区 `390×693`，控制钮底 `rgba(255,255,255,0.16)` | AdDetail:60 |
| 居中确认框 | **原型中没有**（撤回工单等二次确认也用底部弹层） | 全量搜索 `role="dialog"` 仅上述两种 |

实现【建议】：自写 `Sheet` 包 NutUI `Popup`（`position="bottom"` `round`，参考工程 `components/Sheet/index.tsx:33` 同款），圆角变量设 16px（参考工程是 24px）；`max-height: 90vh`，底部加安全区；正文区内部滚动。全屏预览用独立页面或 `Popup` 全屏 + `Video`。如需补居中确认框，用 NutUI `Dialog`（参考工程已用）。

---

## 10. 步骤条与进度

| 组件 | 规格【源码】 | 出处 |
| --- | --- | --- |
| 分段步骤条 | `display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 6px`；每段：色条 `height: 4px; border-radius: 2px` + 文字 `12px`（`gap: 5~6px`）；色条 已到达（含当前）#C4501B / 未到 #D6CFC4；文字 已完成 #4A433B 400 / 当前 #A63F12 600 / 未到 #6F665B 400；Ticket 版多一行时间 `11px #6F665B tabular-nums` | ProfileStore:32-37；Ticket:40-41,97-100 |
| 序号步骤 | 圆 `22×22; border-radius: 11px; 12px / 700`：当前 底 #C4501B 白字；未到 底 #ECE6DD 字 #4A433B；文案 `14px; line-height: 1.6`；项间 `gap: 12px`。档案页的序号圆为 `26×26; border-radius: 13px; 13px / 700`：Profile 底 #256A42 白字，StaffProfile 底 #F1ECE4 字 #4A433B | PayResult:39-42；Profile、StaffProfile |
| 记录时间轴（圆点） | 行 `display: flex; gap: 12px`；轨 `width: 12px`；圆点 `10×10; border-radius: 5px; margin-top: 5px`；连线 `width: 2px; margin: 4px 0; background: #E7E1D8`；内容 `padding-bottom: 14px; gap: 2px`：标题 `14px / 600`，描述 `12px; line-height: 1.5; #6F665B`。圆点色：历史 #C9C0B3；最新一条按状态 待确认 #C4501B / 修改中 #2E5AAC / 已确认 #256A42 / 驳回 #B42318 | AdDetail:50,117；LaunchRecord:79；ProfileReview:92；AssetDetail |
| 进度时间轴（圆环） | 轨 `width: 20px`；节点 `20×20; border-radius: 10px; border: 2px solid`：完成 环与底 #256A42 + 白色对勾 12（`stroke-width 3.2`）；当前 环 #C4501B、底 #FFFFFF、内点 `8×8 #C4501B`；未到 环 #D6CFC4、底 #FFFFFF；连线 `width: 2px; min-height: 16px`，已走过 #256A42，否则 #E7E1D8；标题 `14px / 600`（未到 #6F665B），描述 `12px / 1.5 / #6F665B` | OrderDetail:37-42,150-154 |
| 线性进度条 | `height: 4px; border-radius: 2px`，轨 #ECE6DD（OrderDetail:55）或 #F1ECE4（Wallet:37），填充 #C4501B；Stores 为 `height: 6px; border-radius: 3px` | 见左 |

实现【建议】：四种都自写（`StepBar`、`NumberSteps`、`Timeline variant="log" | "progress"`、`ProgressBar`）。NutUI `Steps` 的圆点/连线样式与两种时间轴都不同，覆盖不如自写；线性进度条可用 NutUI `Progress`（关掉文字，改高度与颜色），自写也只有几行。

---

## 11. 上传

| 组件 | 规格【源码】 | 出处 |
| --- | --- | --- |
| 上传网格 | `display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 8px`；格子 `aspect-ratio: 1 / 1; border-radius: 10px` | ProfileStore:45、AssetUpload:40 |
| 添加格 | `border: 1px dashed #C9C0B3; background: #FAF8F4`，加号 20 + 文字 `12px #6F665B`，`gap: 4px`；达上限后不显示 | ProfileStore:55 |
| 已传格 | 图片铺满；底部文件名 `left: 8px; bottom: 6px; 12px #FFFFFF` 单行截断；视频左上角时长标签（§3）；右上删除钮：ProfileStore `28×28; border-radius: 14px; background: rgba(15,14,12,0.45)`，图标 14；AssetUpload `24×24; border-radius: 12px; background: rgba(15,14,12,0.55)` | ProfileStore:47-51；AssetUpload:40 |
| 单张上传块 | `88×88; border-radius: 12px`（Logo、服务图片）；`80×80; border-radius: 10px`（Service 截图）；已传态 底 #E6F2EA / 字 #256A42"已上传"（ProfileService:175） | ProfileBasic:43 |
| 通栏上传块 | `min-height: 72px; border-radius: 12px; border: 1px dashed #C9C0B3; background: #FAF8F4`，图标 22（#A63F12）+ 文字 `13px #4A433B` | TopUp:64、PlanPick |
| 文件行 | `padding: 10px 12px; border-radius: 12px; background: #FAF8F4; border: 1px solid #ECE6DD; gap: 12px`；图标块 `40×40; border-radius: 10px; #FBEDE5 / #A63F12`（图标 22）；名称 `14px / 600`，信息 `12px #6F665B`；移除钮 `32×32` | AssetUpload:42-43 |
| 录音 | 计时 `26px / 700 tabular-nums`；波形：`height: 36px` 内一排 `width: 3px; border-radius: 2px; background: #C4501B` 的竖条 | AssetUpload:39 |
| 上传中 / 失败 | 原型未画 | — |

实现【建议】：自写 `UploadGrid` + 上传 hook，遵循参考工程"先入列表再上传"（`hooks/useImageUploads.ts`），选取用 `Taro.chooseMedia`，录音用 `RecorderManager`；NutUI `Uploader` 的列表样式与"先入列表"的状态模型都不匹配，不建议用。需补每格的上传中（进度）与失败（重试）两态。

---

## 12. 播放器

| 变体 | 规格【源码】 | 出处 |
| --- | --- | --- |
| 内嵌预览（广告） | 外框 `background: #1D1A16; border-radius: 14px; padding: 16px 16px 14px; gap: 14px`；画面 `234×416; border-radius: 10px`（9:16）；控制行：播放钮 `36×36; border-radius: 18px; background: rgba(255,255,255,0.12)`；进度轨 `height: 4px; border-radius: 2px; background: rgba(255,255,255,0.25)`，已播 #FFFFFF，滑块 `12×12; border-radius: 6px`；标注区间 `height: 8px; top: -2px; background: rgba(242,180,143,0.9)`；时间与规格 `12px` 白字；全屏钮同播放钮 | AdDetail:36 |
| 头图播放（详情/样片） | Detail 头图 `height: 300px` 通栏，中央播放钮 `64×64; border-radius: 32px; border: 1px solid rgba(255,255,255,0.5); background: rgba(0,0,0,0.35)`；Sample `height: 380px; border-radius: 14px`，播放钮 56，进度轨 `height: 6px; border-radius: 3px`，广告位区段 #F2B48F，下方 `12px rgba(255,255,255,0.85)` 时间与图例 | Detail:33；Sample:30-46 |
| 沉浸式预告片 | 整屏画面；右侧操作列 `width: 56px`、圆钮 `44×44; border-radius: 22px; background: rgba(0,0,0,0.35)`（图标 22）+ `12px` 文字、项间 `gap: 14px`；底部蒙层 `height: 330px; background: rgba(15,14,12,0.62)`；剧名 `'Noto Serif SC' 24px / 900`，信息 `13px rgba(255,255,255,0.8)`，积分 `17px / 700 / #F2B48F`；进度 `height: 3px`；底部两个 48 高按钮；静音胶囊 `min-height: 36px; border-radius: 18px; background: rgba(0,0,0,0.4); 13px` | Trailer:31-52 |
| 音频 | 容器 `padding: 10px 12px; border-radius: 12px; background: #FAF8F4; gap: 12px`；播放钮 `44×44; border-radius: 22px; background: #C4501B`（图标 18 白）；右侧波形同 §11 | AssetDetail:39 |

实现【建议】：视频用 Taro 原生 `Video`（关闭原生控件，自绘控制条叠在同层渲染之上；标注区间、广告位区段是业务特有的，NutUI `Video` 不提供）；音频用 `InnerAudioContext` + 自绘。PRD 8.3 第 5 条：移动网络首次自动播放前提示流量——原型未画此提示。

---

## 13. 空状态

| 项 | 规格【源码】 | 出处 |
| --- | --- | --- |
| 结构 | 居中纵排 `display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px（或 8px）`；标题 `15px / 600`；说明 `13px #6F665B`；可选动作按钮 | Orders:45-48 |
| 上下留白 | `padding: 96px 24px`（Orders）/ `80px 24px`（Mall）/ `72px 24px`（MyDramas、Publish）/ `60px 16px`（Messages）/ `56px 16px 8px`（Search）/ `48px 24px`（Ads）；Invoices 仅一行字 `padding: 40px 16px; 14px #6F665B` | 见左 |
| 图标 | 仅 Messages（40）与 Search（44）有：线性图标 `stroke-width 1.4; color: #C9C0B3`；其余无图标 | Messages:36、Search:39 |
| 动作 | 主色描边按钮 `min-height: 44px; padding: 0 20px; border-radius: 22px; border: 1px solid #C4501B; color: #A63F12; 15px / 600` | Orders:48 |

实现【建议】：自写 `Empty`（icon / title / description / action），留白统一为一档（建议 72px 24px），图标统一有或无。NutUI `Empty` 自带插画，风格不符。

---

## 14. 数字、金额与图形元素

| 项 | 规格【源码】 | 出处 |
| --- | --- | --- |
| 余额大数字 | `32px / 700; line-height: 1.1; tabular-nums`（Wallet）；`30px`（Mine）；`28px`（Ledger、TopUp、PayResult）；`26px`（AdDetail 剩余次数、录音计时） | Wallet:36、Mine:39 |
| 统计数字 | `22px / 700` + 单位 `13px / 400 / #6F665B` | Main、Mine:43 |
| 价格（主色） | 宫格 `15px / 700 / #C4501B` + "积分" `12px / 600`；横滑推荐 `13px / 600`；Detail `22px / 700`；Checkout `20px / 700`；Cart 合计 `18px / 700`；深底上 `17px / 700 / #F2B48F` | Mall:63、Cart:39、Trailer:44 |
| 划线原价 | `13px; color: #6F665B; text-decoration: line-through`，后跟"实扣 2,160 积分" `15px / 700 / #C4501B` | Checkout:39 |
| 增减色 | 获得 #256A42；过期 #6F665B；其余 #1D1A16（Ledger:66）；明细里折扣行 #256A42"−240"、加扣行 #A63F12"+432"（Checkout:73-74）；不足时 #B42318（Cart:80、AdDetail:125） | 见左 |
| 书写规则（PRD 8.3） | 金额以"¥"开头、千分位、非整数保留 2 位；积分整数千分位，写作"2,160 积分"；扣减用"−"，获得用"＋" | PRD 8.3 第 3 条 |
| 封面占位 | 纯色块 + 内框 `1px solid rgba(255,255,255,0.28)` + 竖排衬线剧名；尺寸：宫格 `aspect-ratio: 3/4; border-radius: 8px`；横滑 `124×165; radius 10`；列表缩略 `60×80; radius 6`（Cart）、`56×76; radius 5`（6 处）、`52×70`、`48×64`、`44×60`、`42×56` | Mall:55-57、Cart:33、OrderDetail:50 |
| 字形头像 | 衬线单字（`'Noto Serif SC'; 900`）；门店方形：`56×56; radius 16; #C4501B 白字 26px`（Mine）、`48×48; radius 14`、`44×44; radius 12`、`40×40; radius 12`（底 #FBEDE5 / 字 #A63F12）；人物圆形：`40×40`、`36×36`、`32×32`（对话，`13px / 700` 非衬线）、`26×26` 叠放带 `box-shadow: 0 0 0 2px #FFFFFF` | Mine:35,45；Members:40；Ticket:48,83-84 |
| 图标块 | `44×44; radius 14`（图标 24，首页快捷入口，文字 13px，`gap: 6px`）；`40×40; radius 12`（图标 22）；`36×36; radius 10`（图标 20）；`32×32; radius 8; #F1ECE4 / #4A433B`（图标 18）；主色系 底 #FBEDE5 / 色 #A63F12 | Main 快捷入口、Mine:42、Wallet:37,42 |
| 图标 | 24 网格线性 SVG，`stroke-width="1.8"`（266 处）为主，导航/箭头/关闭用 `2`（129 处），对勾 `2.4`；尺寸档：24（导航、标签栏）/ 22（行首、关闭）/ 20 / 18 / 16（行尾箭头）/ 14（链接箭头） | 全量统计 |
| 对话气泡 | 我：底 #FFF3EB、边 #F3D9C8、圆角 `12px 2px 12px 12px`、靠右；客服：底 #FFFFFF、边 #ECE6DD、圆角 `2px 12px 12px 12px`；`padding: 10px 12px; 14px; line-height: 1.6`；头像 32；系统消息居中：时间 `11px #6F665B` + 文案 `12px #4A433B; padding: 3px 10px; border-radius: 10px; background: #EFE9E0` | Ticket:48,83-84 |
| 结果页头 | 圆 `64×64; border-radius: 32px; background: #256A42` + 白色对勾 34；标题 `22px / 700`；数字 `28px / 700` + 单位 `16px / 600` | PayResult:30-33 |

实现【建议】：金额/积分统一走格式化函数（`formatPoints`、`formatMoney`），数字元素统一加 `font-variant-numeric: tabular-nums`（原型只有部分加了）；大数字收敛为 28 / 22 / 18 三档。封面换真实图片后做成 `Poster`（`size: grid | rail | thumb`，缩略统一一种尺寸）。图标沿用参考工程 `Icon` 组件方式（CSS mask + `currentColor`），不逐个内联 SVG。衬线字需在小程序里加载字体子集（参考工程 `utils/font.ts` 的 `loadFontFace` 做法），未加载完时按黑体回落。

---

## 15. NutUI 使用清单【建议】

| 用 NutUI（3.0.20，已在 `node_modules` 确认存在） | 自己写 |
| --- | --- |
| `Button`、`Popup`（包进 Sheet）、`Dialog`（补居中确认）、`TextArea`、`Switch`、`Loading`、`Picker`、`ImagePreview`、`Toast`（若采用浮层方案）、`SafeArea`；可选 `Tabs`、`Progress`、`Badge` | 页头 PageHeader、Card / Section、List / ListRow / DescList、StatusTag、Chip、Segment、OptionCard、Field / 输入框 / 搜索框 / Checkbox、Note / 反馈条、Sheet 外壳、StepBar / NumberSteps / Timeline、UploadGrid、播放器控制条、Empty、Poster、字形头像、Icon |

接入方式沿用参考工程：组件 JS 直接 `import`，样式在 `src/styles/nutui.ts` 逐个引入 `…/packages/<name>/style/css`，主题只能用 `app.scss` 的 `page { --nutui-* }` 覆盖，不用 `babel-plugin-import`。

---

## 16. 原型内不一致（建议统一）

| # | 现象 | 出处 | 建议 |
| --- | --- | --- | --- |
| 1 | 主按钮高度 46 / 44 / 42 / 40 / 34 / 48 / 50 并存 | §2.1 | 收敛为 46 / 40 / 32 + 特大 48 |
| 2 | 禁用主按钮文字色 #FFFFFF 与 #4A433B 两种；另有 `opacity: 0.4` 写法 | AdDetail:56；Cart:42、Checkout:83；ProfileReview:110 | 统一 底 #D6CFC4 + 字 #4A433B（对比度更高） |
| 3 | "老板"标签：蓝 #E8EEF9/#2E5AAC vs 橙 #FBEDE5/#A63F12 | Mine:35、StoreSwitch；Members:73 | 角色不是状态，统一用中性或一种固定色 |
| 4 | "已失效"：红 vs 灰 | Cart:35；Contracts:79 | 按 PRD 8.3"失效或错误用红色" vs "已结束用灰色"定义清楚 |
| 5 | "待处理"用红色标签，而 PRD 写"待处理用橙色" | Main 待办第 3 行 | 改橙色，或把文案改为"未通过" |
| 6 | 筛选/选项选中态两套（深色、橙色）且混用：Ledger、AssetLib 的筛选用橙色；Service 问题类型、ProfileService 风格标签的表单取值用深色 | Ledger:62、AssetLib:67；Service:134、ProfileService:156 | 筛选深色、取值橙色 |
| 7 | 选项卡片选中：`2px` 边 + #FBEDE5 / `2px` 边 + #FFF8F3 / `1px` 边 + #FFF8F3 | Accounts:99、Ads:119；AdDetail:140；TopUp:96 | 统一 `1px #C4501B + #FFF8F3` |
| 8 | 行内错误文案 12px 与 13px | Profile* 5 板；AdDetail:73、Ticket:67 等 | 统一 12px |
| 9 | 复选框 16 / 18 / 20 三种尺寸 | Checkout、Join；多数；Cart | 统一 18（协议勾选可 16） |
| 10 | 上传删除钮 28（0.45 透明度）与 24（0.55） | ProfileStore:51；AssetUpload:40 | 统一 28 |
| 11 | 数字角标底色 #C4501B 与 #B42318 | Cart:47、Mine:57；Messages:33 | 统一一种（原生 tabBar 角标为系统红） |
| 12 | 卡片标题 16px / 15px / 17px | 多数；MyDramas、Publish、Search；Main | 卡内 16，卡外分组 17 |
| 13 | main 上下留白：顶 0/2/4/12，底 16/20/24；Main、MyDramas、Search 的卡间距 16/14 | §1.1 | 顶 4（有副栏时 0）、底 20、间距 12 |
| 14 | 底部操作栏高 72 / 76 / 80 / 64 | 多数；Detail:44；Join；Cart:37 | 内容高统一 64 + 安全区 |
| 15 | 导航栏底色：Orders 白，其余透明；同为"副栏白底"的 Publish 却是透明 | Orders:23；Publish | 有白底副栏的页面导航栏同为白 |
| 16 | 行尾箭头 16 / 18，箭头色有写死 #6F665B 与 `currentColor` 两种 | Mine:50；Main 待办；统计见 §14 | 行尾 16、链接 14，统一 `currentColor` |
| 17 | 空状态留白 6 种、图标有无不一 | §13 | 统一一档 |
| 18 | 余额大数字 32 / 30 / 28 / 26；`tabular-nums` 只有部分加 | §14 | 28 / 22 / 18 三档，数字全部等宽 |
| 19 | 线性进度条轨道色 #ECE6DD / #F1ECE4，高 4 / 6 | OrderDetail:55；Wallet:37；Stores | 统一 4 高、#ECE6DD |
| 20 | 列表缩略封面 6 种尺寸 | §14 | 统一 56×76 |
| 21 | 待办标签圆角 6 / 内边距 3px 6px，与通用标签（4 / 1px 6px）不同 | Main 待办 | 并入通用标签 |
| 22 | 键值网格键宽 64 / 72，字号 13 / 14 | AdDetail:45；OrderDetail:70 | 统一 64 + 13px（长键另设 96） |

---

## 17. 待拍板问题

1. 导航栏：PRD 要求原生导航，但 Main 的衬线字标、Trailer 的沉浸式页头只能自绘——这三页（含 Login）是否确认自绘，其余全部原生？原生标题在安卓上靠左，是否接受？
2. 底部标签栏用原生后，选中加粗、角标颜色（系统红而非 #C4501B）、顶边线颜色都无法照原型，是否接受？
3. 操作反馈：照原型做页内顶部条，还是改成浮层轻提示？失败类反馈（原型没有 error 档）用什么样式？
4. 加载中、加载失败、骨架屏、下拉刷新、触底加载、上传中/失败、按钮加载中、按下态——原型均未画，需设计补稿还是由开发按参考工程惯例实现？
5. 二次确认是否全部用底部弹层（原型现状），还是危险操作改用居中对话框？
6. 边线粗细：照原型 1px，还是沿用参考工程的 0.5px 发丝线？
7. 衬线字体（Noto Serif SC，73 处）在小程序里如何供给：加载子集字体、换系统宋体，还是只在封面图片里出现？
8. 复选框/单选框原型用的是浏览器原生控件（`accent-color`），选中后的具体造型（勾的粗细、圆角）需设计给定。
9. 16 节各项不一致按本报告的建议收敛，还是另有取舍（尤其第 3、4、5、6 项涉及语义）？
10. 设备适配：是否需要为大字体模式、横屏、iPad 做约定；底部安全区按 `env(safe-area-inset-bottom)` 叠加在原型的 8px 之上还是取代它？
