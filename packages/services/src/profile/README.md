# 商家档案与首店资质（W1-08a、b）

## W2-11 门店活动流

`admin.activity(staff, storeId, query)` 先检查商家查看权限及门店scope，再调用audit只读公口。
同事务分别按本店和主体级无店记录取ops/activity，归并稳定时间/序号游标；actor筛选是
merchant/staff/system逗号列表，游标绑定本店、主体及规范化筛选。投影复用AuditLogItem，
仅增加reason/changedKeys/isEntityLevel；原始JSON、访问流和请求元数据不出接口。
GET不写审计或事件，接口响应no-store；summary、跟进和代改仍按W2-11后续任务推进。

## W2-11 商家草稿生命周期（SOURCE）

新增 `removeDocument` 与 `discardQualification`，经既有 profile write 落 required 幂等结果。
`ensureDraft` 按真实门店/主体结论选 initial/new_store/change；change 带入本店生效门店证照，
new_store 不带入、不接收营业执照。锁轮次65→主体100共享→门店130共享→档案135→完整文件410，
锁后重验归属、生命周期及真实成员。父行只读，使用共享锁防止INSERT的外键锁升级。
remove保留已提交证据；discard只接精确ID的change/new_store未提交草稿。软移除、7天引用释放、
轮次版本/缓存/活动审计同事务，无状态历史/事件；carried来源和旧生效资料不变，缺引用明确失败。
草稿片已完成本机收口；多轮链与终局SOURCE如下，SMS/后台仍后续。
新增DB/HTTP各6组及clerk两行，旧断言保留；作者只做所属格式/lint，ROOT串行完成正式验收与生成。

## W2-11 多轮提交与决定（SOURCE）

new_store只审本店证照，主体生效执照作referenceDocs；change的名称/行业/省市区与详细地址
先存轮次，原生效值保持到批准。选点/坐标、免审简介在审期间可保存，批准不覆盖它们。
提交合并完整proposed、计算五类changedFields、检查新品类许可证与本次声明，拒绝空变更；
M108在entity100独占锁下核另一店执照变更在审事实。初次/新店发qualification事件，change发
严格qualification_change三事件；所有决定沿原approval守卫、定时器与tenant/flow/history。
通过先取代旧有效行再生效新证照，提交过的旧证据引用不释放；未换主体执照时不覆盖主体证照。
change通过只更新主体认证字段，保留首次verifiedAt与主体状态历史；驳回/冲突/回滚保持旧值。

ROOT授权窄tenant companion：setStoreQualification扩现签名与02:627守卫；renameStore只接
真实已批准且未关闭的当前change轮次。scope/auth/version由profile审批入口负责，历史轮次不得写回。
新店首次提交经既有trackOf直记端口；analytics未注册仍明确fallback，不冒称实际外部埋点验收。
I7/资质通过订阅者与终局由后续SOURCE回补；override/OCR/SMS与其余后台事实仍后续。新增8DB+2HTTP关键组及
两个真实max1客户端竞争各3轮；ROOT完成正式验收后裁定本片，整包不标完成。

## W2-11 资质系统一致性（SOURCE）

`profile.onQualificationApproved` 消费既有initial/change通过事件，严格载荷及持久outbox关联后，
复核通过轮次的当前生效执照/主体认证事实；new_store、无执照change及过时来源不扇出。
`profile.I7`完整登记为full/P2/heal_and_alert，scope仅限制被检查主体，verified的closed主体
仍是全局信用码赢家。两入口共用真实system审批拒绝，固定说明、空字典原因与duplicate_entity代码；
真实当前审批/轮次/赢家事实缺一不可，员工原因、自审与审批守卫不放宽。系统原因码仅随最终closedAt/outcome同句写入，遵守两项配对CHECK。
初次拒绝沿审批/主体/门店三链，change沿verified自迁移保留旧合法值；仅本轮新执照rejected，
其他未移除证照accepted，所有已提交证据引用保留。

单批最多32轮，第33个候选只作续批哨兵；approval30→round65→完整entity100→store130→profile135
预锁本批后重验图。与d9逐轮事务的窄偏差：真实consumeDelivery要求首批与done同Tx，首批提交后
同实例runner串行续批，每批独立提交并重新验证来源。I7单次最多修32轮，剩余下次full继续；
不宣称一次扫描清完整库。续批失败保留此前已提交事实、固定日志和正式P2事件告警，后续full兜底。

API/worker各自装配；原onTenantLifecycle绑定保持。profile专用薄TxRunner包装仍由原内核唯一
开事务/重试/幂等/锁，每次attempt局部收集通知；只有真commit后才等待report/alert，失败尝试及
幂等重放不通知。I7违规由ops原同Tx落库，只把告警延后。事件告警键profile.qualification_duplicate
已在ops正式登记，维度仅轮次ID，不发信用码或盲索引。close停止接新批并等待最外在途通知驱动，
无fire-and-forget，不改变已提交业务结果。ops报告端口捕获本实例db/clock，保留测试自定义port，不从全局requireOps选取另一runtime。

新增6组领域风险与1组真实API/worker/max1 consumer装配；两旧不变量集合仅补I7能力绑定，
旧断言保留。作者只做轻格式/lint；类型、数据库、契约生成与唯一独审由ROOT收口，W2-11整包仍进行中。

## W2-11 终局驳回（SOURCE）

正式 `admin.qualificationSubmission.rejectQuote` 为POST空体、none幂等、no-store，
按权限/门店scope/在审/非change守卫调用无fallback的真实 `QualificationImpactPort.previewFinalReject`。
order拥有待开工订购与pending_assign/对应returned广告的同源影响，已有取消指针剔除；
profile不读上层业务表、不自己计算积分，试算不写库或缓存。

正式reject终局分支仅由员工决定，confirm改核三项影响，非终局仍核roundNo。
沿原staff20→approval30→round65→entity100→store130→profile135锁内重算，
缺项或变化整体回滚。initial同步主体/本店rejected；new_store仅本店，旧主体/首店生效资质不动；
change拒绝终局。轮次与档案同事务写finalRejectedAt，真实isFinal事件与原审批/历史/审计/幂等保留。
tenant补真实已关闭终局轮次事实及提交machine守卫，不让直接tenant/flow或缺缓存绕过终局。
本决定不建取消申请、不释放冻结积分，M5整店取消执行仍留桩。

新增6组DB风险聚合与1组真实HTTP，旧两处终局留桩断言随实际开放改为缺三项CONFIRM_MISMATCH，
原回滚断言保持。作者仅跑所属prettier/eslint/diff；ROOT唯一独审、类型/DB/HTTP及官方生成待收口，
整包继续进行中，真实平台与远端CI未验证。

`createStoreProfileAssetInitializer` 增加显式四项组合，旧 initializer 的三项严格入口不扩大。
组合闭包固定 tenant.readStoreAssetFacts，不接受调用者提供的授权事实或owner替身。
低序80→100→120→完整130/135后接日历→完整素材370→共同文件410，首次INSERT即写完整四项来源/选项。
三类档案、品牌引用/洞察/SLA/完整度同TX，所有await后重新核当前会话/owner/来源和本次profile；任一失败全部回滚。
by_owner来源可读，draft_deleted拒绝；当前SOURCE尚未进行本片类型/新旧整叶或独立验收，不启用默认runtime或HTTP。

## W2-11 联系人验证与人工资质复核（SOURCE）

正式 `m.storeProfile.contactSmsCode.create` 采用 required 三段式，先存 contact_phone 专用哈希码，
提交后通过实际 notify.sendDirect 发码，失败补偿删除本次码与幂等占用；当前登录号等值无需发码。
ProfileDeps 窄注入实际 notify 可用性/发送与 identity 会话复核，未新增同层白名单。
联系人更新锁账号80→主体100→成员120→门店130，锁后重验 owner、会话与号码；
内容安全后独立提交错误尝试，正确码仅随联系人成功写入一次性消费。短信不可用存 unverified，
恢复后 submit 必须验证或与当前登录号等值，不沿旧 login 来源直接放行。

正式 `admin.qualificationDoc.update` 在原锁图复核范围/待审/权限/版本，合并修正值后保持必需字段，
保留原提交密文、只改 reviewed 与派生列；轮次及审批单版本同增，审计脱敏、不增加状态历史。
media 公口只读真实既有 OCR 事实并执行纯字段比对，复用 USCC 校验及北京日期边界；
无 OCR/不可识别仅 C11 需人工，修正不伪造识别成功，C5 缺行政区解析事实仍需人工。
送审、修正与决定保存实际检查；待审 GET 只读现算，已关闭保历史事实，不刷新时钟列。
normal/corrected/override 沿原审批与 tenant 事务；override 需真实失败项、追加权限及理由，
审计 meta.rule=override。员工锁后经 authz 公口重建当前角色/组/范围并复核 merchant:view，
避免等待锁期间角色变化沿旧上下文放行。

新增6组聚合 DB 与2组真实 HTTP，旧权限/回滚断言保留；作者只完成所属轻格式/lint/diff。
ROOT 唯一独审的四项 P2 已定点修正，类型/DB/HTTP/官方生成由 ROOT 串行收口。
外部 OCR Provider、真实短信投递、后台 facts/跟进与 M5 取消仍后续，整包保持进行中。

## W2-10 门店档案初始化前置

`createStoreProfileInitializer` 是显式装配的 callerTx 能力，不启用默认 runtime。
prepare 锁完整账号80→主体100→owner120→门店130→档案135，零写封存来源；
opaque plan 绑定当前 factory、精确事务和一次消费，公开部分仅冻结的文件 ID 集合。
来源可为同主体 by_owner 归档店，draft_deleted 拒绝；缺来源档案不补行。
后续所属域370完成后共同预锁410，再 apply；它仍复核真实当前会话/owner/目标缺行，
首次 INSERT 写 copiedFrom/options 与三类精确复制，真实 link 失败整笔回滚。
basic 不带电话/人均/地址/资格；service 与形象 media 只复制未移除行，生成新身份和引用。
完整度使用原真实算法重算，不发伪造 profile_edit 或 store.created。
本片不交 createStore HTTP、brand_assets 或创建权限证明；外部文字检查仍是后片责任。
SOURCE 阶段尚未执行类型、新旧数据库整叶或唯一独立审查。

a 已合并交付商家十三条 API 与进程内核心；b 补后台六条，总计十九条。依据任务书第 2、9、10 节，M1 只做首店 `initial`，含非终局驳回后的补传、重新送审。

qualification 审批类型在 a 登记既定权限与决定 operationId；b 在生产清单挂载六条后台处理器，并用 `handlerOf` 只读取门店真实交付经理；经理为空仍沿既有门店范围回退。W1-09 后台页面必须等 b 实际合入 main 后开工。

`createProfile` 从事务入口、时钟、tenant、approval、media、事件、密钥环与微信能力装配。API 在 `apps/api/src/merchant/services.ts` 最小接线；模块登记由组合根加载，API 和 worker 都能看到 qualification 审批类型、四种文件引用与十项不变量。没有改兄弟 factory 或 runtime 的既有行为。

- 阅读顺序：共享 `profileCompleteness` 与契约 → `repo.ts` / `views.ts` → `service.ts` / `write.ts` → `draft.ts` / `documents.ts` → `submit.ts` / `qualification-kind.ts` → `gate.ts` / `assign-manager.ts` → `register.ts` / `invariants.ts`。
- 基础、服务、联系人保存复用 ThreePhaseRunner：只读 claim、事务外 `wechat.checkText`、settle 锁行重读版本与守卫。done 重放不检测；不可用拒收，业务表不变。当前会话 raw openid 只在该外呼使用，不进响应、审计或日志。
- GET 现算完整度、不写缓存。写事务末尾同步缓存三列。`assertProfileComplete` 只查前三步，资质提交查四步；`storeGate` 为 full / parallel / blocked；`industryOpen` 按当前行业、品类和区域开放值读取，历史停用字典仍能显示名称和保留。
- 明文解密集中在仓储；联系人登录号按源列 AAD 解开后按目标列重新加密。DTO 只回 mask。审计公开门店电话以 `publicContactNumber` 记，避免被手机号键词误遮；敏感键规则没改。
- 文件经真实 media.link/release。先锁完整文件集合再逐项重入；资格草稿替换保留7天，档案引用替换保留30天。DTO 入幂等记录时 URL 均空，首响应与 GET 在事务后签发（含视频封面），done 重放不重新签。
- 提交锁轮次65→主体100→门店130→档案135；决定由 approval 先锁员工20、审批30，再进入领域回调。tenant 写门店/主体状态与认证字段；审批、资格、租户三条链与事件同事务。认证唯一冲突只在保存点认 `uq_entity_uscc_bidx_verified`，并发失败方保持在审。
- 首次指派经理核心收 Tx：员工共享锁20→门店130；员工停用、角色与接收范围有独立错误原因；两个下游端口和门店更新同事务。W1-15 回补 `orderManagerPort`，W1-16a 回补 `deliveryManagerPort`。

M2/M3 规定留桩、首页三个聚合与两项 M1 写端口均在 `docs/plan/stubs/`。`profile.I7` 的检查、自愈与资质通过订阅者已由上节SOURCE回补；I1–I10完整登记，其中I6同事务修正三列并返回healed，I7按真实系统决定返回healed。I1 真库反例夹具只在测试会话独立库内暂时移除两索引、强制事务回滚，随后核对索引恢复及正常唯一约束；迁移与共享库不变。

API 的响应沿既有 `respondByRole` 以本请求会员角色裁剪，写路由的店员能力统一拒绝。clerk 样例追加全部十三条，旧黄金不改；A86 的服务现价与原价按现有完整路径登记例外。卖点 `sellingPoints` 与 C57 键扫描词冲突由调度单独 gate-change 收口，本业务包不放松扫描逻辑。

## 后台六条（W1-08b）

`profile.admin` 提供 list/get/qualification/approve/reject/assign；API 薄壳统一声明 merchant:view，写侧另取契约权限点。读侧复用 storeScope，范围外与不存在都为404，GET 不补行、不刷新缓存。列表完整支持 q、regionCode（省市区/功能区）、行业品类、资质多值、交付经理/未分配互斥、主体、生命周期；M1 排序为 registeredAt（缺省倒序），其他筛选/排序明确400。详情 paid 是主体合计；列表仅首店展示 totalPaidFen。

决定按 staff20共享锁（同级UUID排序）→approval30→qualification65→entity100→store130→profile135。后台只补前置守卫的顺序：范围→待审→禁止自审→权限与override追加权限→版本→confirm；实际领域效果复用 a 的 approval 类型，不另写决定逻辑。缺回显交给领域返回 CONFIRM_MISMATCH，故请求 schema 允许缺 confirm/roundNo；W2-11 已逐片回补变更、终局与人工放行，见对应 SOURCE。决定与完整脱敏DTO同事务保存供幂等重放。资质DTO仅含证照 fileId；原图走既有 admin.file.downloadUrls 的5分钟地址与access审计，不在本DTO预签。

跨层后台字段由本域 keyed `adminProfileFactsPort`（profile.admin_facts）提供。实现方用 `implementAdminProfileFacts(source, provider)` 注册 billing/order/delivery/support/staff 各自的严格结构；传入 entityId/storeId/managerId/ownerId/now，只读、无外呼。订单来源拥有上线剧数、使用期汇总与最近约定上线日，交付来源拥有交付工单数与经理工单工作量。未注册键按字段给 none/0/null/空数组，M2 G2-B 回补，见后台聚合留桩。它不复用商家端 merchantFacts，以免放宽角色裁剪。

后台首次指派显式 allowArchived；既有商家/系统调用仍默认拒绝归档。锁目标staff20共享、门店130后校验原经理为空，再调用两个同步端口，最后 tenant 写门店及唯一ops审计。同步端口 Promise<void | number> 兼容旧空实现：void记0，实际实现必须返回本次改写数量；响应 synced 与审计 meta.synced 同值，note只写reason_text。同步端口应按明确 input.staffId 写入，调用时门店行已锁、deliveryManager列尚未更新；不得借旧列替代输入。下游新增锁须高于已持store130，order160/delivery180保持原锁序；任何端口失败整事务回滚。W1-15/W1-16a 回补同时补真实数量。

本域 m03 对 named schema 的可空引用改用 common.orNull，避免生成器把 DictRef、MediaFileView 等组件污染为可空或空对象交集；源 schema 行为不变，非空字典/null与媒体必有字段有真实类型消费者回归。没有改全局生成器、内核、DDL、锁序常量、依赖或 layers。

W3-05 的 `profile.onFileModerated` 只回读当前文件和 logo/媒体/服务图片引用，按 store_profile UUID 排序锁后复用 refreshCompleteness 重算现有三列缓存，时间取当前 file.updatedAt。乱序 pass 事件不能把已 block 文件恢复为可用；审批状态、档案 lockVersion 和其他字段保持原业务写入口。

W2-10 的门店停用窄前置公开 `countQualificationSubmissionsInReview(tx, storeId)` 与 `countUnverifiedPrimaryStore(tx, storeId)`。前者只计已提交且未关闭的全部三种资质轮次，后者只计主体认证结论不是 verified 的首店；复用调用方事务，只读无副作用。完整 StoreCloseGuard 必需端口装配及生命周期写侧仍由 W2-10 主包完成，不把缺装配当作零。

## W2-10 生命周期订阅

`createProfileTenantLifecycle` 只接 clock、tenant、approval、events 与真实媒体引用三公口，
不需要商家审核、openid、密钥或另开事务。`profile.onTenantLifecycle` 接收原五事件；
严格校验载荷后回读当前主体、门店归属、生命周期与停用原因，已过时的停用/恢复消息不写新状态。

先发现完整候选图，再按 approval30→round65→entity100→store130→profile135 锁全集，
锁后重读候选与关联；有新增或变化则整事务拒绝重试。完整文件集合只预锁一次410，
之后再次重读候选。系统撤回通过真实 approval.withdraw 取消本单 SLA timer、记录审批历史/审计，
领域回调重验真实终止主体及轮次关联。initial 回退门店/主体，new_store 仅回退门店，
change 写 verified→verified 历史；商家撤回及未来 change/new_store 提交、通过、驳回仍拒绝。

停用门店丢弃未提交草稿，给未移除且未生效证照写 removedAt；草稿证照7天、档案三类180天。
主体关闭时全部历史证照引用延至 closedAt 后三个日历年，放弃时保留已提交证照引用。
留存目标锚定真实 archivedAt/closedAt；先读 media.readRefRetention，已释放且目标足够则跳过，
原 release 的当前最低保留仍生效，原先更长期限不缩短。释放时缺失业务文件引用明确失败，不静默补造。

恢复只重连未移除档案行；真实 link 再核 stored、审核、类别与归属。仅已 deleted 文件可清理
档案行或 Logo，清理前仍核归属；过渡态、block、错类别/范围保持失败，不吞成成功。
重算完整度三列，实际清理时递增档案 lockVersion；不恢复资格草稿或已提交证照。

worker 在 createEvents 前生成实例 scope，在真实 tenant/approval/media 完成后只 attach 一次；
未绑定或 close 后明确失败。在途 outbox 消费和循环收完后才 closeProfile，无进程全局服务绑定。
本片仍需按冻结清单完成真实数据库、outbox/worker、类型和契约验证；新增消费者不代表尚缺 producer
或 W2-10 整包完成，真实云及正式容量未验。

## 建档首页成员摘要（SOURCE）

首页在原调用方 Tx 中读取 Tenant 真实成员摘要，并与原商家事实共用一次业务 now。
老板名取成员列，店员数仅本店有效范围，预览老板优先且至多三人；未到期 pending 才占额。
GET 不建档案、不补过期状态；既有老板/店员响应裁剪及其他首页字段保持，完整验证待授权。
