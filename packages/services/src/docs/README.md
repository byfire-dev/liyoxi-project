# docs：协议与同意

协议的“当前版本”、协议清单与版本正文的读、同意记录的写入、待同意与指纹、已签署协议（W1-03）。依据：[m01](../../../../docs/api/m01-account.md) 第 2.5、2.7、2.9–2.11、3.12–3.16 节；[13 分组](../../../../docs/data-model/13-notify-docs.md) 第 2.10–2.12、5.2、5.4 节。W2-12 PR2 增加八条后台接口及本域两项任务，本轮本地代码验收完成，待唯一独审与调度本地合流；授权书的渲染与保留分支随 M5。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `service.ts` | `createDocs({ tx, clock, signPdf })`：装配入口；读取PDF需真实签名端口 |
| `versions.ts` | 当前版本的唯一解析口径 |
| `read.ts` | 协议清单、版本正文（两条公开接口的取数） |
| `consents.ts` | `assertConsents`：同意记录的唯一写入口 |
| `pending.ts` | 待同意的计算、两个指纹 |
| `signed.ts` | 已签署协议：老板、店员两种形状，计数 |
| `invariants.ts`、`transaction-invariant.ts`、`register.ts` | `docs.N4`、`docs.N13` 与 `docs.N5` 的查询及登记 |
| `seed.ts` | 六份协议的清单（W0-21，`pnpm db:seed`） |
| `demo-seed.ts` | 六份占位版本（演示种子；只进本地与预发） |
| `admin-context.ts`、`admin-read.ts`、`admin-write.ts` | 后台八接口：模块权限、脱敏查询、草稿与安排/撤回生命周期 |
| `ports.ts` | 本域文件权限、引用、正文准备和私有现签的纯依赖类型 |
| `jobs.ts`、`consent-digest.ts` | 到点簿记与前一北京时间自然日的只增证据摘要 |

## 2. 怎么用

```ts
const docs = runtime.docs; // api、worker 各自组合根已注入真实文件签名端口

await docs.listAgreements({ scene: "plan_purchase", limit: 20 }); // 用例函数：自己开事务
await docs.getAgreementVersion(agreementVersionId); // 草稿、已撤回、不存在都是 NOT_FOUND

// 别的域在自己的事务里
const current = await docs.currentVersions(tx); // 协议键 → 当前版本；报价、付款单要给端上版本 id 就取它
const result = await docs.assertConsents(tx, ctx, {
  scene: "order_submit",
  consents: [{ agreementVersionId }], // 交易接口只有版本 id，协议键由版本行补
  signer, // 手机号密文与脱敏串、称呼脱敏串、角色、appid 与 openid 的 HMAC：调用方带入
  entity: { entityId, entityName, usccEnc, usccMask, storeId },
  biz: { type: "drama_order", id: dramaOrderId, no: orderNo },
});
// result.consents[n].agreementConsentId 写进单据；result.complete、result.stamp 给 identity 写 consent_stamp
```

- **当前版本** = 同一协议在 `pending`、`active` 中 `effective_at <= now` 的最新一条，不看簿记列 `status`。全仓只有 `versions.ts` 这一处，别处一律调 `docs.currentVersions`，不要自己按 `status = 'active'` 取。
- **`assertConsents`**：每份协议一行，命中唯一索引返回已有记录（同一账号同一版本、同一单据只一条）。协议键与版本不一致、用户级场景里混进别的协议回 `VALIDATION_FAILED`；不是此刻的当前版本回 `AGREEMENT_VERSION_STALE`，`details` 带当前版本 id（交易接口只交版本 id，交成别的协议的版本也按过期处理）。`login`、`reconsent`、`member_join` 只收用户级协议、不带主体与单据；四个交易场景必带主体快照与单据（组合不对抛 `TypeError`，是调用方的代码缺陷）。同意方式不给即取协议清单上的（勾选或付款即同意）；`prior_consent` 由广告需求显式给。
- docs 不读身份表与主体表，也不写 `merchant_user.consent_stamp`：快照由调用方带入，指纹由 identity 写。
- **待同意**现算、只读：对每份用户级协议，本人有当前版本的同意记录即已同意；当前版本关了“需重新同意”且本人同意过更早的版本也算。
- **指纹**两个：`consentStamps(db).user`（用户级协议当前版本集合，协议同意中间件用）、`.all`（全部协议，引导数据用）。
- **已签署协议**一行一份协议。函数按观察者角色返回两种形状（店员的记录里没有 `bizType`、`bizNo`、`bizTitle`）；接口层最后一道裁剪在 W1-04。

## 3. 跑用例

```sh
pnpm --filter @liyoxi/services exec vitest run src/docs/
```

连真库，走带种子的测试库：要本地的 PostgreSQL 与 `DATABASE_URL`（`CLAUDE.md` 第 9 节）。

## 4. 已知的限度

- 版本正文通过注入的纯文件端口在事务外现签，并在签名前后读取真实可见性；未配置签名能力或文件不可用时受控失败，不返回空地址。新服务/API核心验收与原文书、种子、PII、不变量、公开API、权限矩阵和worker目标回归、最终类型/门禁及两应用构建已通过；不把代码验收当作真实法律正文已交。
- 已签署协议里的 `bizTitle` 恒为 `null`：付款单的标题要经 billing 取，随 G4-C（留桩）。
- `docs.N5` 已随 W2-17 PR3 接入：`billingConsentFacts`、`orderConsentFacts`、`adConsentFacts` 经既有 keyed 通知事实端口返回单据/签署人/时刻/协议键。docs 仅读自身版本与只增同意表；缺登记报受控检查错误，不能反向查询三张上层表。默认 API/worker 用本运行时 Assembly 的 full 不变量闭包，污染可以真实报告，其他未配置发送通道不令 N5 恒真。
- `docs.N4` 的哈希一项只比“版本行的内容哈希”与“文件登记行上的哈希”，文件行没有哈希的不比；不读对象存储里的文件本身。
- API/worker 的 scoped 组合保留原 N5 闭包；N4/N13 应使用本次不变量运行的业务时刻，静态登记仅作为未装配时的原查询入口。
- 取不到来源 IP、请求号的同意记录写 `unknown`，不拦业务。

## 5. W2-12 PR2 的实现边界

后台四项写操作保留 required 幂等与原权限元数据。事务外prepare的失败只交给新执行的keyed回调，成功同键返回原DTO；update的当前状态/lockVersion守卫仍在原锁内执行，同键异载荷沿内核冲突规则。八条后台响应统一no-store。草稿以协议自然键串行，再锁版本与已排序文件行；正文 prepare 先取得真实 converter 容量才有界读 source/PDF，写事务重新验证当前归属、分类、状态、ETag、大小、哈希。转换成功不替代这次授权。`agreement_version` 是技术簿记，不新增 flow 或状态历史；安排与撤回通过现有 notices 公口在同一事务记录公告及原出站事件，提交后发出 agreement/site 缓存失效信号。法律可见性仍每次实时查库。

`ops/docs-files.ts` 是 L4 文件桥，只消费 media 的公开口；不增加 docs→media 白名单。私有签名不落幂等结果或数据库，商家正文响应为 no-store。默认双文件用于安排生效；PDF-only 可保存草稿并对有界完整字节求真实 SHA，Word/PDF 文本不一致只返回真实警告。正式法务文本和审批不会由转换自动补齐。

`docs.sweep` 每五分钟仅补 pending→active 与原 active→superseded、人数快照及审计；读路径到点即按唯一 currentVersions 解析。M5 授权书 queued 重投/渲染租约分支不在本包实现。摘要按前一北京时间自然日、seq 顺序、所有列求 SHA-256，secure 桶仅保存固定元数据且用 ifAbsent/内容身份防覆盖；次日重算。摘要不一致调用 evidence.consent_digest_mismatch（P1），对象不可读/写等能力故障调用 evidence.consent_digest_unavailable（P2），并使本次任务真实失败。告警事实落库沿已actual main的独立W224前置；实际API默认Assembly任务已验证P1-only摘要不一致与P2不可读取的真实alert_event行。调用替身仍只证明端口调用，不替代该组合根证据。

两项 job 与不变量索引使用当前 API/worker Assembly 副本，关闭只取消和等待本实例已接受的任务；不设置全局最后绑定。测试支撑 docs-admin.ts 只布置虚构员工/合法 stored 输入/草稿事实。正文验收实际构建并启动 PR1 converter 产物；已有转换字段的 lifecycle fixture 只证明业务状态与引用，不冒充真实处理、云对象存储或法务验收。

## 6. W5-06 当前授权事实

`reconcileLetters(tx, deps, itemIds, triggerRef)` 与 `ensureLetters` 是同一批次 writer。L4 `createRuntimeDocsLicense` 经 delivery 的纯注入桥组合 order/publish/content/tenant 所属 reader，docs 只读自己的同意、信件和版次表。先按全批次取得父单160、订单项170，再锁全批次既有信件240；同一事务不能先对齐一项、取得更高锁后再追加新项。调用方须在计费账户等后续锁之前完成必要预锁与对齐，不能在资金锁内补新信件锁。

API 内部公口为 `runtime.licenseLetters.reconcileLetters/ensureLetters(tx, itemIds, triggerRef)`。`complete` 仅表示当前法律事实已对齐，**不表示 PDF ready、广告可启动或可交付**；实际就绪守卫由 W5-08 结合 W5-07 的真实 ready 版次接入。本包不接 packagePush/reevaluate 的未来守卫。

唯一既有订阅者 `docs.onLicenseFacts` 消费12类开工、订单项、工单与确认信号；事件只提供目标，事务内回读当前阶段与实际选定账号。制作中、待上线、已上线、正常结束保留应有信件；移出账号和取消/退款/终止作废，重选建新信/编号/验真码，旧信不复活。自动换版只比较 status、periodStart、periodEnd；同法律事实重放零写。建信、版次 queued、审计/状态历史和正式事件在同一事务提交。

每个 queued 版次固定真实法定主体、门店、剧目许可/地域、账号、历史交易同意及验真地址。可选非secret `PORTAL_PUBLIC_ORIGIN` 只接受 HTTPS DNS 根地址，API/worker 缺配仍可启动，只有创建新版快照受控失败；作废旧信不需要该配置或新快照资料。它不表示验真页面已交付。USCC 明文仅存在内部法定快照，不回显到普通错误或日志。

07 应直接复用 `LicenseLetterSnapshotSchema/parseLicenseLetterSnapshot`、`canonicalLicenseJson`、`licenseContentFingerprint` 与 `LICENSE_TEMPLATE_VERSION`，不以 Prisma Json 当作已验证快照。规范 JSON 按 UTF16 码元排序键、无空白、UTF8 字节 SHA-256，数组顺序保留；版本正文条款键固定于 v1。当前 ready 指针、渲染/签名/下载及 issued 事件仍归07。

完整 `findN6Violations` 从当前候选与已有未作废信共同发现全部缺信、法律事实不符与多余信，①②经同一 writer 自愈并返回实际 healed；③有效信缺 ready 指针、ready 文件登记哈希不符及版次不连续只报告。PR1 以真实依赖直接测试该公口，当时正式 Assembly 尚不登记 N6。07 actual 后的 PR2 正式将原名 N6 登记为 `full / P2 / heal_and_alert`，与 N16 共同绑定当前实例的事实依赖，未绑定或已关闭明确失败。N16 独立核订单/订单项/账号存在性与归属，缺 reader 或缺外部引用不能降为零违规。每个 API/worker 的 subscriber、N6、N16 与关闭均为独立 closure，关闭拒绝新操作并等待在途操作结束；索引与登记数组指向同一实例检查对象。

N6的当前集合检查①②③保留未作废过滤；ready文件哈希与版号连续性独立按本次主体scope读取全部状态的历史信及版次，包含取消/移出后的voided信，只报告、不改历史证据。对应异常历史测试在真实取消后明确注入queued版号缺口及错误ready哈希声明，文件字节和登记哈希由真实media公口生成；这是损坏证据反例，不是渲染、签名或生产ready验收。

W5-06 同编号分为两个 PR：PR1 交事实、writer、真实 subscriber、N16 和完整 N6 函数；PR2 紧接07真实 renderer/consumer actual 后启用完整 N6，验证真实 M1 full 零违规。07 只依赖06PR1，03/08仍等06整包；本说明不改变 M5 退出或既有 CI。第一次 M1 真实链实际到达 live，full 的138项检查、0错误中出现1条 N6③：06只生成 queued、07尚无 ready。这是已暴露的交付依赖，③语义保持，不造 ready、不改原零违规断言；PR1 的 full 零违规不等于已检查 N6。

07 沿业主缺字裁定：该版出件暂停并明确缺字，修改资料或字体后重试；此出件行为尚待07落地，06不生成替代文字或伪 ready。

测试的真实链为 Fake 外部渠道成功事实→正式付款履约→两账号绑定审核→订购及历史同意→实际开工→首次方案确认→真实取消审批执行→正式 relay/lease/consume。日期改变、正常 ended、确认后重选当前没有本包可调用的完整 producer，明确以纯注入事实测试 writer，不 SQL 造阶段/资金成功/PDF ready。W5-07/08、M6 和真实法律正文/证书验收仍未完成。

PR1分片后原M1真实20集制作/交付/上线链已复验，实际正式Assembly的137项full检查零违规、零错误，原90秒预算不变；其中没有N6。完整N6公口的自愈与③只报告另有真实依赖定点验证，PR2仍须在07 actual后正式登记并跑包含N6的原full断言，不能用PR1这次绿色替代。

07 #220 actual 后的 PR2 已完成上述正式接线，本地原M1真实20集到live通过，
138项full（含N6）零违规、零错误，90秒预算不变。正式运行口保留voided历史
证据检查、自愈与API/worker关闭隔离；真实法律正文/签署及外部验收继续单列。
PR2当前提交CI与实际合入以其发布记录为准。


## 7. W5-07 授权书 PDF、签署与实际运输

本节说明当前代码；前文 W5-06/独立前置里“归07”“尚待07”的表述保留原移交时点。07 沿同一不可变 snapshot、规范 UTF16 键序指纹与 writer 增加渲染，不新增法律事实收敛或 N6 自愈机制。八条查询/更正/作废/重渲/下载仍以 contract 与实际权限为准；不以本节代替工作包状态、actual main 或完整 N6 验收回执。

| 文件 | 当前端口与责任 |
| --- | --- |
| `license-render.ts`、`license-render-types.ts` | `createLicensePdfRenderer({ fontDir, catalog? })` → `{ configured, render, close }`；输入仅 snapshot、templateVersion、contentFingerprint、可选 signal，成功返回 PDF 字节，不查库或读签署材料 |
| `license-render-catalog.ts` | 按 templateVersion 固定标题、提示与三个 clause key 的正文；正式默认 catalog 当前为空，E8 缺失即未配置 |
| `license-render-fonts.ts`、`license-render-text.ts` | 三份静态 TTF 的既定 SHA-256、公用 Font.load/getFont 字形能力与 ADR-042 并段换行；不引入额外字体或第二套 cmap 解析器 |
| `license-render-result.ts` | 有界缺字诊断与同认领 fence 的只增审计；授权读口按当前有效认领读取，不显示旧失败 |
| `license-queue.ts`、原 `jobs.ts/register.ts` | 认领/租约/条件完成、原 sweep 扩展与唯一 docs.onRevisionQueued；缺配置不认领，缺字本次受控 failed，其余暂不可用沿原重试规则 |
| `license-read.ts`、`license-admin.ts` | 只读范围与敏感下载、已有 writer 上的人工更正/作废/failed 重渲；USCC 预览脱敏，私签 URL 不入库或幂等结果 |
| `ops/docs-render-runtime.ts` | worker 组合 renderer → seal → 最终字节 SHA-256 → secure 对象 → fence 条件提交 ready/current/issued；对象键含最终哈希 |

### 纯渲染与固定正文

renderer 深拷贝组合根给定 catalog，并验证传入 snapshot 的内容指纹。业务 API 不能提交正文或挑选测试 catalog。当前正式 v1 没有法务定稿，因此默认 `configured=false`；不得拿 X-03 历史条款或测试文字补正式 v1。`testing/license-render.ts` 的显式 TEST ONLY catalog 用于受保护 local/test 组合，每页印“技术联调样张，非法务定稿”。后续 E8 应按独立版本/迁移裁定入库，不能悄换已存在版次所指向的同版文字。

字体仅来自 `LYX_PDF_FONT_DIR` 的三份固定 Noto 静态 TTF，先核实际字节哈希，再经 renderer 公共 `Font.load/getFont` 的 `data.hasGlyphForCodePoint` 检查三字体交集。字体注册绑定内容版本，不在并发任务中 clear/reset。替换字体应遵循已批准的字体版本与部署/重启流程；字体修好后可对原 failed 版次重试，资料修正则走更正创建新版，旧 snapshot 不变。

所有实际固定文本和字段先将控制字符换为空格，再做 NBSP 与并段换行；不做 NFC/NFKC 改写。孤立 UTF16 代理受控拒绝，未知 joiner/变体/格式序列也受控拒绝，不能仅凭单码点覆盖宣称整体排版支持。普通组合字符仍逐码点检查，真实 PDF 回读验证覆盖的 e+组合重音。缺字停止整版，不替换成“〓”；诊断最多 32 个去重码点、每项最多四个固定字段路径，含总数与截断标志，持久化外层 meta 不超过 8KiB。普通日志只保受控分类，授权读口才返回具体缺字。

正文、表头、标题、每页编号/版次/页码/内容指纹与实际验真 URL 的二维码均在签名前渲染。页脚不打印文件自身哈希。实际 PDF 自检 BaseFont 名只允许三份固定字体，拒绝回退，渲染文件上限 1MiB；用例另从真实 PDF 字节回读每页文本、页脚、字体与技术标记。二维码使用真实编码图片；当前自动用例核嵌入图像，独立二维码解码及签后真机/阅读器仍属外验。

### worker 能力与关闭

签署由 [esign Provider](../providers/esign/README.md) 提供。`loadEnv` 仅解析四项 ESIGN_SSM 描述和字体路径；API 不构造 source/signer、不打开 STS 文件。worker 才组合固定 SSM secret/version 的材料源，STS 到期判断用真实系统时钟；完整测试 engine 只允许 local/test worker 显式覆盖。正文、字体或签署能力缺配时保持 queued 并给出受控告警，不耗尽尝试、不以图片章伪造生产就绪。

认领后渲染、签署、上传均在事务外。以签后最终字节计算哈希和对象键，再在锁内验证实际认领序号、租约与当前事实；迟到任务不能覆盖新认领或推进不匹配的 current。ready 与文件引用、当前指针及 issued 事件同事务提交。只扩已有 docs.sweep 的 queued 重投/租约回收/满次失败；不增加第二个同名任务或后台自改终态的观察器。

关闭先停止新的消费/认领，abort 本实例工作并等待真实在途结束，再关闭事实 scope、renderer、签署材料源与其他依赖。存储端口没有即时取消能力时等待实际存储完成后丢弃迟到结果；普通文件 I/O 与同步密码学也不冒称可以硬中断。双实例不共用业务 pending 或凭据缓存。

M1 自有测试支架对同一隔离前缀建立真实 docs 队列两槽 consumer；默认进程内 worker 与独立 worker 都使用实际 renderer 和运行时生成的 TEST ONLY 证书（材料 helper 位于 [testing/esign-material.ts](../testing/esign-material.ts)，经 `testing/index.ts` 公开）。local attach 必须携带 owner 保护的测试输入。后台 observer 只读非作废信的 queued/rendering 与最新必需版次失败；逐一核必需信的最新 ready/current，并保留对全部历史 ready（含作废信）的真实文件/最终哈希/文件引用与 issued 后续校验，再读取对象字节复算哈希；空 outbox 或空 Redis 队列不能单独证明完成。原 30 秒排空、32 事件轮及 90 秒用例预算保持。

定向验证（Node 24，显式本地测试 DB/Redis，使用本轮独有 LYX_TEST_SESSION）：

```sh
APP_ENV=test DATABASE_URL=postgresql://liyoxi:lyx-local-dev@localhost:5442/liyoxi REDIS_URL=redis://localhost:6389/0 LYX_TEST_SESSION=w507pdf pnpm exec vitest run --project services packages/services/src/docs/license-render.test.ts --maxWorkers=1 --no-file-parallelism
APP_ENV=test DATABASE_URL=postgresql://liyoxi:lyx-local-dev@localhost:5442/liyoxi REDIS_URL=redis://localhost:6389/0 LYX_TEST_SESSION=w507docs pnpm exec vitest run --project services packages/services/src/testing/m1-docs.db.test.ts packages/services/src/testing/m1-worker.test.ts packages/services/src/testing/m1-transport.db.test.ts --maxWorkers=1 --no-file-parallelism
```

定点用例已核实际 PDF、技术证书签名字节及真实队列出件；完整 M1、正式 N6 与发布证据以调度对应验收为准。E8 法务正文、E11 真实机构证书/授权和签后 V12 均未因此关闭；SSM/KMS、worker 专用临时身份刷新与挂载/CAM 隔离、受信阅读器及微信真机仍需外部验收。正式 catalog 为空时生产不可出件属于如实未配置，不将技术样张当作正式法律交付。
