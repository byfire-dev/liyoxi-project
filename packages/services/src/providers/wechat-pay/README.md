# wechat-pay：微信支付的真实驱动

依据：[03](../../../../../docs/03-key-designs.md) 第 1.4 节；[04](../../../../../docs/04-adr.md) ADR-016、ADR-018、ADR-039；[h01](../../../../../docs/api/h01-hooks.md) 第 2.1、3.1、3.2 节；X-04 任务书。结论与交接事项见 [ADR-044](../../../../../docs/adr/0044-微信支付驱动维持自研薄封装-经官方示例与官方SDK核对一致.md)。

本驱动**还没有接进** `providers/index.ts` 的选择分支，也没有任何用例调用它：接入归 G4-A。只用 `node:crypto` 与内置 `fetch`，没有第三方依赖。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `sign.ts` | 三种签名串（请求、应答与回调、小程序调起支付）、RSA-SHA256 签名与验签、`Authorization` 头、时间戳 5 分钟的判定 |
| `keyring.ts` | 验签身份表（公钥 ID 用微信支付公钥，其余用平台证书）；APIv3 密钥环（当前一把加上一把）；`AEAD_AES_256_GCM` 解密 |
| `mapping.ts` | 把微信的应答与通知归一成 `providers/types.ts` 的类型；金额不是整数分即不合规 |
| `notification.ts` | 回调入口 `verifyAndDecrypt`：输入原始字节与请求头，输出判别结果 |
| `client.ts` | 请求客户端：签名、发送、应答验签、超时、错误归一 |
| `config.ts` | 配置类型与成组校验 `resolveWechatPayConfig` |
| `driver.ts` | 工厂 `createWechatPayDriver` 与八个方法；`createWechatPay(settings)` 按设置给出未配置实现或真实驱动 |
| `bill.ts` | 交易账单解析 `parseTradeBill`；“元”到分的定点解析 `yuanToFen` |
| `__fixtures__/` | 向量与支架，见第 4 节 |

## 2. 怎么接（给 G4-A）

```ts
import { createWechatPay } from "./wechat-pay/driver.js";

const wechatPay = createWechatPay(settings, { now, logger, beforeCall });
```

- `now` 是必填的依赖：给内核的时钟。请求与调起支付的时间戳、应答与回调的“相差不超过 5 分钟”都用它，驱动里不取系统时间。

- `settings` 是 `WechatPaySettings`。五项成组：`mchid`、`merchantSerialNo`、`merchantPrivateKeyPem`、`apiV3Key`、`publicKeyId`。五项全缺返回 W0-19 的未配置实现（`configured` 为 `false`）；缺其中任一项抛 `WechatPayConfigError` 并列出缺的字段。五项之外驱动还要 `publicKeyPem`、`appid`、`notifyUrl`。
- 填了但写错的同样抛 `WechatPayConfigError`，报错只有字段名与一句固定的原因，不带任何值，也不带底层（OpenSSL）的原文：私钥、公钥本体（不收私钥与证书）、两把 APIv3 密钥（首尾空白不计，32 个字节，`kid` 不同）、`platformCertificates` 的每一条（`platformCertificates[i]`）、两个回调地址。
- 轮换：
  - APIv3 密钥：新的放 `apiV3Key`（版本 `apiV3KeyId`），旧的放 `previousApiV3Key`。回调先试当前、再试上一把，结果里的 `kid` 是实际解开的那把。
  - 平台证书转公钥：证书放 `platformCertificates`（序列号加证书 PEM）。序列号大小写不计，验签身份表照证书自己的序列号（大写）登记。证书的有效期不查，到期前由配置换下。
  - 换一把微信支付公钥：要两把并存时，另一把也放进 `platformCertificates`（公钥 ID 加公钥 PEM；这个字段名叫平台证书，验签身份表两种都认）。请求头 `Wechatpay-Serial` 里带的公钥 ID 只有 `publicKeyId` 一个；应答与回调各按自己 `Wechatpay-Serial` 写的那一把验。微信支付换公钥的流程、是否允许两把并存，本包查的官方文档里没有写，用到时先向微信支付核对。
- 本目录不读环境变量。变量名、`*_FILE` 的读取、并进 `loadEnv` 都归 G4-A；建议的名字在 ADR-044 第 5 节。
- 驱动的类型是 `WechatPayDriver`，比接口 `WechatPayProvider` 多 `signMiniProgramPay`、`queryRefund`、`applyTradeBill`、`downloadBill`、`verifyNotification`、`reopenResource`。要给领域模块用，先按“只增”提进 `providers/types.ts`。
- 发请求的方法入口自己调一次 `beforeCall`。工厂的 `withBeforeCall` 也会给接口清单里的方法包一层：二选一。
- 回调框架用 `verifyNotification`（判别结果：`signature_invalid` 带 `probe` 标记、`timestamp_skewed`、`key_not_found`、`decrypt_failed`、`payload_invalid`），不要用只分通与不通的 `verifyAndDecryptNotification`：后者归一后的结果不带商户号与 AppID。输入必须是原始请求体字节。
- 回调入口替处理函数拦下的（判 `payload_invalid`）：支付成功通知的 `trade_state` 不是 `SUCCESS`；退款通知的 `refund_status` 与事件类型不是同一个（`REFUND.SUCCESS` 配 `SUCCESS`，余类推）；退款成功而没有 `success_time`；金额不是正的整数分。**没有拦、要处理函数自己核对的**：`resource.mchid`、`resource.appid` 是不是本系统的（h01 第 3.1 节：不属于记 `ignored` 并告警）。
- 重处理用 `reopenResource(resourceCipher, kid)`。收件行里的 `resourceCipher` 到期清除后或存坏了返回 `null`，不抛错。
- 失败结果除 `reason`、`message` 外带微信的错误码 `code`（`WechatPayFailure`）。**错误码没有验过签**：非 2xx 的应答不验签（官方 Go SDK 同此），驱动只放行错误码的写法（大写字母、数字、下划线）。拿它分支时要知道这一点，例如 `fetchTradeBill` 在 `NO_STATEMENT_EXIST` 时返回空文本，对账不要只凭这一个结果认定当日没有交易。
- 查单、退款、退款查询的应答验签之后还核对单号：与请求的不是同一个即丢弃应答，返回 `unavailable`。退款查询的入参只有退款单号，应答里的商户单号由调用方与退款交易所指的收款核对。
- `parseTradeBill` 只把文本解析成行，不核对汇总行与明细之和，也不把“有表头没有汇总行”当错（返回 `summary: null`）：这两样归对账（G4-B）。

## 3. 用例

```sh
pnpm exec vitest run packages/services/src/providers/wechat-pay               # 全部
pnpm exec vitest run packages/services/src/providers/wechat-pay -t property   # 只跑性质测试
LYX_FC_RUNS=5000 LYX_FC_SEED=42 pnpm exec vitest run packages/services/src/providers/wechat-pay -t property
```

性质测试缺省固定种子、每条 200 轮（`__fixtures__/fc.ts`）。失败时 fast-check 会打印种子与最小化后的反例：把反例固化成固定用例再修。

用例里的密钥对、证书、APIv3 密钥都是运行时现场生成的测试值，不入库。

## 4. 向量与跨实现核对

| 文件 | 来源 |
| --- | --- |
| `__fixtures__/official-docs.json` | 微信支付官方文档里给全了输入与输出的示例；每条写明网址与文档更新时间 |
| `__fixtures__/official-sdk.json` | 官方 Go SDK 仓库自带的通知向量 |
| `__fixtures__/cross-check.json` | `pnpm wxpay:vectors` 的产物，不手改 |
| `__fixtures__/crosscheck/` | 在容器里跑的 Go 程序：`main.go`、`go.mod`（钉死官方 SDK 的版本）、`go.sum`（校验值） |
| `__fixtures__/cross-check.generate.ts` | 生成脚本，借 Vitest 来跑 |

`pnpm wxpay:vectors` 做的事：现场生成两对临时 RSA 密钥，用本实现构造签名串并签名；在一次性容器（官方 `golang` 镜像，按摘要钉死）里用官方 Go SDK 对同一批输入签名、验签、解密、解析通知；再从官方文档与官方 Java SDK 仓库现场取它们的示例核对。结果写进 `cross-check.json`，里面没有任何私钥与密钥。

- 要本机 Docker 在运行、能连外网（Docker Hub、`proxy.golang.org`、`pay.weixin.qq.com`、GitHub）。不进 CI；CI 里由 `vectors.test.ts` 拿入库的文件再核一遍。
- 临时私钥只写进系统临时目录里的一个文件（给容器读），跑完即删。`docker` 命令的配置目录指到那个临时目录，不读本机的登录凭据。
- 每次运行密钥都是新的，所以 `cross-check.json` 每次都会整个变。改了签名串的构造、签名、验签、解密的算法，或替身发通知的代码后重跑并提交；只改入参校验、报错与归一的不用重新入库（重跑一遍确认仍然全部一致即可）。
- 文件里“官方 SDK 接受”“与官方 SDK 逐字节相等”这几个布尔值是生成时记下的，CI 核不了（CI 只拿入库的公钥、签名、密文用本实现再验一遍）：要复核就重跑这条命令。
- 生成脚本用到的 `prettier`（给产物排版）是仓库根目录登记的那一份，`packages/services` 没有另外登记。
- 升级官方 SDK：改 `crosscheck/go.mod` 的版本，在容器里跑一次 `go mod tidy` 更新 `go.sum`，再重跑。

入库的向量只有公钥、证书、输入、签名、密文。官方 Java SDK 自带的加密向量没有入库（它的测试密钥形似真密钥，会被密钥扫描拦下），改为现场取回核对。

## 5. 账单样本

`__fixtures__/bill-samples.ts` 是按官方文档 4013071246 的格式自制的，不是真实账单。真实账单的口径由 G4-A、G4-B 在预发复核（V13）。
