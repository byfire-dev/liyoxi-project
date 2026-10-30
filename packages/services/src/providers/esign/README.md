# 私有标准 RSA-P12 签署 factory

W5-07前的独立技术交付，尚未接全局`EsignProvider`、worker、docs版次或生产配置。
`createPlatformCertSigner`接收注入时钟及`loadMaterial({signal})`；后者只由未来worker装配提供，
返回受控P12字节/口令，未配置返回null。不读文件或环境，不调用CA，不静默返回stamp。

支持含唯一加密RSA私钥、匹配leaf及完整包内X.509链的P12/PFX，RSA至少2048位、指数65537、
SHA-256 detached CMS、`adbe.pkcs7.detached`。检查有效期、数字签名用途、整个certBag匹钥唯一且为leaf、包内签名链及CA路径长度；
路径长度只计下级非自颁发CA，自颁发换钥CA继续沿上级签名验证，不当成自签根；
根自签正确不等于根受到真实CA/阅读器信任。材料端口将来仍需由E11/运维核实真实授权和根信任。
不承诺SM2、USBKey、不可导出HSM或特定厂商协议，也不声称PAdES-B/T/LT/LTA或可信时间戳。

输入限16MiB，P12限1MiB；拒绝畸形材料、错口令/密钥、无完整链、无效有效期、非RSA、重复签名和占位不足。
每次调用独立复制输入与材料、创建SignPdf/P12Signer；材料的本次Buffer副本结束时覆盖，
不声称能清除JavaScript库内部所有不可变字符串副本。不要在日志/普通DTO输出材料或库异常。

返回最终签后字节、实际leaf的issuer/serial及与PDF/CMS一致、精度为秒的注入签署时间。
此后不能改PDF内容；07应对这份最终字节算哈希/上传。图样、条款和QR须在签名前渲染，
本前置的真实renderer/QR样本只标`TEST ONLY`，不是授权书模板或验真页面交付。

`seal`支持调用方signal；`close`幂等、停止准入、abort材料端口并等待真实在途结束。
本地同步密码学计算不能被signal抢占；返回后发现取消则丢弃结果。
忽略signal的材料端口仍会阻止close完成，装配方必须提供能终止的实际驱动，不能靠Promise.race假排空。
本factory不上传、不写库，因此取消后没有后继外部写操作。

测试见`esign.test.ts`与`__fixtures__/test-material.ts`：TEST ONLY的根/leaf/RSA私钥/P12仅运行时生成，
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
