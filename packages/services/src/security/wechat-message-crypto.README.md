# 微信消息安全回调纯协议叶（W2-21）

`wechat-message-crypto.ts` 是本模块私有 helper。它只处理 GET 校验、JSON 安全模式 POST
与 JSON 回复加密；尚未挂载 HTTP、注册 webhook source、接图片/通知回执业务或回补三桩。
不经公共 `index.ts` 转导。W2-21 仍为一个工作包一个 PR，本叶完成不是整包完成。

## 公口

`createWechatMessageCrypto({token, encodingAESKey, appid, randomBytes?})` 返回：

- `verifyGet({query, now})`：成功值为原文 `echostr`。
- `decryptPost({query, rawBody, now})`：成功值为解密后的 JSON 对象。
- `decryptPostDetailed({query, rawBody, now})`：成功值为 `{message, plaintextDigest}`。
- `encryptReply({plaintext, nonce, now})`：成功值为四字段 JSON 加密回复信封。

`plaintextDigest` 是通过全部签名/AES/UTF-8/深度检查后，对二进制 frame 中实际消息 Buffer
计算的 SHA256（64 位小写 hex），供 h01 eventId 原始字节规则使用。它不包含随机前缀、长度、
appid 或 padding，也不能对解析对象重新 JSON.stringify 后计算；空格、键序和 UTF-8 原始字节
均参与摘要。旧 `decryptPost` 复用同一单次解密流水线，仅返回 `message`，四种失败结果保持原样。
详细接口不返回原文字符串，不记录/持久化消息或摘要；具体事件去重归未来适配器。

结果为 `{ok:true,value}` 或 `{ok:false,error}`，error 只取既有四个 `WEBHOOK_*` 符号。
配置非法立即抛固定 `TypeError("微信消息加密配置非法")`，不带配置值；完整配置由未来装配根注入。
本文件不读环境或文件。未配/半配的环境选择由 W2-21 后续装配实现。

`now` 是调用方注入的有效非负 Date。回复随机源缺省为 `node:crypto.randomBytes`；测试可注入
返回严格 16 字节的函数，不接受异步或错长度返回。没有网络、DB、定时器、listener 或关闭生命周期。

## 协议与严格边界

GET 使用 token/timestamp/nonce 排序 SHA1，验签后检查正负 300 秒（含边界）再原样返回 echo。
POST 仅接受 `encrypt_type=aes`，保留普通 signature 参数，但只用 msg_signature 核验密文。
SHA1 字段严格 40 hex，以 20 字节常数时间比较；不修剪或重编码参与签名的字符串。

EncodingAESKey 规范 base64 解码为 32 字节；IV 取 key 前 16 字节。AES-256-CBC 关闭自动填充，
手工检查 32 字节 PKCS7 的全部尾字节，含整块时补 32。二进制格式按 16 字节随机前缀、
4 字节大端明文长度、UTF-8 消息、appid 拆包。长度不可越界，appid 必须精确相等。
回复用 UTF-8 字节数打包，返回 `Encrypt`、`MsgSignature`、数字 `TimeStamp`、字符串 `Nonce`。
纯 `success` ACK、客服明文构造与业务事件投影由未来适配器决定。

以下为私有实施防御值，**不是微信平台声明的最大值，也不是 HTTP 流读取限量**：

| 输入 | 限量 |
| --- | --- |
| 原文 JSON body | 128 KiB，先检查传入 Uint8Array 字节数 |
| 明文与回复 JSON | 64 KiB UTF-8，根须对象 |
| JSON 容器深度 | 32；用迭代遍历避免递归栈溢出 |
| nonce | 1–256 个可见 ASCII 字符 |
| echostr | 4 KiB UTF-8，保留原文，不接受孤立代理字符 |
| token、appid、ToUserName | 1–128 个可见 ASCII 字符 |

密文是规范标准 base64、decoded 非空且为 32 字节倍数，解码前也限制编码长度。
key 必须为规范 43 字符编码。所有字段只认真实 own-property，继承的 constructor 等不补缺失字段。
不接受丢失的安全模式参数、溢出/非十进制整秒时间戳、坏 UTF-8 或非对象 JSON。

## 失败与后续适配移交

| 私有结果 | 含义 / h01 后续映射 |
| --- | --- |
| WEBHOOK_PAYLOAD_INVALID | 输入形式/容量/JSON不符，400 |
| WEBHOOK_SIGNATURE_INVALID | 错签名或错appid，401 |
| WEBHOOK_TIMESTAMP_SKEWED | 正负300秒以外，401 |
| WEBHOOK_DECRYPT_FAILED | 已验签密文无法解包/填充，500；也作为本 helper 回复内部 crypto 失败的受控结果 |

合法但错误的 key 与对方错误密文不能仅凭 padding 失败准确区分；遵循 h01 的已验签解密失败语义，
不把它归作可忽略业务输入。回复内部随机源/crypto 失败共用 DECRYPT_FAILED 是已获调度批准的
**私有 helper 约定**，未来 adapter 必须沿 h01 固定 HTTP 映射，不新增错误枚举/业务响应协议。

成功解密对象仍可能含平台 openid；它只供当次适配处理，**没有声称已脱敏**。未来 W2-21 适配器
必须查实际 wechat_identity，再投影成正式 payload；不把完整明文对象直接作为 webhook_event.payload。
本叶无日志口、不保留/记录原文，不透传底层异常或密钥。provider TX 外呼守卫保持在原 Provider 边界。

## 官方来源与本地验证

读取日期为 2026-10-08 UTC，仅使用官方 primary 来源：

- [小程序消息推送主文档](https://developers.weixin.qq.com/miniprogram/dev/framework/server-ability/message-push.html)：
  SHA256 `dbcda536fa543055b0c810198559b3b3cbf44941a624dd8acbe89ba65eb0828f`。
- 官方主文档实际链接的[加解密示例包](https://wximg.gtimg.com/shake_tv/mpwiki/cryptoDemo.zip)：
  4,663,403 字节，SHA256 `eaddccb2d2daabe9ea37cd0b54ebc0ea45724c26ac26984e16662afa39571b8c`。
  只读核 Java CBC、IV 与自定义填充，没有执行官方 Java/Python SDK。

测试固定官方 GET、JSON POST 与回复的独立期望，不能用生产生成结果更新期望。
官方例为公开假配置，时钟注入示例时间；不用真实当前时间绕开过期规则。
另用测试侧独立打包/原生 crypto 构造坏 padding、长度、appid、UTF-8 与大小边界。
没有真平台配置、真实地址设置、消息发送或 HTTP 入口验收。

沿用原项目，显式本机虚构配置与自己的 LYX_TEST_SESSION，运行：

```sh
pnpm exec vitest run --project services packages/services/src/security/wechat-message-crypto.test.ts
pnpm --filter @liyoxi/services typecheck
pnpm exec eslint packages/services/src/security/wechat-message-crypto.ts packages/services/src/security/wechat-message-crypto.test.ts
pnpm exec prettier --check packages/services/src/security/wechat-message-crypto.ts packages/services/src/security/wechat-message-crypto.test.ts
pnpm depcheck
```

services 原 globalSetup 会准备隔离模板库，须现有本机 PG 与 fake 开发连接参数；不改原 runner。
测试通过仍只证明本叶，HTTP 流读取、W201收件/重放、业务回执与三桩需要整包继续验证。
