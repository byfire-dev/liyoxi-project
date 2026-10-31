# 私有标准 RSA-P12 签署 factory

最初作为 W5-07 前的独立技术交付；当前 Provider、worker 与版次接线见本文末节。
`createPlatformCertSigner`接收注入时钟及`loadMaterial({signal})`；后者只由 worker 装配提供，
返回受控P12字节/口令，未配置返回null。不读文件或环境，不调用CA，不静默返回stamp。

支持含唯一加密RSA私钥、匹配leaf及完整包内X.509链的P12/PFX，RSA至少2048位、指数65537、
SHA-256 detached CMS、`adbe.pkcs7.detached`。检查有效期、数字签名用途、整个certBag匹钥唯一且为leaf、包内签名链及CA路径长度；
路径长度只计下级非自颁发CA，自颁发换钥CA继续沿上级签名验证，不当成自签根；
根自签正确不等于根受到真实CA/阅读器信任。材料端口仍需由E11/运维核实真实授权和根信任。
不承诺SM2、USBKey、不可导出HSM或特定厂商协议，也不声称PAdES-B/T/LT/LTA或可信时间戳。

输入限16MiB，P12限1MiB；拒绝畸形材料、错口令/密钥、无完整链、无效有效期、非RSA、重复签名和占位不足。
每次调用独立复制输入与材料、创建SignPdf/P12Signer；材料的本次Buffer副本结束时覆盖，
不声称能清除JavaScript库内部所有不可变字符串副本。不要在日志/普通DTO输出材料或库异常。

返回最终签后字节、实际leaf的issuer/serial及与PDF/CMS一致、精度为秒的注入签署时间。
此后不能改PDF内容；07组合根对这份最终字节算哈希/上传。图样、条款和QR须在签名前渲染，
本前置的真实renderer/QR样本只标`TEST ONLY`，不是授权书模板或验真页面交付。

`seal`支持调用方signal；`close`幂等、停止准入、abort材料端口并等待真实在途结束。
本地同步密码学计算不能被signal抢占；返回后发现取消则丢弃结果。
忽略signal的材料端口仍会阻止close完成，装配方必须提供能终止的实际驱动，不能靠Promise.race假排空。
本factory不上传、不写库，因此取消后没有后继外部写操作。

测试见`esign.test.ts`与 [testing/esign-material.ts](../../testing/esign-material.ts)（经 testing/index 公口复用）：TEST ONLY的根/leaf/RSA私钥/P12仅运行时生成，
不提交私钥，不读取现有真实密钥，不扩大扫描豁免。故意将根放在P12首位，验证元数据确取匹配leaf。
独立核验器用forge解ASN.1，摘要/RSA/X.509验证用Node内置crypto；覆盖ByteRange全文件、
实际CMS签名/时间、正文篡改、未签尾随、错误材料、并发实例与关闭取消。

定向命令（沿现有services全局setup，需本机测试数据库）：

```sh
APP_ENV=test DATABASE_URL=postgresql://liyoxi:lyx-local-dev@localhost:5442/liyoxi LYX_TEST_SESSION=w507sign pnpm exec vitest run --project services packages/services/src/providers/esign/esign.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @liyoxi/services typecheck
```

依赖版本/年龄例外/许可见[02选型](../../../../../docs/02-tech-selection.md#56-w5-07-签署独立前置准入2026-10-30)。
真实机构身份、法务、阅读器、微信真机与签后V12均未验，不以测试根代替。


## W5-07 Provider 与 worker 装配

`provider.ts` 的 `createPlatformCertEsign(options)` 将上述 factory 适配到公共 `EsignProvider`，返回 `{ provider, close }`。`seal({ pdf, signal? })` 的成功值按 `mode` 区分：`certificate` 必带 `driver: "platform_cert"`、实际 `certIssuer`、`certSerial`、`signedAt`；`stamp` 只有文件字节与模式，不能附伪造证书证据。普通外部能力替身诚实返回 stamp；真实密码学用例和 M1 技术出件使用运行时生成的 TEST ONLY 证书。

`ops/docs-render-runtime.ts` 的 `createLicenseRenderingEngine` 仅由 worker 组合调用：按配置创建 renderer、`createSsmMaterialSource` 和 certificate Provider。API 只获得四项配置的描述，不构造材料源、不开临时身份文件、不加载证书私钥。`RuntimeOptions.licenseRendering` / `WorkerServicesOptions.licenseRendering` 的完整 engine 注入只允许 local/test 的 worker；API 注入会被拒绝，stg/prod 也不接受此测试覆盖。生产默认不会从通用图片章 Provider 降级。正文、字体或签署能力未配置时不认领版次，保留 queued 并给出受控告警。

### SSM 与临时身份端口

`ssm-material.ts` 的 `createSsmMaterialSource(config, { clock })` 返回 `loadMaterial({ signal })` 与幂等 `close()`，构造时没有文件或网络 I/O。四项 `ESIGN_SSM_REGION`、`ESIGN_SSM_SECRET_NAME`、`ESIGN_SSM_VERSION_ID`、`ESIGN_SSM_STS_CREDENTIALS_FILE` 必须全配或全空；`loadEnv` 只验证描述与绝对规范路径，不急切读取文件。字体目录另由 `LYX_PDF_FONT_DIR` 提供。生产装配用真实系统时钟判断 STS 到期，签署时间仍用注入业务时钟。

每次 GetSecretValue 前重新打开同一固定路径，读取严格四字段 `{ TmpSecretId, TmpSecretKey, Token, ExpiredTime }` JSON。`ExpiredTime` 为 Unix 秒安全整数，读完及发请求前必须仍有超过 30 秒余量。文件最多 16KiB，须普通文件、0400 或 0600、owner 为 root 或 worker 有效 UID；以 NOFOLLOW/NONBLOCK 打开，拒绝软链接、错误 UTF8、额外字段、空 Token 或过期身份。没有凭据缓存、旧凭据兜底、长期 AK 或 metadata 默认发现；每次读取完成都关闭真实 fd。

外部刷新方须在到期前写好完整 JSON 后同目录原子 rename，worker 只读挂载；父目录可信且 API 无法读取该文件，需要独立挂载/UID或工作负载身份与最小 CAM 权限来保证。这些是部署前提，代码中的 worker 分支不等于已经证明 API 在操作系统或云权限层不能读取。NOFOLLOW 不兼容直接使用软链接轮换的 Secret 卷，部署不能静默取消该校验。

SSM 仅使用 `ssm.tencentcloudapi.com:443`、POST `/`、`GetSecretValue`、API `2019-09-23`、TC3-HMAC-SHA256 和显式临时 Token；endpoint、action、API 版本均不可配置。secret 名与自定义版本固定，拒绝移动别名，响应 name/version 必须一致。仅接受单一 `SecretString` 中严格 `{ schemaVersion: 1, p12Base64, passphrase }`，UTF8 JSON 上限 32768 字节、规范 base64、非空口令；非空 SecretBinary、重定向、压缩或超过 256KiB 的响应流受控拒绝。SSM payload 限额意味着实际 P12 可用空间小于 24KiB，不能把 signer 的 1MiB 材料上限当作本路线容量。

只有材料留在请求内存；不以明文 P12 文件作为生产默认。SSM 的 KMS 加密方式、精确单 secret 的只读 CAM 资源、worker 专用身份和 API 隔离、外部刷新责任与 E11 包大小/可导出性仍需真实部署验收。固定 version 是应用约束，不能声称 CAM 已实现版本级权限。若 CA 要求不可导出 HSM 私钥，当前内存 P12 路线不适用。

### 生命周期与验证边界

每个 source 有独立 pending/controller/Agent。六秒预算覆盖身份读取和 HTTP，请求超时与取消传给真实 SDK HTTP；普通文件 I/O 无法保证被 signal 即时抢占，因此读取后检查取消并等待其实际结束，不能用 Promise.race 留下请求。`close` 先拒新、abort 请求、等待实际 pending，再销毁 Agent。docs 组合根先停止认领并等待渲染/存储/条件提交，再关 engine；同步密码学运算返回后复查取消，迟到结果不发布。

定向测试在 Node 24、显式本地测试 DB/Redis 配置下运行；示例中的连接身份只属于本地测试设施：

```sh
APP_ENV=test DATABASE_URL=postgresql://liyoxi:lyx-local-dev@localhost:5442/liyoxi REDIS_URL=redis://localhost:6389/0 LYX_TEST_SESSION=w507ssm pnpm exec vitest run --project services packages/services/src/providers/esign/ssm-material.test.ts packages/services/src/kernel/env.esign.test.ts --maxWorkers=1 --no-file-parallelism
```

SSM 用例只把真实 SDK 请求送到测试自有 loopback，读回固定协议/TC3/Token、原子刷新、权限/UTF8/schema/容量/到期边界、真实 socket 取消/超时/关闭，以及由返回材料完成的实际 PDF 签名字节。未访问真实云账号、证书或 CA。上述测试不关闭 E8 法务正文、E11 机构证书/授权方式或签后 V12；受信阅读器、微信真机和真实 IAM/KMS/挂载隔离仍待外验。
