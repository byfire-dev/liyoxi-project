# 授权书 PDF 渲染验证（X-03）

| 项 | 内容 |
| --- | --- |
| 做什么 | 验证 `@react-pdf/renderer` 只靠随镜像分发的静态 TTF，能不能把《定制内容授权书》的长文本渲染对：中文换行、分页、生僻字 |
| 任务书 | `docs/plan/tasks/X-03.md` |
| 结论 | `docs/adr/` 下 X-03 的 ADR；台账 `docs/plan/external-verification/v12-authorization-pdf.md` |
| 性质 | 一次性验证代码。独立工程：自己的 `package.json`、锁文件与 pnpm 设置，不进根工作区，不进生产构建。结论入 ADR 后可删 |
| 文字 | 样张里的条款全部是占位，非法务定稿；每页页眉都标了 |

## 1. 怎么跑

都在仓库根目录跑。

| 命令 | 做什么 | 判据 |
| --- | --- | --- |
| `pnpm --dir spikes/license-pdf install --frozen-lockfile` | 按本工程的锁文件安装 | 退出码 0 |
| `pnpm --dir spikes/license-pdf render` | 渲染 `samples/` 的三份 snapshot，写 `out/short.pdf`、`long.pdf`、`extreme.pdf` 与 `out/report.json` | 退出码 0。超过 1MB、用了随附字体之外的字体、两次渲染页数不同、有的页没有页脚，都算失败 |
| `pnpm --dir spikes/license-pdf test` | 用例：页数区间、两次渲染页数相同、每页页脚、行首行尾禁则、不溢出页边、分页处文字连续、缺字、引擎行为 | 全绿 |
| `pnpm --dir spikes/license-pdf render:container` | 在 `node:24-slim` 容器里按锁文件装生产依赖，跑同一条渲染命令，与本机的页数比对，写 `out/report.container.json` | 退出码 0：容器里系统字体文件数为 0，三份页数与本机一致 |
| `pnpm --dir spikes/license-pdf typecheck` | 类型检查 | 退出码 0。要先在根目录装过依赖，见第 4 节 |
| `cd spikes/license-pdf && node ../../infra/ci/check-release-age.mjs --registry https://registry.npmjs.org/` | 本工程锁文件里每个版本都发布满 7 天 | 退出码 0 |

环境变量（都可不设）：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `LYX_PDF_FONT_DIR` | 字体目录 | 仓库的 `infra/docker/server/fonts` |
| `LYX_PDF_OUT_DIR` | `render` 的输出目录 | 本工程的 `out/` |
| `LYX_PDF_CONTAINER_IMAGE` | `render:container` 用的镜像 | `node:24-slim` |
| `LYX_PDF_CONTAINER_PLATFORM` | 传给 `docker run --platform`，如 `linux/amd64` | 不传 |
| `LYX_PDF_NPM_REGISTRY` | 容器里装依赖用的 registry | npm 官方源 |
| `LYX_PDF_CONTAINER_KEEP` | 设为 `1` 时保留容器输出目录（里面有容器渲染出的三份 PDF） | 不保留 |

`render:container` 要本机有 docker，且容器能访问 registry（要下载 pnpm 与生产依赖）。

## 2. 目录

| 路径 | 内容 |
| --- | --- |
| `samples/short.json`、`long.json`、`extreme.json` | 三份样张的 `snapshot`，结构照 D6 第 3.5.1 节 |
| `src/snapshot.ts` | `snapshot` 的类型；规范化 JSON 与内容指纹（SHA-256） |
| `src/clauses.ts` | 条款文本，按键取。`v1.*` 是长文本，`s1.*` 是一页版，`x1.*` 是极端情形 |
| `src/linebreak.ts` | 中文换行：并段、行首行尾禁则、西文长串怎么拆 |
| `src/coverage.ts` | 读字体的 `cmap`，查哪些字没收；没收的换成 “〓” |
| `src/fonts.ts` | 按字重注册字体，注册换行回调 |
| `src/template.ts` | 模板：标题、要素表、三段条款、同意记录、落款、页眉页脚 |
| `src/render.ts`、`render-one.ts`、`cli.ts` | 渲染一份；一份一个子进程（量内存峰值）；渲染命令 |
| `src/inspect.ts`、`pdftext.ts` | 从 PDF 字节里读页数、字体名、每页每行的文字。只给用例与报告用 |
| `scripts/render-container.mjs` | 容器里复跑 |
| `test/` | 用例。`engine-facts.test.ts` 把 ADR 依据的几条引擎行为固定下来 |
| `out/` | 三份 PDF、`report.json`、`report.container.json`。入库，供业主看样 |

## 3. 样张

| 样张 | 条款 | 看什么 |
| --- | --- | --- |
| 短 `short.pdf` | `s1.*` | 一页放下全部要素 |
| 长 `long.pdf` | `v1.*` | 按真实授权书的长度估的占位长文本，三页以上 |
| 极端 `extreme.pdf` | `x1.*` | 跨页的要素表（14 条许可信息）；一段 80 句、跨两次页的长段落（句子带序号，看分页处有没有丢行、重行）；18 条短编号条款；全角标点连用；标点压在行尾；中英文与数字混排；信用代码、授权书编号、长网址；160 个字符不带分隔符的长串；生僻字（䶮、龘、𬌗 等收了的；𠮷、表情符号等没收的） |

`out/` 里的 PDF 每次渲染字节都不同（文件里有生成时间），只在出样与结论变化时重新提交；用例不比对字节。

看样的七条见任务书 第 8 节。

## 4. 已知的几点

| 项 | 说明 |
| --- | --- |
| 类型检查借用根工程的 `@types/node` | 任务书允许的依赖里没有 `@types/node`，本工程没装。TypeScript 会沿目录往上找 `node_modules/@types`，找到根工程装的那一份（24.19.0）。所以 `typecheck` 要先在根目录跑过 `pnpm install --frozen-lockfile`。`render`、`test`、`render:container` 不受影响 |
| 模板不写 JSX | Node 24 能直接跑 `.ts`，不认 `.tsx`。模板用 `createElement` 写，省掉一步编译，也不用为此加依赖。G5-B 的正式模板可以照常写 JSX |
| 读 PDF 的两个文件只认本渲染库的输出 | `src/inspect.ts`、`src/pdftext.ts` 是为用例手写的最小读取，不是通用的 PDF 解析 |
| 根目录的 `pnpm lint`、`pnpm format:check` 会扫到本目录 | 已按根的规则通过。`out/report.json` 里的数组都拼成了字符串，免得被 Prettier 判为未格式化 |
