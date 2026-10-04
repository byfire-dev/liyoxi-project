# 设计地基的生成脚本

两端页面的颜色、字号、图标、后台主题都从这里生成，页面里不写色值。依据：`design/tokens.json`、`design/design-spec.md`（下称“规范”）第 1–3、5.4、6、7、9 节。

## 命令

在仓库根目录跑。

| 命令 | 做什么 |
| --- | --- |
| `pnpm design:generate` | 读 `design/tokens.json` 与图标源，重写 `packages/shared/src/design/generated/` 下的六个生成物，并出一页预览 |
| `pnpm design:check` | 重新生成，再跑 `git diff --exit-code -- packages/shared/src/design/generated`，最后查这个目录下没有未跟踪的文件（`infra/ci/check-untracked.mjs`）。有差异即失败：要么生成物被手改了，要么改了来源没重新生成，要么新出的生成物没有 `git add` |
| `pnpm --filter @liyoxi/shared test` | 生成物与来源对账、与规范对账、图标与原型对账，以及格式化与脱敏函数的用例 |

`generate.ts` 的参数（直接用 `pnpm --filter @liyoxi/shared exec tsx scripts/generate.ts …` 跑时）：

| 参数 | 含义 |
| --- | --- |
| `--out <目录>` | 生成物写到别的目录，不动仓库里的那一份。门禁自测的反例用它 |
| `--no-preview` | 不出预览页 |

生成物目录只由脚本写：目录里有不是脚本写的文件时，脚本不生成，指出文件名并以退出码 1 结束。

## 来源与生成物

| 来源 | 生成物（`src/design/generated/`，只由脚本写） | 子路径 |
| --- | --- | --- |
| `design/tokens.json` 的 `shared`、`merchant` 两段 | `merchant.scss`：商家端的 scss 变量，前缀 `$lyx-`，只声明变量 | `@liyoxi/shared/design/merchant.scss` |
| `design/tokens.json` 的 `shared`、`admin` 两段 | `admin.scss`：后台的 scss 变量 | `@liyoxi/shared/design/admin.scss` |
| `design/tokens.json` 三段 | `tokens.ts`：`sharedTokens`、`merchantTokens`、`adminTokens`，键名与取值原样 | `@liyoxi/shared/design/tokens` |
| `design/tokens.json` 与 `lib/antd-theme.ts` 里的对应表 | `antd-theme.ts`：`antdTheme`（规范 第 5.4 节的全局主题）与 `fontFamilySerif` | `@liyoxi/shared/design/antd-theme` |
| `src/design/icons/*.svg` | `icons.ts`：`ICONS`、`ICON_NAMES`、`IconName` | `@liyoxi/shared/design/icons` |
| `src/design/icons/*.svg` | `icons-mask.scss`：`$lyx-icon-masks`，图标名 → data URI，小程序配 CSS mask 用 | `@liyoxi/shared/design/icons-mask.scss` |

变量名的拼法：`$lyx-<组>-<名>`，组与名就是 `tokens.json` 的第二、三层键，如 `shared.color.primary-text` → `$lyx-color-primary-text`，`merchant.font-size.title` → `$lyx-font-size-title`。两端各有一份同名变量的（如 `border-strong`、`switch-on`），各端文件里是各端的取值。

手写的另外三样不是生成物，各有自己的子路径：状态色调字典 `@liyoxi/shared/design/status-tone`（`src/design/status-tone/`，一个业务对象一个文件）；时间与时长格式化 `@liyoxi/shared/format/datetime`、`@liyoxi/shared/format/duration`；脱敏 `@liyoxi/shared/mask`。

## 预览页

`pnpm design:generate` 同时写 `packages/shared/dist/design-preview/index.html`（`dist/` 已被忽略，不入库）。内容：两端色板、字号、全部图标（带名字与线宽）、状态标签两端各一列。合并前业主对照规范 第 1、6、9 节与原型截图看它。

## 怎么改

| 要改什么 | 做法 |
| --- | --- |
| 颜色、字号、尺寸 | 改 `design/tokens.json`（须业主过目，不在页面包里改），再 `pnpm design:generate`，生成物与来源同一个 PR 提交 |
| 加一个图标 | 在 `src/design/icons/` 放一个 `.svg`，文件名即图标名（小写短横线）。外层 `<svg>` 照现有文件的固定写法：画布 `0 0 24 24`、`fill="none"`、`stroke="currentColor"`、圆头圆角；线宽 1.8、2、2.4 三选一（18px 及以上用 1.8，16px 及以下用 2）。里面只放 `path`、`circle`、`rect`，不带 `fill`、`stroke`。再重新生成。原型里没有的图形，另把图标名登记进 `scripts/icons.test.ts` 的 `NOT_IN_PROTOTYPE`：不登记，“与原型对账”的用例会失败 |
| 后台主题多一项 | 在 `lib/antd-theme.ts` 的对应表里加一行，指到 `tokens.json` 的一个变量；规范 第 5.4 节的表同步加，否则对账用例会失败 |
| 状态与颜色的对应 | 改 `src/design/status-tone/` 下对应业务对象的文件；规范 第 6.2 节的表是依据，用例逐行对账 |

## 页面里怎么取颜色

页面不写色值，`pnpm lint:colors`（`infra/ci/check-colors.mjs`）在三个前端的 `src` 下拦十六进制、颜色函数与 Sass 的颜色运算；口径与已知查不到的写法见该脚本开头的注释。

| 场合 | 从哪取 |
| --- | --- |
| 样式文件 | 引本端的变量文件（`@liyoxi/shared/design/merchant.scss` 或 `admin.scss`），用 `$lyx-*` 变量。构建里怎么引由 W0-27a、W0-28 定 |
| 后台组件 | Ant Design 主题（`@liyoxi/shared/design/antd-theme`） |
| 状态标签 | 状态色调字典（`@liyoxi/shared/design/status-tone`）给色调名（`success`、`info`、`warning`、`danger`、`neutral`、`purple`），样式里取同名的状态色变量（规范 第 4.1 节） |
| 只能写十六进制字符串的地方 | 从 `@liyoxi/shared/design/tokens` 取常量，如 `sharedTokens.color.primary`。小程序 `app.config.ts` 里原生导航栏与标签栏的颜色（`navigationBarBackgroundColor`、`tabBar.selectedColor` 等）属于这一类：直接写 `"#ffffff"` 会被拦下 |
| 要带透明度、要调亮调暗的颜色 | 先进 `design/tokens.json` 成为一个变量（须业主过目），页面里不用 `rgba($lyx-…, 0.45)`、`darken()` 这类写法现算 |
| 规范 第 1.6 节“不进变量的颜色” | 所在的组件文件进白名单 `infra/ci/colors-allowlist.txt`。加条目是“放松”类门禁改动，走单独的 `gate-change` PR |

## 口径

脚本里不写色值（有用例扫）。图标集与原型的对账口径：原型源码里画布 24 × 24、不填充的线性图形全部收录，图形相同的只收一份；实心图形（播放、暂停、拖动手柄）与右上角胶囊示意不收。同一个意思在原型里有两种画法的，用得多的取本名，另一种加 `-alt` 后缀。
