# wechat-pay：微信支付的真实驱动

依据：[03](../../../../../docs/03-key-designs.md) 第 1.4 节；[04](../../../../../docs/04-adr.md) ADR-016、ADR-018、ADR-039；[h01](../../../../../docs/api/h01-hooks.md) 第 2.1、3.1、3.2 节；X-04 任务书。结论与交接事项见 `docs/adr/` 下 X-04 的那一条。

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

const wechatPay = createWechatPay(settings, { logger, beforeCall });
```

- `settings` 是 `WechatPaySettings`。五项成组：`mchid`、`merchantSerialNo`、`merchantPrivateKeyPem`、`apiV3Key`、`publicKeyId`。五项全缺返回 W0-19 的未配置实现（`configured` 为 `false`）；缺其中任一项抛 `WechatPayConfigError` 并列出缺的字段。五项之外驱动还要 `publicKeyPem`、`appid`、`notifyUrl`。
- 本目录不读环境变量。变量名、`*_FILE` 的读取、并进 `loadEnv` 都归 G4-A；建议的名字在 ADR 第 5 节。
- 驱动的类型是 `WechatPayDriver`，比接口 `WechatPayProvider` 多 `signMiniProgramPay`、`queryRefund`、`applyTradeBill`、`downloadBill`、`verifyNotification`、`reopenResource`。要给领域模块用，先按“只增”提进 `providers/types.ts`。
- 发请求的方法入口自己调一次 `beforeCall`。工厂的 `withBeforeCall` 也会给接口清单里的方法包一层：二选一。
- 回调框架用 `verifyNotification`（判别结果：`signature_invalid` 带 `probe` 标记、`timestamp_skewed`、`key_not_found`、`decrypt_failed`、`payload_invalid`），不要用只分通与不通的 `verifyAndDecryptNotification`。输入必须是原始请求体字节。
- 失败结果除 `reason`、`message` 外带微信的错误码 `code`（`WechatPayFailure`）。

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
- 每次运行密钥都是新的，所以 `cross-check.json` 每次都会整个变。改了签名、验签、解密或替身发通知的代码后重跑并提交。
- 升级官方 SDK：改 `crosscheck/go.mod` 的版本，在容器里跑一次 `go mod tidy` 更新 `go.sum`，再重跑。

入库的向量只有公钥、证书、输入、签名、密文。官方 Java SDK 自带的加密向量没有入库（它的测试密钥形似真密钥，会被密钥扫描拦下），改为现场取回核对。

## 5. 账单样本

`__fixtures__/bill-samples.ts` 是按官方文档 4013071246 的格式自制的，不是真实账单。真实账单的口径由 G4-A、G4-B 在预发复核（V13）。
