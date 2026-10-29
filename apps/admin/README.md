# apps/admin：运营管理后台

React 19 + Vite 8 + Ant Design 6 的纯单页应用，与接口同源（[D7](../../docs/appendix/design/d7-platform.md) 第 5 节）。本目录现在是骨架（W0-28）：外壳、菜单登记表、路由守卫、请求客户端、三种页面骨架、确认与上传两个构件。之后的页面包只填“查询、列定义、详情内容、动作”。界面依据是[设计规范](../../design/design-spec.md)（下称“规范”）第 5 节。

## 命令

在仓库根目录跑。

| 命令 | 做什么 |
| --- | --- |
| `pnpm --filter @liyoxi/admin dev` | 本地开发，端口 5183。带样例页与夹具；样例接口由开发服务器自己应答，不用起 api。设了 `LYX_API_ORIGIN` 时把 `/api` 转给它 |
| `pnpm --filter @liyoxi/admin test` | 单测（Vitest，Node 环境）。配置就在 `vite.config.ts` 里，与构建共用一份 |
| `pnpm admin:build` | 生产构建到 `apps/admin/dist/app`，随后跑 `scripts/check-build.mjs`：文件名带内容哈希、写入了构建号、不含夹具 |
| `pnpm admin:e2e` | 冒烟：带样例页构建（`dist/e2e-app`），验证外壳、陈列页与鉴权样例，随后运行独立封面上传场景。截图在 `dist/e2e-shots`，失败现场在 `dist/e2e-results` |
| `pnpm --filter @liyoxi/admin e2e:cover` | 只验封面替换与重试、非法文件、上架校验阻断三场景；独立 Vite 夹具端口 5184，截图和失败 trace 在 `dist/e2e-results/cover-upload`，使用替身上传与保存接口 |
| `pnpm admin:e2e:live` | 真实 API + 生产后台：独立测试库与假密钥，激活、绑定、恢复码登录与登录态复用，员工筛选分页、新增及一次性激活码；截图在 `dist/e2e-shots`，失败 trace 在 `dist/e2e-live-results` |
| `node infra/ci/pages/generate.mjs`（加 `--check` 只比对） | 由菜单登记表重新生成 `docs/plan/pages.md` 的后台部分 |

冒烟缺省用 Playwright 自带的 Chromium：第一次跑先 `pnpm --filter @liyoxi/admin exec playwright install chromium`。本机不想下载时用已装的 Chrome：`LYX_E2E_CHANNEL=chrome pnpm admin:e2e`。

三种构建模式（`vite.config.ts` 开头）：`production` 不含样例页与夹具；`e2e` 与开发、测试都带。构建号取环境变量 `LYX_BUILD`，没有时取 git 提交的短哈希；它写进 `index.html` 的 `<meta name="lyx-build">`、代码里的 `__LYX_BUILD__` 与产物根目录的 `build.json`，随请求头 `X-Client-Version` 带出。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/lib/menu.ts`、`src/lib/menu/` | 菜单登记表：菜单、面包屑、路由守卫、角标的唯一来源。一个模块一个登记文件，`_base.ts` 是不属于任何模块的页面 |
| `src/lib/permissions.ts`、`guard.ts` | 模块等级、权限点、开关的判断；路由守卫 `requireModule` |
| `src/lib/api.ts`、`api-errors.ts`、`idempotency.ts` | 请求客户端：统一请求头、幂等键、按错误符号名的统一处置 |
| `src/lib/query.ts` | 查询缓存策略（列表、队列、详情、字典各一组选项） |
| `src/lib/table-search.ts`、`queue.ts`、`upload.ts` | 三种骨架与上传构件背后的纯函数：地址参数的读写、选中逻辑、上传校验与状态机 |
| `src/components/` | 外壳 `AppShell`；骨架 `QueryTablePage`、`QueueWorkbench`、`DetailPage`；构件 `ConfirmAction`、`UploadField`；它们用到的小构件（`PageHeader`、`Tabs`、`SimplePager`、`StatusTag`、`CheckList`、`InfoList`、`Icon`、三态块） |
| `src/theme/` | `antd.ts` 组件级主题覆盖，另有 ConfigProvider 上主题之外的组件级配置 `adminComponentConfig`（弹窗居中、抽屉的缺省宽度、表单不显示必填星号等）；`css-vars.ts` 把设计变量铺成 CSS 自定义属性；`global.css` 全部样式 |
| `src/app/` | 应用外层：主题与中文文案、查询缓存、请求客户端的单例、全局反馈 |
| `src/routes/` | 路由。`modules/` 下每个模块一个路由清单；`_dev/` 是样例路由；`registered.tsx` 接住登记了但还没实现的页面 |
| `src/dev/` | 样例页与夹具，只进开发与测试构建。样例页五个：`/dev/table`（筛选表格）、`/dev/queue`（审核工作台）、`/dev/detail/st-01`（详情页）、`/dev/rows`（整行可点的表格，带抽屉与分段控件）、`/dev/form`（一张比一屏长的表单，用的是 antd 的卡片与表单） |
| `src/dev/showcase/` | 陈列页（看样页，W0-29）`/dev/showcase`：构件、设计变量、状态取色、图标照规范的章节逐组摆出来。同样只进开发与测试构建，见下面“陈列页” |
| `test/e2e/` | Playwright 冒烟：`smoke.spec.ts` 走外壳与三种骨架，`showcase.spec.ts` 打开陈列页逐组截图 |
| `scripts/` | `check-build.mjs` 构建产物检查（下载页共用）；`e2e-affected.mjs` 冒烟的受影响范围判断 |

## 颜色与样式

页面不写色值（`pnpm lint:colors` 会拦）。三个出处：

| 场合 | 从哪取 |
| --- | --- |
| Ant Design 组件 | 主题：全局取 `@liyoxi/shared/design/antd-theme`，组件级覆盖在 `src/theme/antd.ts` |
| 自己写的样式 | `src/theme/global.css` 里用 `var(--lyx-<组>-<名>)`，变量名与 `design/tokens.json` 的第二、三层键相同；启动时由 `css-vars.ts` 从 `@liyoxi/shared/design/tokens` 铺出 |
| 状态标签 | `StatusTag` 的 `tone` 取状态色调字典（`@liyoxi/shared/design/status-tone`） |

没有用 `@liyoxi/shared/design/admin.scss`：那要装 `sass`，不在本包允许新增的依赖里。要用带透明度或调亮调暗的颜色，先让它进 `design/tokens.json`。

## 页面里直接用的几样

规范写明了数值、页面不用再自己调的（都在 `src/theme/` 里做好了，冒烟里有断言）：

| 要什么 | 怎么写 |
| --- | --- |
| 表格行高：单行 44、双行 56 | 双行单元格用 `.lyx-cell-2`（主行 `.lyx-cell-2__main`、副行 `.lyx-cell-2__sub`）。一行里有双行单元格就是 56，否则 44，不用另外声明。行里放高 32 的行内按钮（`size="small"`）不会把行撑高 |
| 按钮三档 | 页头与筛选条用缺省大小（高 36）；弹窗底部与详情操作用 `size="large"`（高 40）；表格行内用 `size="small"`（高 32）。圆角前两档 8、行内 6 |
| 危险描边按钮（驳回、禁用账号一类） | `<Button danger>`；工作台的驳回由骨架按 `kind: "reject"` 出 |
| 文字按钮（“重置筛选”一类）、表格里的文字链 | `<Button type="link">`；`<a className="lyx-link">`（危险操作加 `lyx-link--danger`）。悬停只加下划线，不变色 |
| 操作成功的提示 | `showSuccessNotice("……已……")`（`src/app/feedback.ts`）：右上角，带对勾，4 秒后消失，读屏按状态播报。构件不直接引它：工作台骨架要页面传 `notifySuccess={showSuccessNotice}` |
| 操作失败的提示 | 不用自己弹：请求层按错误符号名统一弹（红色感叹号，不自动消失，同一句话只留一条）。表单校验、确认不一致这两类不弹，由表单与确认构件就地显示 |
| 弹窗 | antd 的 `Modal`：两个方向居中、内边距 24、关闭按钮 32 × 32 都已套好（居中是全局给的，不用每个弹窗写 `centered`）。内容比窗口还高时由遮罩那一层滚动，上下各留 24。标题下面的说明放在内容最前面，用 `.lyx-confirm__desc` 的写法（紧跟标题、右侧让出关闭按钮） |
| 弹窗的页脚 | 一律自己摆，不用 antd 的缺省页脚，也不用 `modal.confirm` 这类静态确认框：缺省页脚的按钮高 36、两键间距 8、离内容 12，不是规范的 40、10、16，主题这一层没有套（状态文件“偏差”，等业主定）。写法照 `ConfirmAction`：`footer={null}`，内容最后放 `.lyx-confirm__footer`（右对齐、间距 10，取消在左、确认在右），按钮用 `size="large"`。要二次确认的直接用 `ConfirmAction` |
| 抽屉 | antd 的 `Drawer`：右侧、宽 480、内边距 24、阴影都已套好；头部照原型是标题在左、关闭按钮（32 × 32）在右，没有分隔线。宽度是全局给的缺省值，页面自己传了 `size` 的按页面的 |
| 表单 | antd 的 `Form`，纵向布局：标签 13px / 600、标签文字到控件 6、字段间距 14、不显示必填星号（选填项在标签后写“（选填）”）、错误提示与字段下方的辅助说明 12px、提交有错时滚到第一个出错的字段（不在视野里才滚，落在内容区中间，标签与错误提示一起看得见），都已套好。样例页 `/dev/form`，冒烟里有断言。输入框、下拉、数值输入、日期与日期范围选择器高 36、13px、左右内边距 10（小号的下拉沿用 antd 的紧凑内边距，规范没写这一档）；多行输入内边距 8px 10px、行高 1.6。校验错误的警示播报（`role="alert"`）antd 的表单没有给，见状态文件“偏差” |
| 日期范围选择器的键盘 | W2-02 在有头 Chrome 复现原 AntD6.6.5 的空值 Tab 焦点锁。`DateRangeField` 保留原 RangePicker props/日期校验，在空字段 Tab 时收口原焦点锁并保留浏览器顺序遍历；非空值走原确认逻辑。样例 `/dev/config`，浏览器覆盖 Tab/Shift+Tab 进出、Esc关闭、手输范围与不误提交；未升级 AntD 或改全局键盘事件 |
| 开关、分段控件、复选框、单选框 | 直接用 antd 的：开关 36 × 20（开是绿色）、分段控件项高 30（选中项只是白底，不带阴影）、复选框与单选框 16 × 16，都已套好。禁用的输入框、数值输入、下拉、日期选择器的描边与禁用按钮的描边同色（规范没写禁用的输入框，状态文件“偏差”）。核对清单里的绿色复选框用 `CheckList` |
| 键盘聚焦 | 输入框、下拉是“描边变主色加浅色光晕”，其余可点的东西是主色聚焦环，都不用页面管：antd 的按钮、关闭键、清除键、复选框、单选框、开关、分段控件与侧栏菜单已经换成主色环；自己写的可点元素挂 `.lyx-focusable`，文字链 `.lyx-link` 自带。分段控件用 Tab 走有两站（先是容器自己，再按一下进到里面的项，之后用方向键换项），两站的环都画在整条轨道上。用键盘打开弹窗时焦点直接落在它的关闭键上（主色环）；用键盘打开抽屉时焦点先落在整个抽屉这一层上，那是容器不是控件，不画环，再按一下 Tab 到关闭键。antd 别的控件（`Tabs`、`Pagination`、`Dropdown`、`Tree`、`Collapse`、`Steps` 等）本包没有用到、没有套，用到的包走构件 PR 照 `global.css` 开头那一段补 |
| 整行可点的表格 | `QueryTablePage` 的 `onRowClick`：鼠标点行里的空白或文字，或 Tab 到这一行后按回车。行里另有链接、按钮、输入类控件（含 antd 的下拉、日期选择器、分段控件）时各管各的：点它们、或焦点在它们上面按回车，只做它们自己的事，不触发整行的动作；从行里弹出去的浮层、弹窗里的点击也不算这一行的。行里自己写的可点元素照规范 第 10 节用 `button` 或 `a`，不要给 `span`、`div` 绑点击，否则会被算成点了这一行。样例页 `/dev/rows`，冒烟里有断言。现在有两样规范没写、没有处理的：在行里的文字上按住拖选再松开，会触发一次整行的动作（想复制单号时抽屉会弹出来）；双击会触发两次。等业主看样时定（状态文件“偏差”） |
| 页签、分页、面包屑 | 用本目录的 `Tabs`、`SimplePager`（三种骨架里已经带了）与外壳自带的面包屑，不用 antd 的 `Tabs`、`Pagination`、`Breadcrumb`；主题里也没有给这三个组件留配置，直接用会是 antd 的缺省样子 |
| 面板里的标题 | `.lyx-section-title`，按标题的级别取字号：`h2` 是卡片这一级的标题（页签面板里的“基础信息”一类），15px / 600；`h3` 是卡片内的分区标题（“核对清单”一类），14px / 600。侧栏信息卡的标题由详情页骨架出（14px / 600） |
| 行高 | 不用管：正文是 1.6，标题与双行单元格是 1.3（规范 第 2.3 节）。正文的 1.6 盖在 antd 的 `App` 这一层，页面里直接写的段落、说明、信息列表都继承得到；弹窗与卡片的内容区、抽屉、表格的单元格、写在表单里的说明、字段下方的错误提示与辅助说明同样是 1.6。骨架出的各级标题（页头、详情卡、分区标题两级、侧栏信息卡、空状态、整页说明）与 antd 的弹窗、抽屉、卡片的标题都是 1.3。自己另写标题类时加 `line-height: var(--lyx-line-height-title)`，别的地方不要另写行高。按钮、输入框、下拉、清单之外的复选框文字这些单行、定高的控件仍是 antd 的行高（规范给的是它们的高度），不用管 |
| 数字 | 不用管：等宽数字（`tabular-nums`）加在 `body` 上，文字都继承得到，弹窗、抽屉、通知、下拉浮层里也是。输入框、多行输入、按钮、下拉这些表单控件，浏览器给它们的缺省字体会把这个属性（连同字体）重置掉、继承不进去，`global.css` 里另写了一条让它们显式继承，所以输入框里填的数字、按钮上的数字、日期浮层头部的年月同样等宽、同样是界面字体。`.lyx-num` 不用再挂（留着只为个别被别的样式重置掉的地方） |
| 卡片 | 自己的区块用 `.lyx-card`（圆角 12、1px 描边、无阴影、无内边距，内边距由里面的块给）；antd 的 `Card` 也套了（内边距 16、标题 15px） |
| 空状态的文案 | 没有数据写“暂无……”（骨架的 `empty.title`）；筛选无结果由骨架自己出“没有符合条件的……” |
| 页面装不下时怎么滚 | 滚的是整个内容区（规范 第 5.1 节），页面不用管：内容区的直接子项按自己的内容高度排、不被压缩（外壳的样式定的），表格行多了页签、筛选条、表格、分页条一起滚。页面里不要再套整页的纵向滚动容器；确实要“占满剩余高度、内部自己滚”的区块（如对话区），在自己的类上写 `flex` 与 `min-height`。冒烟里有只用鼠标滚轮滚到底的断言 |
| 提示条（`Alert`） | 不用自己设：按类型取色调的文字色（成功、进行中、待处理、错误），底是同一色调的浅底；圆角 8、无描边、默认无图标。只用单行的（给 `title`）：带 `description` 的那一种是 antd 的另一套规格（内边距 20px 24px、标题 16px），规范没有这一种，本包没有套，不要用。规范里的“中性款”antd 没有对应的类型，本包没有做 |

## 陈列页（看样）

`/dev/showcase` 把外壳、骨架里的构件、主题套好的 Ant Design 控件，连同色板、字号、间距圆角阴影、状态取色表、全部图标，照规范的章节先后逐组摆出来；每组右上角是规范的节号，下面几行是看样时要对的要点。业主对着规范逐组看，结论填进[看样清单](../../docs/plan/sample-review/W0-29.md)。

| 怎么看 | 做法 |
| --- | --- |
| 本机打开 | `pnpm --filter @liyoxi/admin dev`，浏览器开 `http://localhost:5183/dev/showcase`。不用起 api；页面顶部的目录跳到各组，“五类页面”一组里有五个样例页的链接 |
| 只翻截图 | `pnpm admin:e2e` 之后看 `apps/admin/dist/e2e-shots/showcase-*.png`：`00` 是页面顶部，之后每组一张，`9x` 是弹窗、二次确认、抽屉、轻提示。CI 里是产物 `admin-e2e-shots` |
| 换角色、看 V1.1 的菜单 | 见下面“权限与守卫”里切换夹具的两行 |

分组登记在 `src/dev/showcase/sections.ts`（节号、标题、要点），内容在同目录的几个文件里；加一组要两处都加，少了类型检查过不去。陈列页只摆不改：构件有出入的记进看样清单，走单独的构件 PR。生产构建不带它（访问即“页面不存在”），预发上要看时部署 `e2e` 模式的产物，由环境包定。

## 权限与守卫

权限只影响显示什么，接口每次请求即时鉴权（D7 第 5.4 节）。数据经可替换来源读取（`AppServices.setAccessSource`），默认调用真实 `GET /api/v1/admin/auth/me`；开发与样例构建仍用 `src/dev/fixture-access.ts`。模块等级与权限键引契约，`Can`、`useCan`、`useModuleLevel` 在现有纯函数上只增封装。权限拒绝或开关失效会重取 loader 缓存并使路由重新检查；登录完成清缓存、放开登录跳转闩。生产构建打开登录页，四种 `AuthNext.next` 决定去向；票据只留内存，绑定确认使用接口续期票据，恢复码保存确认后进入后台。

看样时可在浏览器控制台切换夹具：`localStorage["lyx.dev.role"] = "service"` 换成客服的权限；`localStorage["lyx.dev.releases"] = "release.partner"` 打开 V1.1 的菜单。

## 加一个页面

1. 在 `src/lib/menu/<模块>.ts` 找到这一页的登记，把 `implemented` 改成 `true`（无画板页另把 `inMenu`、`path` 定下来），跑 `node infra/ci/pages/generate.mjs` 并提交 `docs/plan/pages.md`。
2. 路由文件放 `src/routes/<模块>/`，一个画板一个文件。守卫与地址参数写在路由上：

   ```tsx
   export const merchantListRoute = createRoute({
     getParentRoute: () => rootRoute,
     path: "/merchants",
     validateSearch: (raw: Record<string, unknown>) => raw,
     beforeLoad: ({ context }) => requireModule(context.access, "merchant", "v"),
     component: MerchantListPage,
   });
   ```

3. 在 `src/routes/modules/<模块>.ts` 的清单里加上这条路由。只动自己模块的清单。
4. 页面私有的组件与查询封装放 `src/features/<模块>/`（D7 第 5.1 节）。取数用 `services.api.client`，查询选项取 `src/lib/query.ts` 里对应的一组。
5. 页面用哪种骨架见 D7 第 5.2 节的“骨架”列。三种骨架都是受控的：状态从地址来、改动写回地址，写法照 `src/dev/` 下三种骨架各自的样例页。主从页、配置页、图表在 G2-0 的构件包。

通用构件与页面骨架在业主看样、提过意见并改完后冻结；页面包要改构件，走单独的构件 PR（计划 第 9.3 节）。

## React 的类型

仓库里装着两份 `@types/react`（小程序用 18，这里与下载页用 19）。antd 与 `@tanstack/*` 的类型里写 `import "react"`，自己却不声明 `@types/react`，不管的话 tsc 会到 pnpm 的提升目录里去找，那里放的是哪一份不保证，类型检查就时过时不过。预设 `packages/config/tsconfig/web-react19.json` 用 `compilerOptions.paths` 把 `react`、`react-dom` 的类型钉到了本应用自己装的那一份。

要在本目录的 `tsconfig.json` 里写 `paths`（比如加别名）时，把预设里那四行一并抄上：tsconfig 的 `paths` 不合并，自己一写就把预设里的整体顶掉了。忘了的话 `pnpm check:type-hoist` 会红。来历与口径见 [infra/ci/README.md](../../infra/ci/README.md) 第 7 节。

## 已知的限度

- 路由树是手写装配的（`src/routes/tree.ts`），没有用 `@tanstack/router-plugin` 的文件路由生成：装上它会把锁文件里已有依赖的解析版本带着变，属“放松”类门禁改动，要走单独的依赖 PR。目录约定已照文件路由来，换过去时只动装配（[状态文件](../../docs/plan/status/W0-28.md)“偏差”）。
- 单测不装 DOM 测试库：结构用 `react-dom/server` 渲染后断言，交互留给 Playwright（任务书 第 11 节第 2 项）。
- W1-02① 已接登录、激活、动态口令、绑定、再验证、用户菜单、403/404。并发请求共用一个再验证弹层，成功后沿用原幂等键重放；M1 用户菜单仅退出登录。员工页已接真实员工/角色查询与新增，manual 激活码只留当前弹层内存，关闭即清；行内操作、页头汇总和本人安全菜单由 W2-06 增量实现，当前验证进度见本包状态。
- 全局搜索与通知入口不显示（规范 第 14 节第 12 项）；V1.1 的 13 个菜单只登记、默认不显示。
- 表格行高的两档靠 CSS 的 `:has()` 选择器判断一行里有没有双行单元格（Chrome 105、Safari 15.4、Firefox 121 起支持）；更老的浏览器里双行的行会落到 44 那一档，不到 56。复选框、单选框、分段控件的键盘聚焦环同样靠 `:has()`。
- 衬线字体（页面标题、品牌字）没有带字体文件，按字体栈回落到系统的宋体；antd 控件内部自带的图标（下拉箭头、清除键、排序箭头、关闭“×”等）还是它自己的。两件都在状态文件“偏差”里，等业主定。
- 还有几样只量了、没有改，同样在状态文件“偏差”里等业主定：antd 弹窗的缺省页脚（见上面“弹窗的页脚”）；antd 按钮点击后的水波动画没有关（规范没写点击的动效）；日期浮层里不属于本月的日期用的是禁用色（antd 的缺省）；上传区里的图标是 16px、线宽 1.8（规范说 16px 及以下用 2；图标集里这个图标就是 1.8，图标集不在本包改）。
- `QueryTablePage` 的 `mask` 只提示服务端已脱敏值，不能证明 DTO 安全或请求明文；`selectedRowKey` 加选中行和左侧色条。业务页只消费这些公开构件。

## W2-02 公共构件与查询

| 公口 | 受控边界与样例 |
| --- | --- |
| `MasterDetailPage` | `selectedKey/onSelect/list/detail/onRetry`；详情带取数 key，旧 key 响应显示加载而非串记录；默认右栏360px。`/dev/master-detail` 验选中 URL、后退/刷新和陈旧响应 |
| `ConfigPage` | `children/aside/readOnly/pending/canSubmit/onSubmit/error`；字段禁用与同步提交锁，领域给校验/版本/权限/幂等。保存按钮（或焦点在按钮时按Enter）才提交，日期 Enter 不隐式保存。`/dev/config` |
| `Chart` | 调用方给 `option/label/state/height/onRetry`，按需柱/折线/饼图，ResizeObserver/零尺寸延迟与dispose；图例/指标由调用方给出。`/dev/chart` |
| 单选控件 | `CapsuleRadio/ReasonChips/RadioCard` 的 `value/options/onChange/ariaLabel/disabled`；原生 radio 支持方向键/Tab，disabled 不回写。`/dev/shared-controls` |
| 月份与展示 | `MonthSwitcher` 的年月对象与范围；`ReadOnlyValue/NeutralNotice/EmphasisBlock/Stepper/LogList/DiffBlock` 只展示调用方事实，不推导领域进度/日志/差异。同上样例 |
| 既有比对/驳回 | `CompareTable` 的 `rows/ariaLabel` 与 `RejectDialog` 受控签名不变；提交等待期间不能Esc/关闭/取消/重复提交，不重做现有业务包装 |
| 查询适配 | `readContractQuery(schema, raw, options)` 返回分离的 `wire/parsed`；显式白名单、默认和恢复；审批 CSV 数组不重新传给输入 schema。已有表格10/20/50和队列100分页保持。员工/资质页消费公开 `/queries/admin`，id只属队列UI |

四个样例继续由 `__LYX_DEV_FIXTURES__` 控制，生产访问404且产物无夹具，不新增真实页/菜单/接口。`pnpm admin:e2e` 沿用 samples项目；定点命令 `LYX_E2E_CHANNEL=chrome pnpm --filter @liyoxi/admin exec playwright test test/e2e/w202-components.spec.ts --project=samples`；加`--headed`验有头日期键盘。

截图写入 `dist/e2e-shots/w202-{master-detail,config,chart,shared-controls}.png`。叶控件SSR/纯测试只证明结构与年月规则，实际方向键、只读、等待、尺寸与焦点由浏览器验收。

## 真实接口浏览器验收（运行入口）

显式提供本地 Compose 的公开测试连接参数（APP_ENV=test、DATABASE_URL、REDIS_URL），执行 `pnpm admin:e2e:live`；不读取 .env。正常 Node24，nightly 沿用仓库 Node26 兼容作业。CI 先安装 Chromium；本机可 `LYX_E2E_CHANNEL=chrome`。脚本为本轮生成严格配对的测试库与 Redis 前缀，seed 与 staff:bootstrap 后启动真实 API 构建产物和生产后台静态文件；/api 转发保留 Host/Origin 及端口。结束或中断后停止本轮子进程、精确清理数据库/Redis 与私有临时文件；失败时保留截图、trace 和 API 脱敏日志（dist/e2e-live-logs）。

W3-02 后完整入口还需要 Docker 和本机 MinIO。缺省先从固定 mediatool Dockerfile 构建镜像（可复用缓存），在 CPU1、1GiB、无网络且根只读的本轮容器内生成两份合法20秒视频及真实 probe 报告，再运行完整 live 集合。标准片用于20集批次，真实大于20MiB的另一片用于跨刷新续传；认证、样片、两集原质检和新批次用例全部保留，不减少集数、内部并发、原断言或超时。自动准备的容器和卷在确认终止后回收；成功后删除临时输入，失败保留首次观察，不自动补片或重造。

已有合法输入时可复用：`pnpm admin:e2e:live --video <标准片.mp4> --resume-video <大于20MiB的片.mp4> --probe-facts </tmp/lyx-w302-本轮目录/manifest.json> --mediatool-image <sha256:完整镜像ID>`。三个输入参数须一起提供；格式、字节核对和 Provider 边界见[批次验收说明](src/features/delivery/ticket-detail/batch-upload.README.md)。默认完整收集；受影响定点可用`--test-file 'test/e2e/live-media-ops.spec.ts,test/e2e/live-flow-ops.spec.ts'`，仅接受至多8个真实已有live文件的精确路径，不能用于声称完整验收。

后续页面包只在 `packages/services/src/testing/admin-live/` 新增 `<短名>.fixture.ts`，共享一个服务端进程的 `make`/`runtime`；前端调用已合并的 `admin:live:data` CLI，不导入数据库或 services。新增 `test/e2e/live-*.spec.ts`，用 `liveContext()` 读取返回的 fixtures；live 项目依赖一次登录准备并自动复用 storageState，无需改起栈脚本或 Playwright 配置。数据与登录态文件不入库。

员工真实用例 `live-staff.spec.ts` 使用 `staff.fixture.ts`：10 位假员工加 bootstrap 管理员覆盖角色、主管、待激活、待启用、禁用及10条分页；返回的 fixtures 经 `liveContext().fixtures` 读取服务端桥 JSON。三张截图为 `staff-01-list.png`、`staff-02-create.png`、`staff-03-activation.png`。同一事件循环触发两次表单提交，断言只发一个创建请求、真实查询只有一行；关闭后不再显示码，重新打开表单为空。

W1-19 PR1 的真实用例只追加本域登记：`z-order-ticket.fixture.ts` 在原 staff 之后复用“演练交付”员工走激活链，不增加原员工总量或改变角色/状态；工厂准备三种订单快照，真实 `createTickets` 建待分配工单，真实 `publish.bind` 建两条账号核验。仅将本轮既有 bootstrap 假管理员设为主管，满足实际指派守卫；另一非主管交付经理的独立会话按本人范围查看、不请求员工名单。账号五项人工核对后通过/原因驳回，静默30秒刷新保留当前输入；headless不能真实隐藏tab时，本测试页限定visibility getter+bubbling visibilitychange走实际focusManager，31秒隐藏零queue GET、恢复真实GET并保留输入，日志明确标为依赖探针。账号图片只对本轮 fileId 在两个既有假 Provider/公开本机存储 origin 的精确路径回演练字节，所有 /api 请求均走真实构建进程。四页及分配/驳回截图为 `orders-01-list`、`orders-02-detail`、`tickets-01-pool`、`tickets-02-assign`、`accounts-01-compare`、`accounts-02-reject`；1440×900 留图、1366×768 核横向溢出，保留旧激活登录、资质/员工/收款全部用例。

W1-19 PR2 的 `zz-delivery-flow.fixture.ts` 用独立“制作演练-本轮 runId”门店、两集工单和真实批准的发布账号；商家会话只交给 Node 私有 helper。上传人复用原管理员，质检与推送复用原“演练交付”经理的第二个原始恢复码，不重新激活、改角色或增加员工。详情按工单号定位；方案、样片、逐集与成片包表单均按实际 `actions` 和 `Can` 显示，写成功重新 GET，冲突保留输入。

`live-delivery-flow.spec.ts` 经生产 `UploadField` 与本域直传 adapter 完成真实 MinIO POST/complete，再由 Node 私有 helper 调 `packages/services/scripts/admin-live-delivery-media.ts`。样片窄桥只接受本检出、本轮 `APP_ENV=test`、严格配对的 `lyx_test_admin_live_<runId>` 库/前缀与 loopback 公开测试配置；复核 file/category/item/uploader/clientToken/ETag/createdAt 全部归属后，对已有 job 调实际 `runtime.media.promote`，真实 copy/head 成功且 stored 后才写固定 known MP4 事实。文件是 17947 字节、真实 1 秒、160×90 的 H.264；未知 metadata 样片仍以 `PRODUCTION_NOT_READY` 拒绝 QC，零业务写。Chrome 不保证保留 Request stream 的 postData，因此 Node 从实际注册响应取 fileId/clientToken，再经真实文件 GET 核文件名与主体，制作上下文继续由窄桥锁内核验。测试不改生产请求、公共 harness、探测/QC 或 stored 状态；对象、库与前缀按本轮归属清理。

W3-02后两集成片改用合法20秒输入、实际批次及真实工具体检；上述1秒窄桥仅保留样片。该流程走方案推送/商家确认、不同员工样片质检/推送、商家实际 900 秒附件下载留证/确认、两集上传登记、默认与单集例外质检、成片包质检至 delivering；成片包推送由 W1-20 接续。八张 `delivery-01-detail` 至 `delivery-08-delivering` 截图为 1440×900，另核 1366×768 无横向滚动。服务端窄桥目标可直接在 CI 用 Node FormData 运行；早期本机 CORS 探针显式加 `LYX_W119_BROWSER_POST=1`、`LYX_E2E_CHANNEL=chrome`，最终完整 live 总是实际浏览器上传，不以 Node 上传代替。


## W2-07 系统配置四页

`/sys/dict` 消费类型的 `canCreate/maxDepth/disablePolicy/isSystem` 与真实引用计数，以 `MasterDetailPage` 展示层级和详情。编码、类型、上级不可修改；系统枚举仅编辑名称/说明。引用为 `null` 表示来源未注册，不能当零；实际 `DICT_ITEM_IN_USE` 的 `details.refCount` 留在确认框。合法创建、改名与启停后重读，停用记录保留名称。

`/sys/params` 用 `ConfigPage` 与服务端类型、单位、范围构造字段，明确当前值、来源、当前 rev、`latestRev` 和预约列表。整批一个幂等键，CAS 使用每键 `latestRev`。立即保存与撤销预约是独立操作；预约显式提交北京时间日期/时刻换算的 `effectiveAt`。真实 409 保留旧草稿并刷新，只有点击“我已核对最新版本，保留草稿继续”才采用新版本并再次确认。无效 JSON 阻止保存；放弃草稿会重置 JSON 输入。分组与年份在 URL 中校验，草稿可跨组保留。

年度日历在参数页内读取，默认业务北京时间年、合法边界 2024–2100；导入只提交 `{year}`，服务端选择内置安排。展示未导入状态、批次、时间、`changedDays` 与重复导入无变化。当前只内置 2026；其他年份的实际 `VALIDATION_FAILED.fieldErrors` 保留路径及原因，包括缺内置安排返回的 `days`，不提供自定义日期或在线抓取。

`/sys/flags` 与 `/sys/checklists` 复用 `QueryTablePage`，登记保留 `inMenu=false,parent=system.params`；参数页按实际权限显示链接。开关路由和读取都要求超级管理员，编辑现有默认值与完整有序规则，显示规则维度和缺省分支；不伪造命中预览或告警已到达。清单仅使用契约登记的 9 个编码，普通查看者读取 active（`allVersions=false`），管理者读取草稿与退役历史并按服务端 actions 操作。启用会使旧 active 退役，放弃草稿为 retired；更改草稿先确认放弃旧版本再建新版本，两个真实提交分别成功，创建失败不会把旧草稿恢复为 active。已有业务快照不被升级。

四页私有模型直接取生成的 `operations` DTO，写表单使用正式 schema。私有 `configResult` 接收 openapi-fetch 已解析的真实 error，再交已有公共错误适配，避免 consumed body 丢失领域符号/字段路径；没有修改公共请求层。`UnsavedGuard` 消费已安装 Router 的导航保护与 beforeunload，弹窗取消另确认未保存草稿。接口列表不提供分页参数的开关/清单页在实际读取结果上筛选与分页，筛选/选中记录受 URL 校验。

模型验收：`pnpm --filter @liyoxi/admin exec vitest run src/features/system/config/`。真实验收仍执行原 `pnpm admin:e2e:live`，仅新增 `w207.fixture.ts` 与 `live-system-config.spec.ts`。造数复用既有“演练财务配置提议”员工走真实激活/口令链，只将本轮 finance 角色增加 system 查看等级，不追加员工、不增加编辑权限；两浏览器上下文共用原管理员会话，真实竞争 CAS。查看者凭据仅由 Node fetch 送入真实认证，临时登录态权限 0600 且精确清理，不进入浏览器请求 trace 或截图。

用例逐项核对真实字典引用 409、参数版本 409、缺内置年份 400 的 endpoint/status/error/refCount/fieldErrors；Chrome 对这三个刻意拒绝请求的资源诊断逐字逐数量断言，任何额外控制台错误或 pageerror 都失败，其他两项仍要求零错误。原 `recordErrors`、旧用例、runner 与 Playwright 配置均不变。

七态截图为 `dist/e2e-shots/w207-dict-01-master-detail.png`、`w207-dict-02-in-use.png`、`w207-params-01-current-pending.png`、`w207-params-02-conflict.png`、`w207-calendar-01-imported.png`、`w207-flags-01-rules.png`、`w207-checklists-01-activate-confirm.png`。截图用 1440×900，另在 1366×768 核整页/内容无横滚。确认框用真实 Tab 到取消、Tab 到确认、Enter 提交；预约日期核 Esc 关闭、Tab 到时间、Shift+Tab 返回。具体无头/有头运行结论分别记录在 W2-07 状态，不混称。

## W2-08 操作日志与访问留痕

`/sys/logs` 是唯一 `system.logs` 主从页，默认 ops；实际消费 `admin.auditLog.list/get`，复用 `MasterDetailPage`、`DateRangeField`、`DiffBlock` 与公共 mask。category 多选写 CSV，操作人、对象 ID/key 二选一、主体/门店、标题/RZ编号与北京时间日期均沿正式查询 schema 校验；筛选/切流清旧详情与游标。分页仅使用真实 nextCursor/hasMore，前驱按身份和筛选范围隔离，totalApprox 明示近似与 10,000 条封顶，不计算精确页数。URL 的日期范围也显示为两端含的文本；近 7/30 天和全部日期只改变查询条件。

列表声明已脱敏；详情显示具名安全字段，未知对象和值裁剪，密码/密钥/value 等不进入 DOM。关联 link 仅在已实现且有权限的登记页转成固定入口，未来页显示普通标签。access 切换只给超级管理员；非超管仍由真实 API 返回 403（列表）/404（详情），失败清选择，不显示旧详情。PII 留痕显示访问字段、动作、用途、备注、操作人和审计编号，不含被查看值。

`w208.fixture.ts` 只在本轮隔离库准备虚构 ops、系统任务与合法财务查看角色。`live-audit.spec.ts` 的 PII POST 使用 Node 原生 fetch：明文响应不经过浏览器或 Playwright API tracing，断言只比较布尔结果，返回 auditLogId 后以真实 GET 查询；API 日志不记响应 body。页面查询前后 ops/access 数量相同、浏览器零写请求。访问 POST 单独证明 access 数量增加一条。

真实截图在 `dist/e2e-shots/`：`audit-01-filtered-ops.png`（多条件）、`audit-02-masked-detail.png` / `audit-02-masked-diff.png`（脱敏详情与差异）、`audit-03-access-pii.png` / `audit-03-access-purpose.png`（访问留痕与用途）、`audit-04-empty.png`、`audit-05-permission-denied.png`。截图尺寸 1440×900，另在 1366×768 核对整页/内容区无横滚；图中均为虚构数据。日期空值 Tab/Shift+Tab 进出、Enter打开、Esc关闭与手输当天两端包含由真实 Chrome 验收；无头全量与有头 W208 定向结论分别写在本包状态。保留原 runner/config 与失败 trace 策略。

后续 `W2-31` 所拆 G7-A 接 `admin.exportJob.create` / `audit_logs.list` 及导出记录，不在本页放占位导出按钮；关联页落地后再按正式 link 与权限接准确对象入口。

## 错误上报装配（W2-18 PR1）

createAppServices从公开构建变量VITE_CLIENT_ERROR_DSN装配clientReporting，sender经既有中央api与生成AdminPaths发送原文信封；用户只取当前access缓存的内部staff UUID。App的React effect安装error/unhandledrejection监听并在卸载解绑。空DSN关闭采集与请求；没有增加SDK、事件正文日志或自动重发。公开DSN不得含秘密，上游项目与服务端FILE白名单由W2-27配置，真实平台收件尚未验证。去敏、分钟/会话/在途限制见[叶说明](src/app/client-reporting.README.md)；services.reporting.test真实经过生产AppServices与中央sender，原权限刷新仍沿原实现。

## 流程运维页（W2-23）

`/sys/flow-ops` 复用既有筛选表格、日期范围和普通确认构件，分别查询定时器、出站投递和回调收件箱。前两项使用正式 `AdminPage` 页码分页；回调使用 `AdminCursorPage`，筛选范围内的前驱游标最多保留 1,000 项。日期、对象、状态和分页参数进 URL，由正式公开查询 schema 校验；请求取生成 DTO，经中央客户端发送。

直接访问需 `system≥v` 或 `flow.ops.view`，侧栏仍遵循既有 system 模块等级过滤。操作按钮同时要求 `flow.ops.manage` 和服务端 `actions`。取消定时器须填 5–200 字原因；其他恢复操作接受至多 200 字备注。确认仅针对单个目标，写请求使用当前确认的幂等键。确认回显到期时刻使用带年份的北京时间，重新排期不提交新的 `fireAt`；成功或状态冲突均刷新实际列表，409 会撤下陈旧确认并提示重新核对。

本页只展示服务端已脱敏的失败摘要和固定安全字段，不展示原始载荷。三种传输状态保持中文普通文本。W3-08在同页增加媒体任务页签，只有system查看权限才查询，原flow查看入口及三资源动作保持；人工重试同时要求media.job.retry、failed与服务端actions，不以error.isRetryable替代实际业务守卫。成功重读queued/deadline，父对象由任务进程推进。

`w223.fixture.ts` 通过原真实造数登记口添加本轮隔离库的失败/死信事实，不增加初始员工或改已有角色、旧夹具。`live-flow-ops.spec.ts` 覆盖三查询、两种分页、日期键盘、四个真实恢复动作与状态冲突刷新。只读用例在原员工用例末尾注册独立 `w223-flow-ops-readonly.ts` helper，原员工数量验收结束后才通过真实创建、激活、设密码和 TOTP 接口创建自己的财务员工；不依赖文件排序，不改变旧断言或执行配置。使用原 `pnpm admin:e2e:live` 起栈和清理。截图落在原 `dist/e2e-shots/flow-ops-*.png`，失败 trace 在原 `dist/e2e-live-results`；只读登录的假手机号、口令、激活码和 TOTP 通过 typed 中央客户端与原生 Node fetch 使用，不写入 Playwright 请求步骤或截图。

浏览器请求使用中央客户端已有的 `Request.clone()`；Chrome 对流正文可能只提供实际长度而不提供 CDP `postData`。四动作验收仅观察本夹具五次精确 POST 的只读副本，原请求立即原样发往真实 API，以精确正文和幂等键断言。刻意状态冲突只允许该请求地址对应的一条固定 409 资源错误，其他 console 或 pageerror 仍失败；旧用例监听保持原样。


## 文件清除放行与媒体任务（W3-08，本地验收完成）

`/sys/file-purges`是唯一新增页，默认显示proposed/held运行，点行按purgeRunId读取真实候选，另一页签查询已清除文件。数量和字节确认保留服务端原字符串，批准只进入approved等待执行；熔断展示heldReason，不伪造阈值快照。恢复截止/actions/已彻删均来自DTO，原因、危险确认、中央stepup和当前required键沿已有构件。FILE_IN_USE最多20真实摘要，仅已实现且有权限的短剧引用给固定入口，未来页显示关联受限。

媒体任务位于原`/sys/flow-ops?tab=media`，只system查看权限才取数，不收紧原三资源权限。失败重试按真实actions，结果重读queued与deadline，输入/输出、对象键和原始异常不渲染。版本恢复成功UI用明确受控响应覆盖；真实live MinIO恢复不支持时保持503，彻删按真实枚举/精确删除/HEAD404能力处理本轮未入桶虚构对象，核终态与一次审计，不能当作真实历史版本演练。Chrome可能不提供中央克隆POST的postData，沿既有W223方式只读fetch副本精确核正文/key，原请求原样立即外发。模型与真实live定点结论见W3-08状态，类型/build/截图由ROOT串行验收。

本地6模型/运输与shared23目标分轮通过，状态字典30组/108条/0差异，admin/services类型、依赖边界、API/admin生产构建检查通过。新两组真实live与旧flow两组业务分批全绿，最终仅新两组加认证准备3G（12.4秒），已绿旧组未重复；自有库由runner清理。仅新增file_purges一页，原flow_ops仍归W2-23不重计。最后官方登记/挂载与截图归档由ROOT收口；真实历史版本/生产操作、远端CI与业主看样未验。

## 员工、角色与我的审批（W2-06，本地验收完成）

仅新增 `/sys/roles`、`/approvals` 两页；员工页和用户菜单保留 M1 归属。任务原 system/approval/auth 范围 18 文件 89 用例（包含本包 22 项）、生产构建、原完整样例 16 项及原完整真实 live 31 项通过；全工程串行类型、depcheck 与必要门禁通过。本地验收及唯一独立审查的作者定点闭环完成，交接时待实际 main 合流，未宣称远端 CI/发布完成；分段与首次失败记录见 `docs/plan/status/W2-06.md`。

员工页同筛选读取真实摘要。详情操作同时检查服务端 actions 与当前权限；启停、移交、安全重置和会话吊销使用实际确认信息。禁用先读在办摘要和同角色候选，工号及在办数由后端再次核验。分配池整体替换带当前版本，城市来自真实市级字典；浏览推荐和游标不写入。409 关闭陈旧确认、刷新实际记录，要求重新核对。激活码默认手动交付，仅当前弹层持有；重放为空明确提示，不声称短信到达。

角色页使用实际角色与13模块配置。超级管理员锁定，无写权限时只读；“仅主管”只对正式登记的主管类权限开放。“恢复默认”仅 GET 填入草稿，保存才整批 PUT 当前版本；冲突刷新后需重新编辑，不能自动覆盖。

用户菜单复用中央请求与再验证，提供改密、本人 TOTP 重绑和手填企业微信。一次性密钥、恢复码和密码仅当前弹层内存持有；关闭、退出或当前员工/角色范围改变即卸载清除。新恢复码需勾选保存后关闭，重放不再展示。扫码未开放，外部短信与企业微信送达不在页面验收中冒充通过。

我的审批只列后端真实已注册类型，摘要与列表采用相同业务筛选，日期使用北京时间。处理链接只从固定已实现页面和准确的领域 GET 符号得到；W4-18已接财务配置的真实修订列表和精确审批ID，以及现金退款的实际domain/GET白名单，分别进入既有财务配置页与退款详情。后继仍按实际类型与授权入口追加，不新增同名页或通用 approve。

真实验收使用原 `pnpm admin:e2e:live` 完整集合，不改 runner/config/时限。必要私有测试 harness 两行透传真实 Node bindings，实际唯一自有库一次查询确认三个新增上下文的 RFC5737 合成来源，未修改生产 trust 或配额。`w206.fixture.ts` 复用既有员工，只加一条合法跟进；独立恢复码由 w207 原夹具只增第二个码供本包使用，不占原测试码。新员工激活用例追加在旧 staff 用例之后，复用旧用例已创建的员工。截图命名 `w206-*.png`，一次性激活码/TOTP/二维码/恢复码遮挡；原无头 Chrome 结果和有头/真机未验证边界分别记录，不以 channel 名称替代有头事实。

本包首次冻结的 12 张截图来自同轮 live7，均为 1440×900，截图前逐项验证 1366×768 无横滚；原无头 Chrome 日期 Tab 进出/Esc 与有头/真机未验边界分开。真实浏览器源为 `9d6852f9`，后普通同步 `5e29e969` 只带入上游告警事实，未重跑并冒称新的整 main 浏览器结果；随后审批页说明保留 M4、M5 各补一段领域入口。截图清单和 SHA 随本包交接，旧失败轮次原产物保留。

唯一正式审查实际 534.498 秒，原 0 P1 / 2 P2 / 0 D 报告保留。员工操作现固定打开时快照，背景刷新后旧草稿仍使用旧 CAS；新增真实 mounted GET/旧版本 PATCH/409/重开核对回归与原 31 项同轮 32/32 通过。headless 可使用限定 visibility 依赖探针，成功 reporter 未持久化具体模式附件，不称物理切窗验证。Modal 截图等待真实稳定绘制，移交、会话和两激活完整弹窗及仅敏感值遮挡已窄验收；新的同轮 12 图和旧坏图均保留。closure 浏览器源后普通同步 `aff1ab61` 仅两份上游文档，测试叶与保护 SHA 不变；完整证据、资源清理和未验证项见状态及独立 closure 交接，不重复正式审查。

## W2-16 协议管理

`/ops/agreements` 为六协议、版本编辑/安排/撤回和脱敏同意证据的唯一主从页，实际消费 W2-12 八接口。legal_doc 上传入库后才提交双文件引用，法务确认默认关闭；当前 phase/actions、公告不足与撤回原因均取服务器返回。新 draft ID/null 与同键失败恢复、签名 PDF 每次现签、权限与旧响应丢弃见 [私有说明](src/features/ops/agreements/README.md)。样例与真实服务分别由 `agreements-m2.spec.ts`、`live-agreements-m2.spec.ts` 验证；虚构正文不代表 E8 法律审核或真实云验证已完成。实际通过范围记 W2-16 状态。

## W3-12 短剧、积分价与站点五页

五页只消费已接受的W3-09/10/11契约：`/dramas`、`/dramas/$id`、`/billing/pricing`、`/ops/home`、`/ops/mall`。列表筛选、分页、页签和返回状态进URL，summary/actions由服务端给出；基础、版权、许可、价格与站点各资源用自己的确认版本和幂等键，409保留草稿并要求核对。原片批次在编辑页复用W3-02客户端与正式batch context、匹配、人工逐集、恢复/取消/commit，不增加页面、接口或通用上传旁路。

版权已上架后只能走独立修订，当前锁与旧授权止日必须确认；新证明真实上传后才提交，current完整版权证明集合与本次revision依据分别展示。上架前读取同份十四检查及missingEpisodes/在途批次，确认调用真实接口再验证。预告片明确target/current状态和目标源预览，源预览沿正式admin.file.downloadUrls/公共Player。源异步检查仅对TRAILER_SOURCE_CHECKING且retryable=true按原body/key有界重试，支持调用者取消和清理；其他失败按原语义显示。

价格只展示服务器当前P和待生效价，修改/撤销按权限与actions；固定模板价只读。首页及商城保存草稿与发布各有独立键，第二步失败可重试实际草稿，历史复制为新草稿/新发布版。invalidRefs/fieldErrors.path真实显示，Banner排序包含未结束停用行，服务端maxActive/集合冲突重新核对。

`live-content.spec.ts`和`live-content-site.spec.ts`使用原完整bare live入口，不缩集合；R6作者HEAD f4b71258实际47/47通过（old32+C10+B5）。财务身份复用原隔离员工的专用恢复码，通过正式role PUT临时v/e与独立权限关闭、两真实403并finally恢复完整角色，不增加员工或放松配额。仅精确假COS host转发同轮validated loopback receiver，保URL/path/query/method/body/header/签名及真实receiver验证，不mock业务/API响应。

私有预告片演练严格绑定本轮注册的source/job/asset/drama/template/quality/dst，真实下载核字节/SHA，以原串行CPU1/1GiB固定镜像native转码后发布真实产物并经正式双rendition/install。默认样片分支及其guard保持，不把隔离演练当厂商/真实云认证。`w312-*.png`在本轮immutable产物记录三视口；1366/1440核横滚，1280低于正式shell最小宽有真实overflow annotation。有头/设备、真实合法运营内容及法务审核未验证。完整分轮/首次失败和最终尾检见W3-12状态与交接。


## 商家列表、详情与渠道码（W2-15）

`/merchants` 消费正式筛选、分页和同范围 summary；列表进入真实 `/merchants/$storeId` 六个页签，渠道码位于静态 `/merchants/referral-codes`。档案、资质轮次、负责人/跟进、主体成员、账号申请与活动均取实际 DTO；掩码、空值、服务端 actions、版本及确认信息保持，原资质审核仍按 submissionId 导航。

写入统一使用中央 required 幂等意图和再验证，409 刷新事实再核对；敏感签读每次现取，离页/换店/换人后中止并忽略迟到结果。已有员工查看权限者从当前范围选择在职交付经理，其余沿授权候选池；销售码归属同样只取真实可见在职员工。通用跟进不造 store 类型新建旁路，时间按北京时间控件转正式 ISO；M7 商家导出尚无 producer，入口保持隐藏。

定点验收为三个 model.test.ts 八聚合与 `live-merchant-m2.spec.ts` 两真实浏览器聚合，另复用旧 `live-review.spec.ts` 一组；失败与修复事实及最终结果见 [W2-15 状态](../../docs/plan/status/W2-15.md)。fixture 只在隔离库准备合法前置，后继状态由正式 HTTP 写口产生，不操作真实账号、通知或云对象。私有结构与操作边界见 [商家详情 README](src/features/merchant/detail/README.md)。

## 商家素材复核、代传与需求（W3-18）

既有 `/merchants/$storeId?tab=assets` 消费正式列表、同范围 summary 与详情，不新增页面、HTTP、x01 或依赖。全部/待整理/已采用、类型、可用性、肖像材料、关键词、两种正式排序及分页保留在 URL；只有当前门店当前页可见行才能读取详情。人工整理与机器全文/步骤/技术规格/建议分区，机器结果不代替用途、时效或肖像授权。

人工复核、重识别、原因软删除和授权确认同时依当前权限与服务端 actions；复核与授权使用打开时版本，保留原人工可用性，409 关闭旧意图、回读后重填。标签来自正式三维字典。失败重试保留正文与幂等键，写入成功但刷新失败只重试读取，不重复 POST；切换门店/范围/筛选或离开后中止旧操作，迟到结果不打开敏感材料。

后台代传使用 store_asset、肖像材料使用 portrait_auth，带当前门店与 onBehalfStore。复用共享 multipart 直传、complete 和 stored 轮询后才提交业务引用；正文素材与文件素材按正式结构分离。肖像补交只追加材料，仍须明确人工确认。需求状态/分页进 URL，响应关系、已收到数量及完成/撤销均取服务器；已完成或撤销需求仍按真实后端能力允许响应，不额外限制。

本地验证由 ROOT 串行完成：新增四模型、上传泵三纯组、唯一 live 文件四业务组加认证 5/5，以及 admin/services/API 类型、API/admin 生产构建、依赖/颜色/文案/页面登记检查。实际小 PNG 经真实 MinIO 上传与公开 promote 入库并关联；肖像补交后授权时间仍为空，人工确认后才更新。首轮控件选择器限定 dialog 后修复，未弱化业务断言。独审分工、分轮结果和首次失败保留在 [W3-18 状态](../../docs/plan/status/W3-18.md)。

本轮 live/build 生产源为 b0d9c103；142434f5 只收口中文提示，经单叶轻检查和 ROOT 点核，没有声明文案后重跑全套。四张实际 manual-review/demand-results/portrait-awaiting-confirmation/portrait-confirmed 截图已人工查看，绝对路径记在状态中。首片只读签名/范围回归本轮继续通过；只读前置的外部字节替身与本轮真实 MinIO 写链分别记录。

代码与本地验收已完成；真实客户肖像材料的法律有效性、E17/E22、真实识别准确率、生产云、消息送达、真机/有头及远端 CI 尚未验证，不以虚构 PNG 流程替代。


## 套餐、积分、账户与线下开单（W4-17）

六个登记项为 `/billing/plans`、`/billing/point-packs`、`/billing/params`、`/billing/accounts`、`/orders/renewals` 和既有订单菜单内的线下开单弹层。`/orders?view=payments` 是原 Orders 的独立付款单视图，详情按真实 paymentOrderId 读取付款信息、支付记录、转账凭证、退款与发票、操作日志；不把付款单伪关联到某张订购单，原订购单详情保持。

价目/权益、报价公式、余额、剩余日期、计数及可用 actions 均来自实际 typed API。通用报价只读；实际开单另取绑定当前主体、套餐、周期和意图的服务端报价，积分包保存选择时价目快照。金额 0 与 null 分开显示，不补最低积分、不在浏览器计算业务价格。参数页从已有 priceTierRevision.list 读当前 S/A/B/C，延长原因从已有 extend_reason 启用字典读，不从历史反推或硬编码。

编辑使用打开时版本，冲突保留草稿并要求重新核对；同步忙锁、同意图幂等键、中央再验证、范围 query key 与卸载取消共同限制双击及迟到回调。积分调整/延长仅发起实际审批，不自行更改余额或周期。流水使用真实游标及 10/20/50 条数，不能制造总页数；日期与值遵循服务端 DTO。

线下先真实建付款单，再按精确单号、付款 ID 与主体重新读取列表 action，允许后才登记当前主体 pay_receipt。复用共享上传器真实直传、complete 与 stored 轮询，成功 fileId 才能提交收款审核；失败可重试当前单据，关闭或换范围后旧回调失效。代传不等于到账，财务确认仍由既有后端权限和独立审核处理。

定点模型、类型、生产构建与 `live-billing-catalog.spec.ts` 的真实结果见 [W4-17 状态](../../docs/plan/status/W4-17.md)。live 的虚构余额经真实履约生成，开单开关在本轮隔离库通过原两名财务双人审批开启；私有上传入口只处理本轮成功登记、本人同主体的一个凭证文件，不扫描其他任务。旧收款演练按自身“到账演练”前缀过滤，保留原精确队列与金额断言。真实收款资料、银行到账、云账号及业主有头看样均须另验。


### W4-18 本地合流

八个财务登记项及既有审批财务入口已完成本地代码验收并合入main；六地址与两个弹层的真实读写、定点浏览、截图、受影响类型及一次组合检查通过。官方页面登记确认M4后台未实现数为0。下列分片保留各自验收与未验边界，最新结论见[W4-18状态](../../docs/plan/status/W4-18.md)。真实资金、账单、邮件/税务及E13/E20配置仍另验；M4端到端、演示和整体退出由W4-19继续完成。

### W4-18 积分调整与补偿延长审批

`/finance/credit-adjust`消费真实审批list/summary，审批ID经kind/domain/GET白名单核验后再取积分调整或延长业务详情。积分调整需billing/finance查看，延长需order/billing查看；动作取服务端actions及当前权限，发起人不得自审。通过回传当前版本和真实回显，驳回/撤回沿正式body；同意图失败复用原key，409重读后重新确认，scope/选中变化取消请求，写后先取消旧详情查询再发布真实重读结果。

本页已本地验收并单独开放，原两只读页及其余W4-18页面登记保持原状态。新增7个轻目标与正式`live-finance-approval.spec.ts`的1个业务目标通过，真实异人通过及入账读回、两类自审拒绝零动账、已有审批业务链接均已验证；截图`w418-credit-adjust-approved.png`已由ROOT看图。整包仍进行中，完整证据、首次失败及未验边界见[W4-18状态](../../docs/plan/status/W4-18.md)。

### W4-18 退款审批决定

`/finance/refunds`详情在既有查询上消费approve/reject/withdraw/void四条typed口，按服务端actions、当前权限与creator显示动作；仅人工来源且实际kind=plan_refund可处理，staging_probe保持实际状态只读。通过携带当前审批版本、单号和金额回显，作废及驳回须说明；同步闩、同正文失败原key、scope卸载取消、成功/409精确取消旧GET后真实重读共同防止迟到发布或盲重提。旧审批仅按真实domain.type/id和GET白名单进入退款详情。

新增4个模型/运输目标、受影响admin/services类型及正式`live-finance-full.spec.ts`的3个业务目标与原认证前置通过；本轮异人通过和作废均真实GET读回，无退款交易或权益回收。原筛选、读取失败后真实重试、清选中保留；两个新状态截图为`w418-refund-approved.png`、`w418-refund-voided.png`。审批片当时保留整页implemented=false；后续执行与线下登记见下段，实际角色、首次失败及完整未验边界见[W4-18状态](../../docs/plan/status/W4-18.md)。


### W4-18 发票队列与红票回填

`/finance/invoices`消费真实队列、合计和详情，开具、驳回、重发邮件及回填红票均沿四条actual typed写口。提交前真实GET核版本/actions及确认快照；同正文失败原key、中央stepup、scope/迟到保护与写后真实GET保持。PDF/OFD/XML沿现有invoice上传公口绑定本人同主体，文件读取按授权签发，敏感值取脱敏DTO。

本片六个模型/运输目标、独立上传前置三个目标及一个旧manifest兼容反例均通过，受影响admin/services/API类型通过。两个新增业务live分别验真实字典驳回/PDF开具及failed邮件重发queued/XML红票，均实际GET读回；三图作者已看，独审由m4_refund_ui同轮闭环。只开放`finance.invoices`和详情内`finance.red_invoice`，登记生成/组合检查由ROOT合流统一收口；整包仍进行中。真实邮件送达、税务/外部红票与资金未验，首轮失败及完整范围见[W4-18状态](../../docs/plan/status/W4-18.md)。

### W4-18 对账与差异处理

`/finance/reconcile`接入月/日对账、差异分页与详情及重跑、登记、处理六条既有typed口。月份、筛选、分页和选中保留在URL；金额与空值按DTO显示。重跑只确认实际账单日；九种处理取服务端allowedResolutions/actions和当前权限，核销另需超级管理员，未关联收款登记另需all范围。差异处理回传当前lockVersion、单号和金额，关联仅选真实候选；线下退回沿正式本人platform/pay_receipt上传，不借主体或手填文件ID。

同正文未知结果保留原key，同步闩、scope/月切换卸载取消、409停写重读及写后精确取消旧GET共同限制重复与迟到。已提交后读取失败仅重读；退款申请、仍受阻与完成分别按实际outcome显示。四个新轻目标及admin/services类型首次通过，独立真实live完成登记→候选关联→GET入账、原key重放全响应相等且交易不重复、重载及两状态截图；首轮依赖与重放封套RED均准确保留在[W4-18状态](../../docs/plan/status/W4-18.md)。

只开放`finance.reconcile`，官方pages/组合检查由ROOT合流统一收口。当前环境未装配可信支付账单，成功重跑未在本片浏览执行，复用W4-12已合后端证据，未伪造账单行或终态；其余处理方式由本域模型/运输目标与既有后端分别支持，未冒称九种动作均有本轮浏览证据。真实账单、银行/资金、E13/E20及完整finance角色范围继续另验，整包仍进行中。

### W4-18 退款执行与线下登记

退款详情追加execute/retry/confirmNotAccepted/recordOffline四条typed口，按当前权限、实际actions、渠道和唯一退款意图显示。确认取真实金额/原交易或商户退款单号；无版本字段的执行body不加伪字段，提交前真实GET复核完整快照。失败同意图原key、同步闩、scope取消、成功/409精确取消旧GET后实际读回保留；提交与渠道处理中不显示为已到账。线下回单走正式pay_receipt上传，另核回单权限；账号输入/确认/结果脱敏，实际流水冲突仅显示安全details。

五个新增轻目标、受影响admin/services类型与单一线下业务live加原auth通过；正式浏览链真实上传并登记线下退款，GET核唯一流水、入账、权益回收及本人登记。首轮表格3像素横溢出及首组弹层说明重叠均窄修并保留失败记录，原断言不变；最终`w418-refund-offline-confirm.png`、`w418-refund-offline-done.png`已由作者及ROOT实际看图接受。执行片当时仅将`finance.offline_refund`置implemented=true；退款整页的后续申请补齐见下段，官方pages/组合检查由ROOT合流统一收口。微信三口使用本域typed/状态守卫及W4-10既有证据，未在本片浏览触发，不扩harness；真实外部资金及完整finance角色范围仍未验，见[W4-18状态](../../docs/plan/status/W4-18.md)。

### W4-18 受控财务配置

`/finance/settings`从收款页和已验证的审批深链进入，不增加一级菜单。当前有效值与修订历史分别取正式typed接口；提议携带实际baseRevisionId，批准核版本、配置键、审批号及银行尾号，驳回说明必填。金额0与null分开，完整银行账号只留输入内存；权限/actions/发起人共同控制动作，未知结果保留原key，409重读后须重新确认，权限范围失效取消请求。

四个新增轻目标、admin/services类型与两个定点live均通过：银行由不同员工批准后读回scheduled、严格24小时生效边界及仍在生效的旧值；策略真实逐键录入含空格版本及两行主体，提议后读回准确payload，再撤回并读回终态。浏览审批者是不同于财务发起人的super_admin，两名finance的完整角色与时钟边界复用W4-13证据，不混称本片浏览验证。最终两图已由ROOT看图；`finance.settings`已实现，官方pages与组合检查随W4-18合流一次收口。真实E13收款账户/业主配置仍未验，首次失败和修复见[W4-18状态](../../docs/plan/status/W4-18.md)。

### W4-18 收款关联入口与现金退款发起

收款行按真实付款单/主体/已入账事实提供现金退款申请，并按实际单号导航关联差异与退款记录；孤儿款不生成伪退款。申请弹层消费既有typed refundQuote/create，先真实GET核归属，再展示服务端规则、金额及权益影响；写前重新GET/试算核完整确认快照，变化须重新确认。中央stepup、同正文未知结果原key、同步闩及scope/筛选卸载取消保留。创建确认返回ID后只GET重读，不因读失败重新POST；付款单详情通过同billing瘦只读投影返回原七字段退款数组，仍核同单与原scope。

三个admin风险目标、一个实际投影DB目标与受影响admin/services类型通过。精确申请live加原auth最终2/2G：实际差异导航、试算/创建与GET待批、唯一退款ID、无退款流水/现金/权益回收、七字段付款单投影及旧审批真实财务详情/业务链接；正式生产构建和不含夹具检查通过。浏览器未提供请求正文的首RED改为核实际GET持久字段，正文运输仍由原typed目标与真实服务回显守卫验证，未改harness或预算。确认、创建、审批三张`w418-refund-request-*.png`已由作者及ROOT实际查看并接受，统一组合检查另行收口。仅开放`finance.payments`与`finance.refunds`；没有第9页或外部调用，虚构super_admin不代表完整finance角色验收。整包、首次失败和外部未验见[W4-18状态](../../docs/plan/status/W4-18.md)。
