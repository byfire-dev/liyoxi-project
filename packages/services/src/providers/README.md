# providers：外部能力的接口、未配置实现与本地驱动

依据：[01](../../../../docs/01-architecture.md) 第 9 节、第 2.2 节 P5；[04](../../../../docs/04-adr.md) ADR-039；[D7](../../../../docs/appendix/design/d7-platform.md) 第 2.2 节 D8、第 2.3 节规则 5、第 10.1 节；W0-19 任务书。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `types.ts` | 十二个接口、结果类型 `ProviderResult`、方法清单 `PROVIDER_METHODS`、外呼前钩子。领域模块只引这一个文件 |
| `unconfigured.ts` | 未配置实现，逐接口照 01 第 9 节“未配置时”一列；另有只限本地的假微信、媒体小文件通道，与图片章 |
| `storage/minio.ts` | 本地 MinIO 驱动（S3 兼容）。AWS SDK 只在这里引入 |
| `sms/console.ts` | 控制台短信：旧三方法把内容打进日志；新投递/余额方法不造成功 |
| `sms/tencent.ts`、`sms/http.ts`、`sms/sign.ts` | 腾讯云短信、10s单次HTTP、TC3签名，零新依赖 |
| `index.ts` | 工厂 `createProviders`、生效状态汇总与启动打印 |
| `../testing/providers/` | 十二个测试替身，一接口一文件，经 `@liyoxi/services/testing` 导出 |

## 2. 怎么用

领域模块只依赖接口，由装配处把实现传进来：

```ts
import type { StorageProvider } from "../providers/types.js";
```

每个方法都返回 `Promise<ProviderResult<T>>`。没办成不抛错，看 `reason` 降级：

| reason | 含义 | 调用方 |
| --- | --- | --- |
| `unconfigured` | 这项能力没配置 | 按 01 第 9 节“未配置时”一列降级 |
| `unsupported` | 当前驱动没有这个方法的能力（如本地 MinIO 不签发临时密钥） | 走另一条通道 |
| `unavailable` | 外部服务连不上、超时或报 5xx | 可以重试 |
| `rejected` | 外部服务明确拒绝，或入参不合规 | 不重试 |

只有程序错误才抛：外呼前钩子抛的错（在事务里外呼）原样抛给调用方。

入口要不要展示（如微信支付），看接口上的 `configured`，不靠调一次试。

## 3. 什么都不配时用哪个实现

工厂构建时不连网、不外呼，什么都不配也能启动。生效状态的取值：真实驱动名、`local`（只限 local、test）、`fake`（测试替身）、`unconfigured`；esign 的图片章记作 `stamp`。

| 接口 | local、test | stg、prod |
| --- | --- | --- |
| `wechat` | `local`：假实现（openid 由 code 推出，内容安全一律放行） | `unconfigured` |
| `wechatPay` | `unconfigured`：只剩对公转账 | 同左 |
| `sms` | `local`：控制台输出 | `unconfigured`：提醒只剩站内与订阅消息 |
| `storage` | `local`：本地 MinIO，只有小文件通道 | `unconfigured` |
| `media` | `local`：小文件通道，不处理、直接返回完成 | `unconfigured` |
| `ocr`、`asr`、`llm`、`wecom`、`mail`、`invoice` | `unconfigured` | 同左 |
| `esign` | `stamp`：图片章 | `unconfigured`；打开图片章开关才是 `stamp` |

启动日志里十二个接口各一行（`provider <接口名>: <状态>`），最后一行 `providers ready` 汇总。只打状态，不打任何配置值。

在 stg、prod 选了只限本地的驱动（控制台短信、本地 MinIO），或只提供微信配置与运行时依赖的一半，抛 `ProviderConfigError`。

## 4. 选项与环境变量

`createProviders` 的三个本地选项（`ProviderSettings`）为 `sms.driver`（`console` / `tencent`）、`storage.driver`（`minio`，另可用 `storage.minio` 覆盖连接参数）、`esign.imageSeal`（图片章开关）。

W2-21 增加 `settings.wechat { appid, secret }`，须同时提供借用的带前缀 Redis、时钟和关闭登记。运行时只从 `loadEnv().WECHAT` 注入；`WECHAT_APPID` 与三个 `*_FILE` 配置须完整成组。完整配置选择真实微信驱动，local/test、stg、prod 分别使用 develop、trial、release；初始化零 HTTP。全未配保留表中的本地假实现或未配置行为；显式 `RuntimeOptions.providers` 替身优先。运行时关闭先取消自有驱动在途请求，再关闭父 Redis；驱动不关闭借来的 Redis。密钥值与 openid 不进生效状态日志。

本地存储地址通过 `MINIO_ENDPOINT`、`MINIO_PUBLIC_ENDPOINT` 从 `loadEnv().MINIO` 注入 API 和 worker，仅 local/test 可用；两项各自可选，未填沿用固定开发默认。只接受不含凭据、查询、片段与路径前缀的 HTTP(S) 根地址。图片章开关仍未提供环境变量入口。早期关于样例键数写死的限制已解除，当前 `infra/ci/test/env-example.test.ts` 动态核对 `loadEnv` 的键集合。

W2-22 已经把短信 `SMS_SECRET_ID_FILE`、`SMS_SECRET_KEY_FILE`、`SMS_SDK_APP_ID`、`SMS_REGION` 接入唯一 `loadEnv`、`.env.example` 与 api/真实worker组合根。FILE-only、成组半配拒绝，未配保留原降级；env-example 门禁现按键集合核验，不再是早期固定6键的阻塞。短信初始化、九模板变量、保活、官方激活码偏差与外部未验见 [notify README](../notify/README.md)。短信 `unavailable` 的受理不明结果禁止自动重发；本Provider内部所有方法只请求一次。

真实驱动的变量名由带来驱动的包登记，前缀按 D7 第 2.5 节（`WXPAY_*`、`COS_*`、`CI_*`、`WECOM_*`、`OCR_*`）；D7 没给前缀的用接口名大写（`SMS_*`、`MAIL_*` 等）。密钥类变量在任何环境只认 `*_FILE`；成组变量半配即启动失败（往 `kernel/env.ts` 的 `ENV_GROUPS` 里加组）。

## 5. 本地 MinIO

- 连接参数是 `infra/compose/local.yml` 那套共享容器的固定开发值（`LOCAL_MINIO`），不是密钥；与 compose 文件是否一致由 `storage/minio.test.ts` 核对。
- `endpoint` 用于服务端存储操作，`publicEndpoint` 用于客户端直传与签读；不配对外地址时沿用内部地址。真机地址与内部地址不同时分别构建 SDK 客户端，GET 的 Host 参与签名，代理必须保留 Host。不得签发后替换 URL 主机。局域网用法见 [整套环境](../../../../infra/stack/README.md) 第 4 节。
- AWS SDK 缺省会去读环境变量与 `~/.aws` 下的文件找配置。驱动把这些选项全部写明，SDK 就不读那些文件；升级 AWS SDK 后要重查一遍（看有没有新增的这类选项）。
- 四个桶：`lyx-local-secure`、`lyx-local-asset`、`lyx-local-media`、`lyx-local-pub`，都是私有桶。驱动第一次用到时建好，已有的不动；compose 里不另建桶。
- 直传只能落在写入区 `incoming/`；入库是条件复制到正式区（对上源对象的 etag 才复制）。
- 没有临时密钥、没有版本控制：分块上传与续传在这里测不到。
- MinIO 没起来不影响启动，调用时返回 `unavailable`。用例要连它：先 `pnpm infra:up`。连不上时 `storage/minio.test.ts` 里要连它的几组跳过并在标准错误里提示；带 `LYX_TEST_MINIO=required` 跑则直接失败（CI 的那一步与验收都带着它）。
- 那套容器由几个 worktree 共用：用例每次运行用自己的键前缀，只删自己建的对象，不删桶。

## 6. 加一个真实驱动

1. 新建 `providers/<接口>/<驱动>.ts`，实现 `types.ts` 里的接口；`status` 写驱动名，`configured` 为 `true`。
2. 在 `index.ts` 里对应的位置加选择分支（各处都留了注释）；变量按第 4 节登记。
3. 接口要加方法时三处一起改：接口、`PROVIDER_METHODS`、未配置实现与替身，另补 `testing/providers/samples.ts` 的样例入参。少一处 `pnpm typecheck` 即失败。只增方法或可选字段；改已有签名要在 PR 描述里单列。
4. 驱动文件只在装配处经 `index.ts` 引入。领域模块引 `types.ts` 以外的文件，`pnpm depcheck` 报 `providers-via-types`。

## 7. 外呼前钩子

每个方法的入口先调一次 `beforeCall({ provider, method })`，由工厂统一包上（`withBeforeCall`），实现里不用自己调。`createProviders` 自己的缺省是空转；进程装配不直接调它，走 kernel 的 `assembleProviders`（KF-1），钩子固定是 `guardProviderCall`：在事务里外呼，local、test 下在这里抛错，stg、prod 上报后照常调（D7 第 2.3 节规则 5）。替身 `createFakeProviders()` 缺省也是它。

## 8. 替身

```ts
import { createFakeProviders } from "@liyoxi/services/testing";

const fakes = createFakeProviders({ clock });
fakes.wechatPay.failNext("createJsapiOrder");
```

每个替身都能记录调用（`calls`、`callsOf`）、注入失败（`failNext`）与延迟（`delayNext`，拨动时钟后 `tick()` 放行）。各自的预置与编排入口写在各文件开头：

- 假微信支付：回调的延迟、重复、乱序、失败与查单结果；预下单幂等于商户单号，退款幂等于退款单号。
- 假微信：文本检测可切到“服务不可用”；图片审核直接放行。
- 假媒体：体检给预置报告；转码、打包直接完成；视频审核直接放行。
- 假存储：对象在内存里，不依赖 MinIO；到期与否按替身的时钟判。

## 9. 通知发送结果协议（W2-17 前置 PR2）

只有 `wechat.sendSubscribeMessage`、三个旧短信方法、`wecom.sendAppMessage`、`mail.send` 使用 `NotificationProviderResult<T>`，入参增加可选 `signal`。方法名、旧 `ok(value)` / `failed(reason,message)` 结果、邮件原 `value.messageId` 都兼容；通用 `ProviderResult` 和支付、存储等能力不变。

通知失败可带 `notification: { acceptance, code }`，分类只取 `NOTIFICATION_FAILURE_CODES`；构造器 `notificationFailed` 对强转值、继承字段和额外字段同样做运行时验证。`acceptance='not_accepted'` 需驱动确有未受理证据；`unknown` 表示不能判断。旧通用失败没有这项证明，调用方必须视为受理未知；不能因为 `unavailable` 或 `rejected` 就重发。这项协议不决定重试、退款或派发状态。

`notificationOk(value, providerMsgId?)` 保留旧 value；服务商标识可选，仅接受≤64字符的 ASCII 标识（字母数字开头，其余可含 `._:-`），不接受URL、正文或控制字符。没有实际标识就省略，成功也不代表终端到达。替身/local成功不会伪造此字段。

通知替身增加 `failNotificationNext(method, detail, options?)`，仅允许本接口的通知发送方法；旧 `failNext` 原样不带受理证明。预取消不执行发送action；替身的 `delayNext` 沿旧语义在调用开始就执行action，仅压住应答，因此途中取消返回 `unknown/aborted`，不会撤销已记录发送。取消、正常释放或action程序错误均清除自己的等待项/监听器；不自动再调用。`signal.reason` 不进入结果或日志。

未配置通知明确返回 `not_accepted/unconfigured`，预取消返回 `not_accepted/aborted`，不外呼。local微信/consoleSMS只在同步日志之前检查取消，保留已有local/test日志行为；它们没有真实外部请求。生产工厂/替身的原事务guard仍在最外层先执行，预取消也不能绕过正在存活的本层或祖先TX。

真实驱动尚未在本包接入；未来驱动必须把signal传递至全部实际IO，并在返回取消前释放自有资源。该字段本身不能让不支持取消的旧驱动终止网络。这里没有新增HTTP/x01/队列/DDL/派发器、外部回执处理或真实短信，W2-17整体仍待PR1与本PR2实际main后由PR3集成。

## 10. COS 四桶与短授权（W3-01）

`storage.driver=cos` 与 `storage.cos`/transport 必须成对；构造零 HTTP。`COS_REGION`、四个 `COS_BUCKET_{SECURE,ASSET,MEDIA,PUB}` 是同账号的带 APPID 物理桶名。业务枚举仍为 secure/asset/media/pub。三角色只从≤4KiB JSON 普通 FILE 读 `{secretId,secretKey}`：API 配 signer+stsIssuer，worker 配独立 worker；中央装配只传入本入口角色。完整 COS 不与 MinIO 配置混选，半配启动拒绝，stg/prod 无本地回退。E4 的角色策略、四桶/CDN/CORS 和真实云联调仍需业主授权办理，没有调用真实云。

COS 对象签名是 SHA1，STS JSON 是 TC3-HMAC-SHA256，二者不能混用。官方 canonical SHA1 中间向量与独立 Python 固定 TC3 向量均由公开假 key 验证；TC3 正文的 Policy 先做一次 RFC3986 URL 编码。小文件 post policy 固定 bucket/key/MIME/大小和签名身份/时段，最多10分钟；大文件 STS 最多30分钟，只允许 `incoming/<fileId>/` 下 Init/UploadPart/ListParts/Complete/Abort，不授正式区写/删、读其它文件或列桶。

`abortMultipart` 是新增公开能力，方法清单、未配置、fake 和 MinIO 同步登记。取消只使用 exact object key 的 Abort 资源；列未完成上传另按官方 `cos:prefix` 的 string_equal 条件限定，列表返回再按完整 key 精确过滤。最多10页×100项、每响应64KiB，grant/list/abort 共用10秒总预算；不足或失败交原写入区补偿清扫，没有增加队列或自动重试。MinIO 明确 unsupported，保留原 post、小文件、备份 putObject 条件语义。

所有固定 HTTPS origin 请求禁止重定向，单请求10秒，实际逐块读取协议正文≤64KiB；readPrefix 仍最多4096字节并带条件 ETag，二进制不做 UTF8 解码。HEAD 返回可选 CRC64/versionId，CRC 由服务端事实得出；copy 使用官方条件源 ETag，promote 再 HEAD 核大小、ETag 和确认时CRC。驱动 close 只取消/等待自有请求，不关闭借用资源；外层 TX 外呼守卫保持。

实际 `apps/worker` 使用 `buildWorkerServices`：只将 COS worker 角色与业务时钟注入存储工厂，缺 worker 角色在任何绑定前拒绝，不借 API signer/issuer。`closeStorageDrivers` 等待本次装配的自有请求回收并允许重复关闭；实际 worker 的关停、自检成功和装配/自检失败路径均接入，不关闭借用数据库或队列。

`putObject(ifAbsent)` 不使用 S3 的 If-None-Match/412：worker 先只读当前 bucket versioning；未知、Enabled、Suspended 或无读取权返回 unsupported。只有正式 VersioningConfiguration 无 Status 的未启用版本桶才用 `x-cos-forbid-overwrite:true`；仅409 FileAlreadyExists后核真实HEAD的SHA256、大小和contentIdentity，匹配才算重放。该原子保护依赖E4桶配置受控、写入途中不由外部管理员切换版本；真实桶配置尚未验。当前 `capabilities.versioning=false`，不会凭配置存在推定历史版本操作已可用；HEAD的实际versionId仅作为事实，不宣称已实现erase/restore。

2026-10-08 查阅的 primary 来源（未访问云控制台/凭据发现链）：[COS 请求签名](https://cloud.tencent.com/document/product/436/7778)、[POST Object及签名策略](https://intl.cloud.tencent.com/document/product/436/14690)、[STS TC3 v3](https://cloud.tencent.com/document/api/1312/48202)、[GetFederationToken参数](https://cloud.tencent.com/document/api/1312/48195)、[COS授权条件cos:prefix](https://intl.cloud.tencent.com/zh/document/product/436/46205)、[PUT Object防覆盖与版本限制](https://intl.cloud.tencent.com/zh/document/product/436/7749)、[List Multipart Uploads](https://cloud.tencent.com/document/product/436/7736)、[官方SDK签名公式](https://github.com/TencentCloud/tencentcloud-sdk-nodejs/blob/master/src/common/sign.ts)。本地fake HTTP 验证协议、超限、拒绝、一次请求、条件读取和关闭，不代表四桶真实云验收。

## 11. CI 媒体原语（W3-03）

新增可选 `media.describe/find/cancel`，并在真实CI、unconfigured/local、替身与样例中完整登记；已有probe/transcode/pack/audit方法名称保留，只增可选signal。老adhoc替身缺新增方法时统一执行器保守等待回查，不构造none证据或假成功。四桶/FILE角色、官方REST与独立签名向量见[media/README.md](media/README.md)。Storage.head/copy、Wechat.checkImage只增可选caller signal；未传信号沿旧行为，MinIO带signal的HEAD/copy不走不可取消的建桶初始化，使用已存在桶。所有自有IO关闭与祖先TX guard保持。
