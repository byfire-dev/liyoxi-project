# mediatool：隔离的媒体工具容器

依据：[D5](../../../docs/appendix/design/d5-media.md) 第 6.2、6.6、12.1 节；[04](../../../docs/04-adr.md) ADR-030；[D7](../../../docs/appendix/design/d7-platform.md) 第 7.4 节；X-02 任务书。验证结论见 [ADR](../../../docs/adr/0043-mediatool隔离容器本地可行-ffmpeg用Debian仓库的5.1.9-经共享卷里的套接字调用.md)。

商家上传的视频来自任意注册用户，ffmpeg 是历史漏洞密集的解析器。所以解析放在这个容器里做：它没有网络、没有密钥、根文件系统只读，只读写一个与调用端共享的目录。W1-22 的整套 Compose 已复用这份镜像，媒体任务与 W3-15 素材策略已接入调用端。

## 1. 这里有什么

| 路径 | 内容 |
| --- | --- |
| `Dockerfile` | 镜像 `liyoxi/mediatool`：`node:24-slim`（固定摘要）加 Debian 12 仓库里写死版本的 ffmpeg / ffprobe，再加 `service/` |
| `service/` | 容器内 ESM 服务。`server.mjs`（套接字、排队、路由）、`ops.mjs`（原媒体操作）、`doc-text*.mjs`（隔离文档子进程与ZIP守卫）、`run.mjs`（子进程与硬超时）、`paths.mjs`（路径核对）、`boxes.mjs`、`selfcheck.mjs`、`healthcheck.mjs`；文档解析固定依赖见 `deps/` |
| `compose.verify.yml` | 验证用的 Compose：`mediatool` 套上全部约束；`fixtures`、`caller` 是两个一次性容器 |
| `verify/` | 验证：`run.mjs`（宿主机上的编排）、`make-fixtures.mjs`（造测试片与对照）、`cases/`（用例，Node 自带的测试运行器）、`bench.mjs`（耗时）、`lib/` |
| `tsconfig.json` | 给 `service/`、`verify/` 做类型检查用（`// @ts-check` 加 JSDoc）。`pnpm typecheck` 不包含它，单独跑：`pnpm exec tsc --noEmit -p infra/docker/mediatool` |

调用端在 `packages/services/src/providers/mediatool/`（`client.ts`、`schema.ts`）。

宿主类型检查先做根目录的冻结安装，再由 `tsconfig.json` 的 `paths` 读取 `packages/services` 已声明的同精确版本解析器官方类型；PDF.js 的 legacy 入口使用包的官方 `types/src/pdf.d.ts`。容器运行依赖仍由 `deps/` 的独立锁文件安装。

## 2. 怎么验

```sh
pnpm mediatool:verify   # 构建镜像 → 起容器 → 造测试片 → 跑 verify/cases/ → docker inspect 核对 → 拆掉。约半分钟
pnpm mediatool:bench    # 同样的流程，另造一条约 200MB 的片子，量“体检 + 封面”与加标的耗时
pnpm exec vitest run packages/services/src/providers/mediatool   # 调用端的用例，不起容器
```

- 本机要有 Docker。两条命令跑完都会把容器与卷删掉，不留测试片。
- 报告写在系统临时目录下的 `lyx-mediatool-out/`（`verify-report.json`、`bench-report.json`、容器日志）；`LYX_MEDIATOOL_OUT` 可以改位置。不写进仓库。
- 同一台机器上两份检出同时跑：各设一个 `LYX_MEDIATOOL_PROJECT`（Compose 的项目名），免得互相拆台。
- 业主给的样片放仓库之外的 `~/.lyx/samples/x02/`（`.mp4`、`.mov`、`.m4v`）：目录存在时自动加测（体检；不带标识的加标并回读），不存在就跳过并在输出里注明。
- CI：`.github/workflows/mediatool-verify.yml`，改到本目录、调用端或它自己的 PR 才跑，不是必过检查。
- 测试片都是用镜像里的 ffmpeg 现场生成的；ffmpeg 命令行造不出来的三种（旋转元数据、只有一个同步帧、带外部引用的 mov）靠 `verify/lib/mp4.mjs` 改字节。
- `fixtures` 里直接调 ffmpeg / ffprobe 的地方不带服务那一套约束，是有意的：一是造片，二是做对照（不强制解复用器时播放列表会不会被跟随；打开 `enable_drefs` 时外部引用会不会被跟随；不带 `use_metadata_tags` 时标识会不会丢）。对照结果写进共享目录的 `fx/manifest.json`，用例拿它与服务的表现对比。

## 3. W1-22 怎么复用

镜像定义直接用，不用改。Compose 里照抄 `compose.verify.yml` 的 `mediatool` 一段，一条都不要少：

```yaml
mediatool:
  image: liyoxi/mediatool:<版本>
  network_mode: none
  read_only: true
  user: "1000:1000"
  cap_drop:
    - ALL
  security_opt:
    - no-new-privileges:true
  pids_limit: 128
  mem_limit: 1g
  cpus: 1
  tmpfs:
    - /tmp:size=64m
  volumes:
    - work:/work
  restart: unless-stopped
```

| 事项 | 要求 |
| --- | --- |
| 环境变量与密钥 | 一个都不给。不挂 `/work` 以外的任何东西 |
| 共享目录 | 一个命名卷，mediatool 与 worker 都挂在 `/work`。别用宿主机目录：在 macOS 的 Docker Desktop 上，宿主机目录里的套接字连不上（第 6 节） |
| 属主 | 镜像里 `/work` 属于 `1000:1000`，命名卷第一次挂到 mediatool 时沿用它。所以让 mediatool 先起（worker `depends_on` 它并等健康），worker 用同一个用户（基础镜像自带的 `node`）。worker 先起的话卷会属于 root，两边都写不进去 |
| 套接字 | `/work/.sock/mediatool.sock`，由 mediatool 启动时建。worker 清扫 `/work` 时不要删 `.sock` |
| 任务目录 | worker 为每个任务建 `/work/{jobId}/`，把对象下载进去，调完删掉；启动时清扫残留。名字只用字母、数字、点、下划线、连字符，且以字母或数字开头 |
| 健康检查 | 镜像自带 `HEALTHCHECK`（经套接字问 `/healthz`） |
| 内存 | 上限 1GB 是 D5 的约定。预发节点内存小，要调低时见第 6 节的实测 |
| 镜像版本 | 本地整套环境用 `liyoxi/mediatool:local`（`pnpm stack:build` 出，W1-22 定）；推镜像仓库的标签是 `sha-<12 位提交号>`（D7 第 7.4 节，W2-25）。`:verify` 只是验证时的本地标签 |

`docText` 隔离能力已通过本地真实容器验证，W3-15 的 `doc_extract` 素材策略已接入；
当前本地代码验收见 [W3-15 状态](../../../docs/plan/status/W3-15.md) 首节。
整套 Compose 已交付于 `infra/compose/stack.yml` 与预发 `infra/compose/node.yml`，
worker 与 mediatool 共用任务卷；进程内实现（没有 Docker 时的开发退路）仍未做。
真实预发节点、跨云传输与资源性能继续按 V11 验收，本机容器结果不代替预发复测。

### docText 能力前置（W315d）

`POST /docText {path,ext,maxChars,timeoutMs?}`只收共享任务目录的相对路径；
ext仅pdf/docx/txt，输入≤20MiB，maxChars为1–250000码点。解析子进程单次
上限10秒、128MiB heap，取消/硬超时沿原进程组SIGKILL并等待close；不输出正文日志。
结果为实际`text/truncated/charCount/pageCount?`；charCount是完整正文码点数，
text按maxChars截断。PDF≤100页且仅读文本层，返回实际页数；TXT/DOCX不猜页数。
全文最多250k码点；UTF8 fatal失败再GBK fatal；无文本/损坏/加密保守失败，不做OCR。
DOCX保既有ZIP32MiB展开/256entry/8MiB单项/100倍压缩比、CRC/路径/宏/DTD等核验，
Mammoth禁外部文件/图片，正文跳过table AST节点。xlsx拒抽；PDF不声称识别/排除
所有版面表格，不生成结构化表格。此口不返回HTML或相似度，不改变D6转换器。

`MediaToolClient.docText`为兼容可选方法，生产tools接同一外呼守卫与关闭/取消确认，
并由 W3-15 的 `doc_extract` 策略消费。ASR/LLM 工厂及 API/worker 配置装配已完成，
默认模型与全局预算仍关闭，文档抽取本身不调用付费模型。
2026-10-11在Linux arm64真实隔离镜像中，
新增11项docText socket用例全部通过，含UTF8/GBK、跳过DOCX表节点、两页中文PDF、
空文本/加密/损坏、预算、ZIP及取消确认。原完整verify实际44项：43通过，1项因缺业主样片
按原条件跳过；原沙箱检查全部通过。原199.8MiB五轮probe+poster最慢376ms，三轮
stampAigc最慢421ms，原10000ms判据和回读保持；只是本机观察，不代表负载或预发结果。
文档依赖阶段已实际无网构建；完整镜像按原固定APT层/default构建通过，完整镜像
`--network=none`重建因APT缓存按网络模式分键而失败，不能声称全镜像离线重建通过。
调度接受此构建证据边界，运行时仍严格无网/无密钥/只读根/非root/1CPU/1GiB。
依赖来源和native分支见[deps](deps/README.md)；未验证Linux x64或真实业主文档准确率。

## 4. 接口

套接字上是 HTTP + JSON。路径只认 `/work` 下的相对路径，至少“任务目录/文件名”两段；输出必须写回输入所在的任务目录。

| 操作 | 请求 | 应答 |
| --- | --- | --- |
| `POST /probe` | `{ path, demuxers, timeoutMs? }` | `{ ok: true, report }` |
| `POST /poster` | `{ path, demuxer, atMs, outPath, timeoutMs? }` | `{ ok: true, sizeBytes, atMs }`；片子比 `atMs` 短时退回抽第一帧，`atMs` 返回 0 |
| `POST /stampAigc` | `{ path, outPath, aigcJson, timeoutMs? }` | `{ ok: true, report, inputSizeBytes, outputSizeBytes }`；`report` 是回读产物得到的 |
| `GET /healthz` | — | 版本、上限、排队情况、容器里别的进程 |
| `GET /selfcheck` | — | 容器自查：网卡、路由、用户、能力位、哪些目录可写、cgroup 上限、环境变量的键名 |

- `report` 的字段见 `packages/services/src/providers/mediatool/schema.ts` 的 `ProbeReportSchema`：容器、各流（编码、档次、像素格式、编码尺寸与旋转后的显示尺寸、帧率、帧数、时长、码率）、顶层 box 顺序、`moovBeforeMdat`、`aigc`（`format.tags.AIGC` 的原文）。D5 第 6.2 节 H1–H7、S4–S7 要用的字段都在。
- `demuxers` 只认 `mov`、`mp3`、`wav`、`aac`，由调用端按登记的扩展名给（mp4 / mov / m4a → `mov`）。本包只验了 `mov`。
- 没办成：`{ ok: false, error: { code, message } }`。

| code | HTTP | 含义 | 调用端归为 |
| --- | --- | --- | --- |
| `bad_request`、`bad_path`、`too_large` | 400、413 | 入参不合规；路径带 `..`、绝对路径、符号链接、跨任务目录 | `rejected` |
| `not_found`、`unknown_op` | 404 | 没有这个文件；没有这个操作 | `rejected` |
| `demux_failed`、`remux_failed`、`no_frame`、`aigc_not_readable`、`output_too_large` | 422 | 解不开；重封装失败；抽不出帧；写入的标识读不回；ffprobe 的输出超过 4MB | `rejected` |
| `busy` | 503 | 两个在跑、32 个在排队，满了 | `unavailable` |
| `killed` | 503 | 本调用已取消，或子进程被系统杀掉 | `unavailable` |
| `timeout` | 504 | 到了硬超时，进程组已杀 | `unavailable` |
| `internal` | 500 | 服务自己出错 | `unavailable` |

- 硬超时：`probe`、`poster` 各 30 秒，`stampAigc` 90 秒（含回读）。请求里的 `timeoutMs` 只能把它调短，最小 1 秒。
- ffmpeg 的输入参数（`ops.mjs` 的 `inputArgs`）：`-protocol_whitelist file`、`-f <解复用器>`、`mov` 另加 `-enable_drefs 0 -use_absolute_path 0`、`-probesize` 与 `-analyzeduration` 各 5,000,000；路径一律带 `file:` 前缀。ffmpeg 另带 `-nostdin`；ffprobe 没有这个选项，它的标准输入接的是空设备。
- 加标参数：`-map 0 -c copy -metadata AIGC=<JSON> -movflags +faststart+use_metadata_tags -f mp4`。先写到 `<outPath>.part`，回读一致再改名；不一致就删掉并报 `aigc_not_readable`。

请求取消仍走同一私有 UNIX 套接字，不新增平台 HTTP 接口。调用者为每次调用生成随机标识，服务在登记后发 `102` 注册确认；取消请求只认本服务实例和该标识。排队中的调用被移除；运行中的调用杀掉自己的进程组，并等到子进程 `close` 后才释放槽位、返回原响应或取消确认。重复取消不会影响兄弟调用。调用者沿原绝对期限等待任一路真实完成确认；两路都不能确认时返回不可用，保留该调用的工作目录，`close()` 也报告清理未确认，避免在 ffmpeg 仍使用文件时假装清理成功。硬超时、两个运行槽位、32 项队列及沙箱约束保持原值。

## 5. 调用端

```ts
import { createMediaToolClient } from "./providers/mediatool/client.js";
import { aigcMetadataJson } from "./providers/mediatool/schema.js";

const mediatool = createMediaToolClient(); // 缺省：/work/.sock/mediatool.sock 与 /work
const probed = await mediatool.probe({ path: `${jobId}/in.mp4`, demuxers: ["mov"] });
```

- 每个方法返回 `ProviderResult`，不抛错。容器连不上、没应答是 `unavailable`；输出没通过校验是 `rejected`。
- 它不信任容器的输出：应答不超过 4MB 且过 Zod；封面由调用端自己读（普通文件、不经过符号链接、不超过 1MB、是 JPEG），`poster` 返回的 `bytes` 就是校验过的那一份，上传用它，不要回头按路径再读；加标产物的大小由调用端自己量（与输入相差不超过 1MB），回读到的 AIGC 要与写入的逐字节相同。
- 它是独立的客户端，不在 `providers/types.ts` 的十二个接口里，也没有包上外呼前钩子。怎样挂到 `media` 接口由 G3-A 定。
- G3-A 要注意的：`stampAigc` 会覆盖输入里已有的标识，“上游已有标识原样保留”（D5 第 12.1 节）要靠先 `probe` 再决定调不调；加标产物（最大 200MB）是按路径上传的，上传时同样要按普通文件打开、不跟随符号链接，并核对大小；`timeout`、`killed` 归在可重试里，媒体任务的重试次数要有上限。

## 6. 已知的限制与实测

| 事项 | 说明 |
| --- | --- |
| 带数据轨的 mov | 带时间码轨（`tmcd`）之类数据轨的 mov，按 `-map 0` 流拷贝成 mp4 会失败，报 `remux_failed`，不留产物（有用例）。怎么办由 G3-A 定：拒收并提示导出时去掉时间码轨，或把参数改成只带音视频轨（改参数要回写 D5 第 6.6 节） |
| 硬超时 | 用例里用的是调短到 1 秒的 `timeoutMs`；30 / 90 秒的上限走的是同一段代码，但没有用真跑满 30 秒的输入验过 |
| 无网络容器里的网卡 | Docker Desktop 的内核会给每个网络命名空间自动建隧道占位设备（`tunl0`、`gre0`、`sit0` 等）：关着的，没有地址，没有路由，容器没有能力启用它们。所以判据是“除回环外没有启用的网卡、没有地址、路由表为空、连外部地址得到 ENETUNREACH” |
| 宿主机直连套接字 | 共享目录用命名卷时宿主机够不着。在 macOS 的 Docker Desktop 上把宿主机目录挂成 `/work` 试过：宿主机连接得到 `EINVAL`。Linux 上没有试。不作判据（任务书 第 11 节第 4 项） |
| 内存调低 | 把内存上限调到 256MB（不给交换区）：约 200MB 的片子体检、封面、加标照常。调到 128MB：加标时 ffmpeg 被内核杀掉，服务返回 `killed` 并继续可用；体检与封面照常。数字是开发机上的，预发复测（M6）要重量 |
| 封面的校验 | 调用端只做结构检查（起止标记与带尺寸的 SOF 段），不解码 |
| 音频解复用器 | `mp3`、`wav`、`aac` 在白名单里，本包没有验（素材的体检在 G3-C） |
| 平台能否识别标识 | 抖音、视频号的上传页能不能读到标识没有验（任务书 第 5 节）；业主手验后记入 V11 的备注 |

## 7. 升级 ffmpeg 或基础镜像

1. 改 `Dockerfile` 里的摘要或 `FFMPEG_DEB_VERSION`（`compose.verify.yml` 里 `caller` 的摘要跟着改）。
2. 跑 `pnpm mediatool:verify` 与 `pnpm mediatool:bench`。对照结果会变（比如新版 ffmpeg 不再把改了扩展名的播放列表认成 `hls`），用例不依赖对照的结论，只记录。
3. 结论补进 ADR；单独成 PR。

Debian 给 ffmpeg 出安全更新后，旧版本会从仓库撤掉，镜像构建会在安装那一步失败。这是有意留的：版本要人来改，改了就要重跑验证。

## 8. W3-04 固定中文字样 PNG

仅增加 `POST /watermarkPng {outPath,text,timeoutMs?}`，固定720×96透明RGBA画布、28号字、完整两行正式样片文案与日期，最多10个门店字。唯一字体为随软件保留 OFL 许可证的 NotoSansCJKsc-Regular，版本、官方来源与固定 SHA 见[fonts/README.md](fonts/README.md)；运行前校验 SHA 和 cmap 覆盖，不以方框替代不支持的字。文本仅写本任务固定 textfile，expansion=none，不进入 shell/过滤器语法；没有任意字体路径或字体 URL。

PNG 只写本任务 watermark.png，最多1MiB，30秒只能缩短；沿原并发2/排队32/无网络/只读根/非root/cap_drop ALL/pids128/1GB/CPU1。客户端独立校验 PNG CRC、尺寸、真实 RGBA/alpha、两行非空与边界不裁切，并将实际 SHA/大小绑定流式上传；不只相信服务声明。请求取消回收调用端自有 socket，服务端子进程仍沿原固定执行期与进程组清理，不宣称取消自动缩短 ffmpeg 的原预算。

新容器用例沿原 verify/bench 运行器，只使用隔离自有生成 fixture；固定最长10字门店完整文案、危险路径/参数、字体缺字均有实际像素或拒绝断言。原约200MiB五轮 probe+poster 每轮合计≤10秒、三轮 stampAigc 的预算和沙箱检查保留。2026-10-09新源实际复测31例中30通过、1条原业主样本条件跳过；最长文案第一行alpha范围x88–631/y8–35、日期x325–395/y52–72，实际两行均未触画布边界。约199.8MiB五轮probe+poster最慢232ms、三轮stampAigc最慢424ms并完整回读七字段，原10000ms判据未变；仅Mac本机观察，真实云/平台与预发传输性能未验。
