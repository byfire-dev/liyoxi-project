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
| `mail/` | worker独立Tencent SES模板邮件HTTP、TC3签名/附件与取消生命周期，见[邮件README](mail/README.md) |
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
| `ocr`、`asr`、`llm`、`wecom`、`mail`、`invoice` | `unconfigured`（显式配置见后文） | 同左 |
| `esign` | `stamp`：图片章 | `unconfigured`；打开图片章开关才是 `stamp` |

启动日志里十二个接口各一行（`provider <接口名>: <状态>`），最后一行 `providers ready` 汇总。只打状态，不打任何配置值。

在 stg、prod 选了只限本地的驱动（控制台短信、本地 MinIO），或只提供微信配置与运行时依赖的一半，抛 `ProviderConfigError`。

`types.ts` 另公开 `isLlmDigestInput`、`isLlmVisionInput`、`isAsrSubmitUrl`、
`isAsrQueryTaskId` 四个纯数据校验，委托现有协议规则，不创建驱动或外呼。
ASR URL 保持原 JS 字符串长度界限，查询保持原字符串 uint64 判定；不新增空白规范。
这些函数不代表已配置、来源可信、预算许可、信号未取消或租约仍有效，调用者须另行守卫。

## 4. 选项与环境变量

W4-09发货的 `wechat.uploadShippingInfo/queryShippingInfo` 使用官方小程序access_token端口，复用原token缓存、取消/关闭与beforeCall守卫；不是微信支付商户V3签名口。只支持虚拟商品统一发货，查单仅投影核对所需的交易、付款人与发货事实，不返回原始errmsg。新增方法可选，旧Provider没有此能力时由消费方拒绝；local不伪造真实发货，fake需显式预置订单事实。上传失败仅完整已知平台拒绝可标not_accepted，其余unknown；Provider内部不重送，丢回包后的持久去重和真实查单由W4-09领域完成。当前仅协议适配源码，不代表订阅者或任何真实发货已经验收。

`WECHAT_PAY_FILE` 的既有严格JSON可选增加 `merchantCertificatePem`。唯一 `loadEnv` 在本地解析X509，将证书serial按十六进制同值规范化后对照 `merchantSerialNo`，并核对证书公钥与 `merchantPrivateKeyPem`；这里不拿微信支付平台 `publicKeyPem` 冒充商户证书身份。错误只返回字段/原因，不回显文件路径、证书或私钥。通过后丢弃输入证书PEM，只在输出 `WECHAT_PAY.merchantCertificateExpiresAt` 暴露证书自身validTo的ISO事实，源JSON不能填写该派生值。旧配置不带证书仍原输出、可启动；期限未知由后继健康读侧保持null+breach，不推测签发时长或以serial猜日期。不新增环境键、Provider方法、网络获取/证书链校验或轮换动作。

`createProviders` 的三个本地选项（`ProviderSettings`）为 `sms.driver`（`console` / `tencent`）、`storage.driver`（`minio`，另可用 `storage.minio` 覆盖连接参数）、`esign.imageSeal`（图片章开关）。

W2-21 增加 `settings.wechat { appid, secret }`，须同时提供借用的带前缀 Redis、时钟和关闭登记。运行时只从 `loadEnv().WECHAT` 注入；`WECHAT_APPID` 与三个 `*_FILE` 配置须完整成组。完整配置选择真实微信驱动，local/test、stg、prod 分别使用 develop、trial、release；初始化零 HTTP。全未配保留表中的本地假实现或未配置行为；显式 `RuntimeOptions.providers` 替身优先。运行时关闭先取消自有驱动在途请求，再关闭父 Redis；驱动不关闭借来的 Redis。密钥值与 openid 不进生效状态日志。

本地存储地址通过 `MINIO_ENDPOINT`、`MINIO_PUBLIC_ENDPOINT` 从 `loadEnv().MINIO` 注入 API 和 worker，仅 local/test 可用；两项各自可选，未填沿用固定开发默认。只接受不含凭据、查询、片段与路径前缀的 HTTP(S) 根地址。图片章开关仍未提供环境变量入口。早期关于样例键数写死的限制已解除，当前 `infra/ci/test/env-example.test.ts` 动态核对 `loadEnv` 的键集合。

W2-22 已经把短信 `SMS_SECRET_ID_FILE`、`SMS_SECRET_KEY_FILE`、`SMS_SDK_APP_ID`、`SMS_REGION` 接入唯一 `loadEnv`、`.env.example` 与 api/真实worker组合根。FILE-only、成组半配拒绝，未配保留原降级；env-example 门禁现按键集合核验，不再是早期固定6键的阻塞。短信初始化、九模板变量、保活、官方激活码偏差与外部未验见 [notify README](../notify/README.md)。短信 `unavailable` 的受理不明结果禁止自动重发；本Provider内部所有方法只请求一次。

真实驱动的变量名由带来驱动的包登记，前缀按 D7 第 2.5 节（`WXPAY_*`、`COS_*`、`CI_*`、`WECOM_*`、`OCR_*`）；D7 没给前缀的用接口名大写（`SMS_*`、`MAIL_*` 等）。密钥类变量在任何环境只认 `*_FILE`；成组变量半配即启动失败（往 `kernel/env.ts` 的 `ENV_GROUPS` 里加组）。

W4-13邮件前置：`MAIL_TENCENT_FILE`完整JSON只由worker装配，API不授发送driver；
缺配保持unconfigured，SendEmail仅模板`{text}`与真实附件字节，服务商MessageId不代表邮箱到达。
FILE/模板/附件与未验边界见[邮件README](mail/README.md)；部署角色接线/门禁伴随后继，不在驱动片修改。

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

## 12. W3-04 有界对象流与原生图片水印

Storage 只增 readTo/putStream，旧小对象接口及10秒协议预算保留。readTo 将预期大小、最大大小和 ETag 与真实 HEAD/IfMatch GET 绑定，逐块等待 sink 并核实际长度/SHA；putStream 的 body(signal) 可顺序重开，两次实际扫描分别核长度/SHA，写固定逻辑桶/对象键和 contentIdentity，HEAD 元数据、大小和非空 ETag 仅筛选已有候选；采纳前以该 ETag 条件 GET 完整读取，逐块核真实长度/SHA 与预扫描字节一致，避免请求元数据正确而已写字节错误被重放采纳。此校验沿同一外层180秒信号，不重置预算，每次候选重放增加一次 HEAD 和全量 GET 的明确成本。COS 仍核版本未启用并使用官方 forbid-overwrite；MinIO 仍用原子 IfNoneMatch。未知网络结果不当条件冲突或成功。

流块最多1MiB、实现防御上限2GiB、独立传输预算180秒；媒体处理器仍保持正式200MiB/180秒和执行器原 hard timeout，不扩任务预算。来源、sink 和写入流均有 backpressure；取消和 close 等待自身 iterator/reader/Readable finally，未关闭借用兄弟 Storage、DB 或 Redis。workIO 只给任务内固定相对文件名，O_NOFOLLOW/普通文件检查、poster/PNG 已校验字节的 SHA/大小绑定阻止换文件；宿主工作文件核 hash 与驱动两次流扫描是三次顺序读取的明确成本。

CI Image 水印仅允许与输入同桶的固定 ci-out/jobUUID/watermark-SHA.png，服务端构造15分钟 COS GET 短签名；没有任意 URL 输入，签名不进任务事实。原生 Text 的字符限制无法表达正式文案，因此保留文案并受控拒绝，不改标点或空格。模板与 inline 混用、跨桶图片、额外字段和超过3节点拒绝。2026-10-09查阅 primary：[Text 参数](https://intl.cloud.tencent.com/zh/document/product/1045/43639)、[Image 模式与同桶限制](https://intl.cloud.tencent.com/document/product/436/46873)、[SDK原生图片节点](https://cloud.tencent.com/document/product/460/77715)、[三节点上限](https://cloud.tencent.com/document/product/460/108706)、[模板优先级](https://cloud.tencent.com/document/product/436/119461)。独立 fake HTTP 仅证明协议与签名；真实云模板/图片执行另验。

## 13. 可信视觉处理签名（W3-15 窄片）

`Storage.presignVisionGet({bucket,key,expiresSec,source})` 是必需方法位；COS 只接受严格的 `source:{kind:'image'}` 或 `{kind:'video-frame',atMs}`，拒绝任意 query、地址及下载覆盖。对象键使用既有四逻辑桶、UTF-8 1024 字节上界和路径限制；到期为 1–3600 整秒。视频毫秒须为非负安全整数，以整数商余生成十进制秒，不舍入浮点输入。旧 `presignGet` 与签名算法保持原实现。

图片固定按 `auto-orient` → `thumbnail/1280x1280>` → `format/jpg` 管道签发；只缩小、保持比例。视频固定 `ci-process=snapshot`、`time`、`width=0`、`height=0`、`format=jpg`、`rotate=auto`、`mode=exactframe`，再应用同一缩小上界，共八个处理 query。所有处理键（包括空值管道键）、GET、host 和对象路径一次性参与 COS 签名，签后不补处理参数。不允许忽略处理错误或退回原图的参数。

新能力仅签北京、上海、广州、成都、重庆、南京的固定 COS 主机；其他地域返回 unsupported，普通下载不受影响。MinIO 和替身明确 unsupported；未配置继续 storageOff，工厂不默认启用新驱动。这里不查对象归属、大小或 ETag，调用方仍须按当前主体/文件事实授权。域名和配置不证明数据地域满足 E22。

本地 HMAC/协议测试不证明真实云 IAM、桶启用 CI、处理可达性、产物尺寸/字节、视频 PTS、费用或模型调用已验。`exactframe` 与参数时刻不构成实际帧时刻证明；真实云验收另行记录。原 MinIO 整文件验收仍需 `LYX_TEST_MINIO=required`，只清理本轮自有对象。

官方依据：[缩放](https://cloud.tencent.com/document/product/460/36540)、[管道](https://cloud.tencent.com/document/product/460/15293)、[图片格式](https://cloud.tencent.com/document/product/460/36543)、[视频截帧 GET](https://cloud.tencent.com/document/product/460/49283)、[COS 签名](https://cloud.tencent.com/document/api/436/7778)、[地域限制](https://cloud.tencent.com/document/product/460/36620)。

## 14. ASR/LLM 显式工厂配置（W3-15）

`settings.asr` 使用已有 `TencentAsrConfig`，与 `options.asr` 的原
`TencentAsrOptions`、必需 `registerClose` 成对；ASR 时钟仍由 `now` 注入。
`settings.llm` 使用已有 `DomesticLlmConfig`，与 `options.llm` 的原
`DomesticLlmOptions`、必需 `registerClose` 成对，不额外添加时钟选项。
两个 transport 均沿原 `fetch` 字段；半配或关闭登记不是函数时启动拒绝。
完整配置选择 `tencent`/`domestic-llm`，构造零请求，每个实际驱动的 `close`
恰好登记一次，最后统一包原外呼守卫并打印脱敏状态。登记拥有者负责关闭，
包括后续构造失败时已经登记的驱动；工厂不聚合关闭，也不关闭借用资源。

全部未配保持原默认表；现有生产 env/API/worker 未在本片增加模型配置读取或启用。
ASR 仍提交后以原任务号回查，旧 `transcribe` 不冒充同步完成。LLM 固定目的地主备、
最多三请求/一次结构修复以及原期限保持。此处可显式选择不代表真实平台已开通，
不创建预算账本或许可。真实凭据、地域/隐私/E22、收费及准确率仍需另行验证。


## 15. 模型 FILE 配置解析（W3-15）

`ASR_TENCENT_FILE` 与 `LLM_DOMESTIC_FILE` 独立可选，分别解析为 `Env.ASR_TENCENT`
与 `Env.LLM_DOMESTIC`。任何环境均拒绝同名明文基键；每份普通文件最多4096真实字节，
只接完整严格 JSON。ASR只含secretId/secretKey，LLM必须含text/vision的primary/backup；
端点仅vendor/model/apiKey及百炼workspaceId，不接受URL、超时或其他额外键。
解析保持已接受驱动原字符串谓词，所有层深冻结；错误只含键名和静态原因，不含路径/内容。
本片仅解析数据，尚未接API或worker的模型驱动/关闭生命周期；文件存在不代表模型调用
或云权限/收费已获授权。未配保留原未配置行为，不改默认200/0或冷账本。
当前SOURCE仅轻静态，新旧测试尚未执行；真实云、E22、收费和完整W3-15仍待办。

## 16. worker 模型驱动所有权（W3-15）

worker 将已解析的 `Env.ASR_TENCENT` / `Env.LLM_DOMESTIC` 经 kernel 工厂装配，
显式配置必须同时提供本实例 `modelDrivers.registerClose` 与 `modelDrivers.close`。
ASR 取该实例时钟，LLM 沿原 HTTP 主备和期限；构造不发送模型请求。
借用整套 `providers` 时不创建、登记或关闭模型驱动；API 仍保持未配置。

实际入口先持有关闭列表与缓存 Promise，后续构造、自检、租约或启动失败仍收尾；
正常 stop 先禁准入，收完业务、媒体与队列，再等待全部模型 close，最后关闭预算与告警。
一个模型关闭失败仍等待另一个并继续清理，入口在 stop 后以同一 Promise 兜底。
不改原请求、业务或队列期限；模型驱动不关闭借用数据库、Redis、队列或其它实例。

付费 owner 沿已接受的预算桥，缺省2000/0、冷账本仍保守关闭。
本片不创建或恢复账本、不退款、不启用真实平台；FILE 存在不代表预算或付费授权。
COS普通GET上限补齐至7200秒供正式转写两小时地址使用，视觉专口仍限3600秒；
各业务分类TTL与原签名算法保持，ZIP三小时的独立缺口不在本片。
当前仅SOURCE/轻静态，新增与41个完整旧测试、三消费者类型及全门禁尚未执行。
真实模型、云权限、地域隐私/E22、费用、准确率、容量和完整W3-15仍未验。

## 17. API ASR 前置装配（W3-15）

API显式消费已解析的`Env.ASR_TENCENT`，经原kernel工厂构造腾讯ASR；LLM仍未接入。
自有配置须成对提供`modelDrivers.registerClose/close`，借用整套providers不消费该端口。
入口先持缓存关闭Promise，部分构造失败仍关闭已登记驱动；正常排空后等待模型及预算关闭，
独立cleanup失败仍清理其余资源并保留首异常。模型构造零HTTP不等于本地基础设施零网络。
API使用完整预算准入口但不拥有transport，新提交保守关闭；已有TaskId只回查，不重新扣提交槽。
不新增预算连接、初始化、恢复、退款、回调默认源或付费授权。当前仅SOURCE与轻静态，
真实执行、密钥、云权限、地域隐私/E22、费用和完整W3-15均待验。

## 18. ASR默认回调装配（W3-15）

API/worker仅自有腾讯工厂消费完整冻结ASR_TENCENT/ASR_CALLBACK时，把同份原UTF8
key交发送协议与默认收件来源。素材owner仅在该装配事实为true时提交真实job.id；
缺省不附CallbackUrl，借用整套providers不推断私有选项、不登记或关闭模型。
显式webhookSources保持整表替换，不能授予付费权限。收件提交后仅唤醒原TaskId查询；
API无预算transport的新提交仍关闭，查询不新扣提交槽。原KF-1、轮询、期限与closer保持。
当前SOURCE尚未执行重验证；模型构造零HTTP不代表基础设施零IO，真实云投递、
凭据/地域隐私/E22、收费与容量仍未验；不初始化、恢复或退款预算账本。

## 19. 营业执照官方SDK前置构件（W3-16）

固定`ocr@4.1.322/common@4.1.220`；W3-16实现`BizLicenseOCR`，W4-04前置追加`BankSlipOCR`，签名与可取消请求复用官方SDK公开request。
API显式消费`OCR_TENCENT_FILE`，严格普通JSON文件仅`secretId/secretKey/region`，最多4KiB，
任何环境均拒同名明文。未配保持unconfigured，行业许可证未接；worker银行回单源码已装配，验证和部署另记。
构造零IO，实际请求最多六秒并中止底层；自有modelDrivers登记关闭，借用providers不消费配置。
HTTPS固定官方目标，专用Agent禁止环境代理及跨目标/端口；请求identity且解压前拒绝编码响应，正文上限1MiB。
失败仅静态说明，不输出URL、凭据、原响应或SDK异常。类型unknown及不能解析的期限不补事实，
原类型/期限保留；缺识别字段不会从手填值补成供应商成功结果，不生成置信度。

本片仅SDK/Provider/配置组合根；加密识别短TX、scope缓存、日20次、资质三段式仍属W316业务片。
ROOT官方registry审计0high/critical；common的uuid9.0.1 moderate仅当前未用的v3/v5/v6带buffer API，
SDK实际两处只用v4；无override/豁免。前置构件两协议/环境组、类型/构建/依赖已通过并合本地main。
W316业务片兼容补实际Business/负责人角色及原厂商响应，原始bigint按十进制字符串留证；
业务结果加密与6秒取消仍经原公共接口；受改SDK第1协议组与bigint原文留证定点均通过，
整包四DB、纯核验、新HTTP闭环与原手填回归、类型、API/worker构建、依赖及官方登记核对均通过，
W3-16代码验收完成、识别桩已回补；
真实E17/E19、证照样本准确率、地域隐私/云权限/收费均未验。

## 20. 备份专用流式存储前置（W2-24）

`putBackupStream/headBackup/copyBackup` 均为顶层 Provider 方法，经过原事务外呼守卫。
工厂的 `backup:{bucket,prefix}` 显式绑定目标，调用仅接受
`daily/YYYY-MM-DD.dump.age` 或 `monthly/YYYY-MM-DD.dump.age` 的真实日历日期；
不扩四业务桶枚举、不自动创建备份桶。允许独立物理桶或 secure 的非空专用前缀，
拒绝借用 asset/media/pub。未配直接返回 unconfigured，不读取源、不发网络请求。
COS 可在 backup 中显式给独立 region/key，仍须 worker 角色，API signer 不借权。

上传源 `body(signal)` 只打开一次，无需预知最终长度；调用方必须给 `maxBytes`，
实现上限2GiB、源块上限1MiB、multipart 每块5MiB且顺序等待，不聚合整份备份。
实际流计算 SHA256，完成后用返回 ETag 绑定 HEAD 并核对长度；HEAD 仅报告确实存在的
SHA metadata，不把 ETag 当摘要。COPY 绑定源 ETag，再验目标 ETag/长度。
网络结果不明或 HTTP200 XML Error 均失败；不重发 complete，不据 HEAD 猜成功。
失败先取消源再回收本次 uploadId；清理信号独立、限2秒，不删除可能已提交的对象。
实例 close 拒绝新工作并等待所属操作，源必须响应 signal；无法强制停止任意用户JS。

备份传输总预算30分钟，原媒体流180秒预算不变。COS 保持每请求10秒和回应64KiB上限；
MinIO 使用原显式凭据的单次传输客户端。固定key保留版本化写入语义，不承诺原子防覆盖，
后续任务负责租约及重试决策。腾讯官方说明版本控制下 forbid-overwrite 无效，见
[完成分块上传](https://cloud.tencent.com/document/product/436/7742)及
[条件复制](https://intl.cloud.tencent.com/ko/document/product/436/10881)（2026-10-14核对）。

本片仅存储能力：没有接 pg_dump/age、ENV、定时器或 backup.stale；不证明输入已加密。
替身须显式 `createFakeStorage({backup})` 才启用，保存在独立 backupObjects；
共享 factory/target 校验从 providers 公口复用，未新增分层例外。
备份角色的真实策略必须支持指定前缀上传、HEAD、源条件复制及取消自身分块；
禁止对象删除与解密私钥上机，真实策略、版本保留和恢复演练仍待外部验收。

## 21. 备份任务消费（W2-24）

worker消费严格 `BACKUP_FILE`，把target只交所属storage实例；API不授予该能力。
ops每日任务使用现镜像固定PG17+/age工具，以只读角色导出→公钥加密→单次未知长度
流上传；实际进程退出、HEAD至少最近成功50%及月首条件复制全部成功，原timer才记
四字段成功摘要。取消先终止管道并等待进程真实关闭，存储最后关闭；未知完成不重发。
缺配/失败保留失败事实，不把unconfigured当备份成功；超过26小时由backup.stale监测。
配置、故障与离线恢复步骤见[运维手册](../../../../../docs/plan/runbook.md)第2.4/5.3.1节。
本地现造身份只经内存FIFO解密验证PGDMP，真实云策略及预发完整恢复仍另验。


## W4-04 银行回单识别前置

`recognizeBankReceipt({fileUrl,signal})`固定BankSlipOCR、IsPdf=true、PdfPageNumber=1，不调用BizLicense替代回单。
六字段nullable；只消费官方明确的付款账号、交易金额、币种与日期，未知户名/备注保持null与missing告警。
币种不明、重复冲突、金额非整分或日期缺完整时刻或时区均不猜；无任何可用字段返回unreadable。
API/worker自有OCR驱动均登记同实例modelDrivers关闭，ASR/LLM原角色保持；借用providers不消费配置。
前置唯一独审及三个窄点核0阻断；services/API类型通过，新SDK/解析1、DB1与旧执照协议1合并3/3G。
未执行真实云调用；官方字段依据、首类型RED与云/节点未验边界见W4-04前置变更记录。
