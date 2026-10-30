# W5-07：签署依赖与标准证书驱动独立前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 在W5-07业务前独立准入精确渲染/签署/二维码依赖，并以公开测试材料实现、核验标准RSA-P12签字节factory；不新增工作包编号或改变M5计数 |
| 原因 | 07任务允许renderer/react，其他签署库要求独立前置；未配置的stamp不能证明数字签名，先补真实密码学能力及其安全依赖 |
| 影响的包 | W5-07；本前置不消费尚未合入的06事实核心，07业务仍等待其全部actual前提；E8/E11/V12保留未验 |
| 类别 | 顺序、默认 |
| PR | [#219](https://github.com/byfire-dev/liyoxi-project/pull/219)（独立前置；唯一独审两项P2已修，当前CI与实际合入以发布页为准） |

## 1. 开工与范围

ROOT于2026-10-30核准本独立前置，评审甲，固定源码一轮独审。基线为实际main `64ef9f85f72462f538d043997c6e1fd56fbc962e`；[PR216](https://github.com/byfire-dev/liyoxi-project/pull/216)已交node-forge1.4.2单版本限时安全例外并19项CI通过。常规10080分钟、可信级别、脚本、审计与原必过检查保持。

允许修改：`packages/services/package.json`、正规生成的`pnpm-lock.yaml`、`docs/02-tech-selection.md`及本文；`packages/services/src/providers/esign/`下私有标准签署factory、同域测试与TEST ONLY夹具说明。新增包严格为renderer4.9.0、react19.3.0、signpdf/placeholder-pdf-lib/signer-p12各3.4.0、pdf-lib1.17.1、node-forge1.4.2、qrcode1.5.4；开发类型为@types/react19.3.0、@types/node-forge1.3.14、@types/qrcode1.5.6。不得偷引传递包；确需额外直接包先交ROOT核准。

不改Provider全局协议、ops/worker/kernel、业务版次/队列/8API/DB/冻结metadata或字体来源，不安装真实证书、不访问CA。原07任务第6节要求的独立准入由本片落实；它不表示07业务已开工或完成。

## 2. 实现与验真

- 仅承诺RSA私钥、PKCS#12/PFX、X.509链、SHA-256 detached CMS/PKCS#7。factory接收PDF字节、注入的签署时钟与可取消的材料端口；从本次实际leaf提取issuer/serial，检查材料匹配及有效期；未配置、畸形、过期、非RSA、取消、占位不足均受控失败，不静默降成stamp。
- 真实PDF加占位后签字节；签后不再改内容，返回实际最终PDF和签署事实，不把CMS signingTime冒作可信时间戳或特定PAdES等级。
- 测试材料仅运行时生成、明确TEST ONLY，不提交私钥、不读现有真实密钥、不扩大密钥扫描豁免。用Node内置crypto/X509或已核受控验证器独立核验ByteRange、实际签名/证书与时间；正文篡改、未签尾随内容、错材料及生命周期反例必须有真实结果。默认不新增生产OpenSSL CLI依赖。
- 每实例独立、关闭拒新并等待真实在途；同步签署不能靠AbortSignal假称可中断，取消后丢弃结果且不继续外部写。标准factory待07正式装配，不提前伪造生产ready或真实机构身份。

## 3. 验证与收尾

安装前复用本轮npmjs/npmmirror精确版本、发布时间与integrity双源一致记录；锁文件只由正常pnpm生成。只允许已合单版本年龄例外，出现新可信降级/不成熟包/既有版本暗升时先定位，不新增豁免或手改锁。

单路重型槽执行冻结安装、生产高危审计、新增依赖年龄、实际签名定向测试及services类型；必要产物检查与正式CI保留，不反复跑无关全仓。未执行项如实保留，不把测试根密码学正确称为E11证书、法务、阅读器或签后V12通过。

完成后由ROOT串行发布、唯一独审无阻断及当前main同步CI全绿才合并；本地main只快进远端。禁止作者Git写、网络账号操作或自行部署。


## 4. 本片实际交付与验证

- 已按上述11包精确准入；双源元数据的version/publish/integrity/许可/engines/peer一致，正常pnpm生成新增75个锁版本，原有packages条目与完整性无删除/改写。`@signpdf/utils@3.4.0`只由签署库内部传递，本源码不直接引。没有新增可信或年龄例外。
- 私有factory在`providers/esign/platform-cert.ts`，材料核验在同域`material.ts`。P12要求唯一加密RSA私钥、匹配leaf及完整包内链；最少RSA2048/指数65537。包内链核验不证明真实根信任。签署时间以秒对齐并与实际PDF/CMS一致，保留最终字节。`seal/close`每实例独立，关闭拒新/取消并等待真实pending；同步签名结束后的取消会丢弃结果。
- 测试仅运行时生成TEST ONLY材料，以真实react-pdf/QR PDF经PDF-lib占位、P12Signer实际签署；用Node crypto核CMS的摘要、RSA签名、X.509链/issuer/serial/时间、ByteRange全覆盖，真实正文与签名篡改、未签尾随、错误材料、有效期、占位不足、并发与关闭均覆盖。无静态私钥、生产凭据或扫描豁免。
- 安装采用`pnpm install --ignore-scripts --frozen-lockfile=false`生成锁，随后`pnpm install --ignore-scripts --frozen-lockfile`通过；`--ignore-scripts`避免安装时root prepare写Git配置，不涉及提交钩子，作者未作Git写操作。正常CI仍按原脚本/白名单执行。
- `pnpm audit --prod --audit-level high --registry https://registry.npmjs.org/`通过（0 high/critical，4 low/9 moderate保留）；`node infra/ci/check-release-age.mjs --since 64ef9f85 --registry https://registry.npmjs.org/`通过（74成熟+唯一forge1.4.2已合例外）。
- 定向密码学目标：`APP_ENV=test DATABASE_URL=postgresql://liyoxi:lyx-local-dev@localhost:5442/liyoxi LYX_TEST_SESSION=w507sign pnpm exec vitest run --project services packages/services/src/providers/esign/esign.test.ts --maxWorkers=1 --no-file-parallelism`。沿原services setup，不改测试预算；首次会话标识含下划线被守卫拒绝，改为合法独立标识后17/17通过；补CMS issuer与leaf绑定断言后同一目标再次17/17通过。`pnpm --filter @liyoxi/services typecheck`、本域定向ESLint与所改文件Prettier检查通过。

未交全局Provider、worker/ops、KMS或真实CA装配，未开始06/07业务；未跑无关全仓、部署、阅读器或微信真机。E8/E11/V12仍待外部结论。固定源码唯一独审及实际main同步CI由ROOT后续完成，本片不代写已经通过。


## 5. 唯一独审修复

对固定提交`a2f1899217bafe6c8cc950018c1a0bdd15fe74c5`的唯一独审提出两条P2，均在原scope内修复，ROOT据修复与CI验收，不派第二轮：

1. 包内路径检查各CA的`basicConstraints.pathLenConstraint`，只计其下级非自颁发CA；leaf不计。自颁发换钥CA仍沿上级公钥验证，只有自签CA作为包内技术锚，不冒外部根信任，继续使用注入时钟。
2. 对整个certBag匹私钥的证书要求恰好一个且为leaf，拒绝额外匹钥CA，避免P12Signer最后匹配证书与返回issuer/serial不一致。

真实TEST ONLY材料先在原实现跑4个定向反例/边界：违规A(pathLen0)→B链与额外匹钥CA错误成功、自颁发换钥正例被错误拒绝，共3失败/1通过，确认回归能发现原缺陷。修复后受影响实际密码学目标21/21通过（3.71秒）；新增A(pathLen1)与自颁发B/pathLen0正例均产出独立可核CMS。该组证书有效期固定2035年，签署时钟亦注入2035年，不以实际Date.now替代有效期判断。所有材料仅runtime生成，拒绝结果只含受控信息。

本次未重装、重审计/年龄、跑全仓或增依赖/协议/范围；services类型、叶ESLint及本域格式检查通过；实际main同步CI由ROOT接续。
