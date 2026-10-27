# media 文件最小集（W1-07）

W3-16同步营业执照OCR已完成本地代码验收：`media.ocr.recognize`先只读核真实文件分类/上传人/业务范围，
只复用同主体、请求门店、fileId、映射type及permit的最新ok；分支执照映射business_license，
不跨文件摘要冒用。新调用用现SessionMutex按主体/门店有界串行，外呼期间不持业务TX。
北京时间按实际结果行计既有日额参数（默认20，0关闭新识别）；缓存不重复计数，
缺配/不可用不写占额行，不造同步pending或media.ocr.completed。行业许可证保持人工。

技术结果在独立短TX保存，后续资质草稿回滚仍可复用；结果只存规范化字符串字段密文、
告警码和操作人事实，原厂商响应加密30天，bigint按十进制字符串留证而不丢精度。
签名位置只从服务端文件事实取，底层六秒可取消；不保存签名URL、凭据或明文整包。
文件/轮次迟到守卫在本域及调用方原锁图分别复核。生产唯一审查及P2定点复核已通过；
四组DB、纯核验、受改SDK协议、新HTTP闭环及services/API类型已通过，
API/worker构建、依赖与官方挂载/登记核对均通过，识别桩已回补。
真实E17证照样本/OCR精度、E19云权限/地域隐私/收费及远端CI均未验。

W315l 素材视觉策略已完成 SOURCE 接线，尚未运行本片类型、测试和正式验收。
图片使用可信1280/JPG签名；视频要求当前同主体文件、真实终态probe的完整输出/SHA与
MediaInfo/tech_spec一致，按D5数量6–14选择等分区间中心请求时刻。请求时刻不是实际帧PTS，
模型只返回description、quality、hasPeople、identifiableCustomerFace、textInImage五项聚合事实。
业务洞察只保存五项；完整来源哈希、缓存来源和请求时刻仅留任务输出，不保存签名URL。

父锁钩子只排序预持目标及至多32个同主体缓存候选素材370，runner随后取得实际任务400；
仅vision再完整排序锁文件410并复读，图增长拒绝而不补低阶锁。终态来源由其所属素材370
保护，所有正式来源写须遵循父锁协议，不承诺任意原生SQL写入安全。缓存须核完整来源、
当前run/选择集、prompt和文件指纹，命中不消耗预算、不签发、不调模型。最后文件锁及预算
await后重新取时复核租约/总期限；收尾尊重runner已写succeeded并清租约的事实，再核来源。
新五项视觉正文供digest消费，旧description/tags来源及原6000/8000/16000字符边界保留。
默认模型/预算仍关闭；受控测试签发不证明真实云处理、尺寸/内容/帧PTS、权限、费用或E22。

`readMemberAssetCounts(tx, { entityId, storeId, merchantUserIds })` 从同一 SQL 快照返回每个去重商家账号的上传素材条数和采用过的条数。仅计同主体、同门店、商家上传且未软删除的素材，采用次数大于零的每条素材只计一次；无匹配素材才返回零，空账号集合不查询。处理、复核、可用性及当前成员状态不参与历史计数。

此公口复用调用方 Tx，不开事务、不加锁、不读时钟、不调 Provider、不写业务。类型由 media 所属叶公开导出；后续成员列表通过组合根注入结构等价的 typed reader，tenant 不直接引用同层 media。当前仅完成源码准备，尚未运行本片独占验证或接入成员 HTTP。

M1 只开放 MinIO 预签名表单的小文件通道。服务入口是 `createMedia`，API 用进程运行时的 `media`，worker 用 `promoteFile` / `scanPromote`；对象存储的调用全部在事务外，队列只负责唤醒，`media_job` 是任务事实源。

## 1. 上传与入库

`register(actor, input, { idem })` 先判类别与归属，再按扩展名推规范 MIME、核对分类上限，忽略客户端 MIME。商家一次 1–9 个，后台一次一个；批内任一不合格，整批无新增。商家开放档案三类、两类证照、回单与账号截图，按能力点判权；M1 这七类都不允许店员登记。已停用门店的老板仍能上传回单。后台海报需要短剧库编辑等级；样片、成片没有分类守卫即拒绝，其余后台分类按 M1 边界关闭。

相同上传人、分类、归属、clientToken 和大小的 pending 登记复用。冻结索引 `uq_file_object_client_token_noscope` 未含 entity_id：同一上传人跨主体使用同 token 时返回 `VALIDATION_FAILED`，字段 files.N.clientToken 提示重新生成，绝不返回另一主体的凭证。相同主体在不同门店的主体级文件可以复用；门店级文件按门店各有一行。此边界移交后续结构包，不修改冻结 schema。

登记有效 24 小时，表单有效 10 分钟；`refresh` 重新签表单，不写 sts_issued。refresh 与后台 downloadUrls 的路由都是 idem:none，事务只标记上下文已用，不存中间 FileRow。过期登记仍留 pending，清扫归 M3。

`complete` 是三段式：锁 file_object，写 30 秒确认标记；事务外 HEAD 与最多 4KB 的文件头校验，绑定 etag；事务二按确认标记条件推进 promoting，并同时插入去重任务 promote:fileId 与 file.uploaded。不存在的对象清标记后返回 UPLOAD_NOT_FOUND，同幂等键可补传重试；大小优先于文件头判据，不合格持久化 rejected 与 file.rejected，再返回 UPLOAD_REJECTED。已确认不再重复建任务。幂等结果存完整 JSON 视图：商家 FileStatusView，后台 AdminFileView；首请求最多轮询 3 秒取得较新状态，重放仍返回事务二保存的 promoting 快照。

W3-03 将 promote 迁入统一媒体执行器：local 并发2、remote并发8，`media_job_run`每15秒最多扫描20行，`media_job`队列消费者并发10仅作入口。promote硬超时4分钟、租约5分钟、deadline30分钟；父对象(如有)先锁，再media_job(400)→file_object(410)。TX外按incoming etag条件复制、规范MIME/attachment，再核实际大小/etag/CRC。收尾复核当前state/attempt/leaseOwner/外部号与未到期租约，成功stored+file.stored一次，故障按1/5/15分钟退避；原promote消费者和30秒补偿扫描被统一事实恢复接管。扫描只等短TX认领，执行IO由同一owned集合持有，不能将扫描返回数理解为已stored。

## 2. 同事务引用

引用方在自己的 register.ts 用 kernel 的 `fileRefTypePort` 按 ref_type 登记 roles、允许分类、保留期、可选释放守卫和业务列只读投影。纯端口声明在 L0；media 保留兼容导出，不能直接读其他模块的业务表。制作分类的 `fileCategoryGuardPort` 留在 media，由 delivery 后续登记 assert 与同事务 registered 回调。

`link(tx, input)` 与 `release(tx, input)` 和业务写入共用事务。调用方先锁业务父行；多文件先按 id 升序锁 file_object(410)，再逐个调用。link 只接受 stored、未 block、用途分类与归属相符的文件，统一以 FILE_NOT_USABLE 的 not_stored / blocked / category_mismatch / scope_mismatch 拒绝。平台文件无需归属；主体文件断言 entityId，门店文件断言 storeId；档案三类、store_asset、portrait_auth 允许同主体跨店引用。上传人、本次业务对象等更细的授权由调用方先校验。

live 引用清空 releasedAt/keepUntil，firstLinkedAt 只设置一次。release 的 keepUntil 取调用值、分类/引用最短缓冲与旧值的最大值；有 live 引用时 purgeAfter 为 null，否则取已释放引用的最大保留期。released:true 只用于初建已释放引用或延长已有 released，不能绕过 release 使 live 转 released，也不能绕过永久/生效协议的释放守卫。重新 link 已释放引用恢复 live。协议 source/pdf 已接端口：草稿 7 天、生效后不可释放；media.I2 每日全量与 media.I14 每周全量均为 P2、无自动修复。

`readRefRetention(tx, input)` 读取同一四列自然键的 state/releasedAt/keepUntil，返回 live/released 判别事实；文件、登记与 scope 合法但引用不存在时才返回 null。未登记类型或角色抛 TypeError；缺文件与错误 scope 都返回 FILE_NOT_AVAILABLE。scope 沿原 release，永久及不可释放引用仍可读，不调用 canRelease，不证明可引用、恢复或下载。

读口持 file_object(410) 的默认 update 锁，业务零写，不读取 clock 或调用存储；不能用于数据库 READ ONLY 事务。调用域先验证真实 refId 归属并锁低阶业务图，多文件须一次预锁完整去重文件集后逐项重入。deleted/deleting/block 文件仍能读取历史事实，原 link 技术守卫保持。

消费者在同一事务比较稳定业务锚点的目标期：released 且 keepUntil 足够时跳过原 release，避免晚到重复投递再次顺延；事实不足时才调原 release，null 须明确处理缺引用。原 release 仍取当前 clock 最低期、调用目标和旧值的最大值；本读口不改变首次迟消费的最低留存，也不实现 profile 生命周期消费者。

## 3. 签发与系统文件

`signRead` 只校验文件技术状态，由业务调用方先授权；`downloadUrls` 先按后台分类矩阵与数据范围授权，拒绝统一 404，未入库或 block 返回 FILE_NOT_AVAILABLE(status)。GET 零写入。secure、样片、成片每次成功 POST 签发都写 access/file_access/files.url.sign；默认 inline，可选 attachment。时效取共享登记表：证照/回单 5 分钟、协议 30 分钟、档案图片对齐窗口实际 30–60 分钟、样片 60 分钟、员工成片 30 分钟、商家单集 15 分钟、ZIP 3 小时、发布清单 15 分钟。窗口内重复图片地址相同。

`putSystemFile` 只支持 legal_doc、poster、drama_license_doc，接收完整字节，校验扩展名/文件头/上限，计算 SHA256；系统文件 originalName 为 null。正式键使用稳定的小写 ASCII 键，不能是 incoming。存储 putObject 的 ifAbsent 条件写入保护已有对象：同一完整字节 SHA256 与 category/entity/store 的 contentIdentity 指纹才采纳已存在对象，不同内容/归属拒绝。对象先写成功而 DB 收尾失败时，同内容重跑可以恢复事实行；不传新条件选项时 Provider 原写入行为不变。

演示运行器按 staff → media → docs 执行：六份合法的占位 PDF 入库，取演示内容运营员工，接六个协议版本及十二个引用。重复播种零新增；APP_ENV=prod 拒绝。正式协议文本仍待 E8，协议端 PDF 读地址仍由原 M2 留桩接线。

## 4. 验证与接手

Node 24.20.0；只用公开本地 PostgreSQL/Redis/MinIO，测试各自数据库、Redis 前缀与对象键。定向命令：

```sh
LYX_TEST_MINIO=required pnpm exec vitest run --project services packages/services/src/media/media.db.test.ts packages/services/src/media/demo-seed.db.test.ts
pnpm exec vitest run --project worker apps/worker/test/promote.test.ts
pnpm exec vitest run --project api apps/api/test/files.test.ts apps/api/test/admin-matrix.test.ts apps/api/test/clerk/clerk.test.ts
pnpm contract:generate
pnpm contract:docs-check
pnpm typecheck
pnpm depcheck
pnpm plan:summaries --check
```

制作上下文/留痕归 W1-16a；引用方逐表登记由各业务包完成。真实存储、STS及分块公开能力见W3-01；W3-03接手统一执行循环与原promote补偿扫描，清扫仍归后续包；图片审核的微信窄接线见下节，视频及其余审核归 M3。分类登记表后续只增开放类别与守卫，不在本包放开未来权限。

## 5. 微信图片审核（W2-21 窄接线）

注入 `wechatImage` 后，原 promote 成功事务为 weapp 商家上传的 profile_image/profile_promo/store_asset/channel_screenshot/ticket_attachment JPG/PNG（不超过 5 MiB）创建唯一 audit_image_wx 任务并置 pending。W3-03中任务由统一 media_job 队列及15秒事实扫描执行；锁序保持 media_job(400) → file_object(410)，签读 URL 和 Provider 外呼均在短事务之外。领取只接受同 AppID、最近两小时身份公口的真实结果；没有身份/配置或提交未获 pending+traceId 时转入唯一 CI fallback 任务。

WX 提交先持久化 submitting/attempt/租约，结果仅由同 attempt/lease 收尾为 submitted；35 分钟未完成或提交租约过期转 CI，避免未知外呼结果重复提交。CI 只在既有 MediaProvider.audit 明确 processed:true 且 pass/review/block 时关闭任务；当前 local processed:false 或不可用会持久化受控失败，文件仍 pending。W3-03新增CI原生驱动，只有完整CI角色配置时选择；未配/local processed:false不能算审核完成，真实云权限与回调到达另验。

公开 `applyWechatImageResult(tx,{traceId,result:{suggest,label},receivedAt},ctx)` 使用注入 clock 写 decidedAt；risky 保存原来源结果并映射文件 block。未知/尚未提交 trace 返回 BUSY，由原 webhook inbox 重试预算承接，不吞成 ignored；终态重复、超时后的回调、退役文件与对象键不匹配均不得覆盖文件。pending/review 仍遵循既有引用与签读规则，block 继续由原 refs/sign 守卫拒绝。未新增通用审核流水线或状态历史机制。

本叶验证使用真实隔离 PostgreSQL 与受统一 TX 外呼守卫约束的假 Storage/Wechat/Media，覆盖生产 promote 触发、并发领取、三种回调、提前回调重试、旧尝试、退役/错对象、超时与 CI processed:false；未调用真实微信或 CI。进程/worker 的配置、最近身份注入、来源 handler 与关闭生命周期由中央装配接管。

## 6. W3-01 分块登记、续签与取消

支持 STS 的 StorageProvider 对>20MiB登记选择 multipart：8MiB分块、块并发4、每文件前缀30分钟短授权；无能力仍是原post，不伪造STS。首次STS占1次，实际续签先在短TX内按原 file_object 锁顺序复核本人、scope、pending、确认租约及24小时上传期限，并原子预扣（最多30）；随后TX外调用，返回前短TX再做 fresh 复核。确定 rejected/unconfigured/unsupported 未签发才退本次1；网络/5xx/未知结果或崩溃保守保留占用，不声称官方已签发30次。成功签发后状态改变不退预算，也不给客户端凭据；凭据不进数据库/幂等结果/日志。

后台新增恰 `admin.file.refreshCredentials`（none、no-store）和 `admin.file.cancel`（required）。取消仅本人staff登记，确认中拒绝；pending→expired，同意图重放不重复中止，无取消业务事件/审计。提交后尽力中止本file确切incoming key的未完成分块，不扩大权限；旧MinIO post取消仍走原删除。微信图片审核回执、trace竞态与35分钟兜底保留；W3-03已由统一15秒事实循环接手原30秒promote补偿。

complete仍是原三段式，在TX外读取HEAD/4KiB头、核声明大小与真实类型/ETag；服务端可选CRC写incomingCrc64。条件copy后正式HEAD必须与大小、copy ETag及确认CRC一致才stored；不相信端侧“上传成功”或客户端CRC。冻结构noscope唯一索引未带entity_id保持原拒绝策略，同actor/token跨主体仍VALIDATION_FAILED；没有本包DDL，独立结构包再评估。

公开后台 `createMultipartUploadAdapter` + `createAdminMultipartUploadPorts` 供后续批量页调用现typed中央API，不改通用UploadField：文件并发3/块4，失败保留UploadId/clientToken，ListParts恢复仅补缺块，STS按服务端到期时间单飞续签；取消/close用generation+AbortSignal丢弃晚进度。Complete/Cancel同意图key只在File的WeakMap会话中保留；不使用localStorage/sessionStorage、不打印密钥；成功释放会话。若同内存会话实际尝试Complete后响应未知，仅ListParts404+唯一NoSuchUpload才进入现有业务确认，最终由服务端检查决定；未Complete/一般云错不得绕过。不新建UploadId，不假云成功。外部CORS需允许Authorization/x-cos-security-token并暴露ETag，E4未验证。

本地新增真实库反例覆盖额度并发、确定失败返还/未知占用、成功签发后取消、确认租约、scope、服务端CRC；新API走原鉴权/Origin/限流/幂等全管线。真实云、历史版本操作、GB压测及未来批次页面未宣称完成。

## 7. W3-03 统一媒体任务

`createMediaJobs`只运输事实；handler按既有kind注入，严格校验input/output、当前业务代次和父汇合，当前实际接promote、audit_image_wx及其profile图片CI fallback。其余13种业务处理器由对应包接入，不用空handler造完成。`createRemoteMediaHandler`提供提交/查询/按UserData找回的必要原语，首次提交即使平台称Success也先submitted再真实查询。每次UserData固定jobId:attemptNo，过期submitting先按当前重试周期与该UserData有界找回；截断、超时、未配置或遗留替身缺方法均不能当成none证据盲目重发。

`jobs.pause`立即取消本机IO；`jobs.shutdown`停止新领，等45秒后取消并等实际清理；只在同state/attempt/leaseOwner条件下将自己local running退queued、attempt减回一次。强杀依赖持久租约，不重置其它实例。输入输出不存openid/签读URL/原识别正文。父锁→job→file后同TX调用业务纯汇合；I10逾deadline收尾与I11父对象15分钟停滞复用该汇合，缺handler如实留未自愈，不写通用ready。I11按正式数据模型15分钟，D5较低层的2分钟表述不缩短此界限。

新增3HTTP/3x01：后台页码列表默认failed且system≥view，DTO隐去input/output/leaseOwner与原始错误正文；人工retry要求media.job.retry及required幂等，仍需当前业务需要，复位attempt/deadline/error并只审计一次；CI自然幂等回调只验HMAC-SHA256(mediaJobId)，提取一个安全JobId，submitted且外部号匹配才提前nextRunAt，绝不采信回调状态。原W2-01 inline收件同TX，无载荷持久化。媒体/微信/对象IO新增可选signal，未传仍兼容原调用，外呼guard保持最外层。

ProduceID新补标默认`lyx:{小写UUIDv7 fileId}`仅作后续任务移交；不改上游已有标识、不声称法务已确认。CI真实激活、cam角色授权、任务模板、回调到达及大文件性能未验；本机只验证公开假key、有限HTTP与自有隔离库。

## 8. W3-04 制作处理器与真实技术事实

在既有执行器登记 probe、restamp、transcode_mp4、watermark_sample、normalize 五个 handler，不新增 HTTP、页面、x01 或任务循环。只有存储真实 HEAD/条件流读取、隔离 mediatool 探测与 H1–H7/S1–S10 判定后才写 mediaInfo/check；没有原片、广告窗或当前制作上下文时拒绝。raw 只保留技术白名单，来源的 AI 七字段逐字保存；缺标才补写，并独立回读全部七字段，不改变来源 AI 声明。

派生文件使用新 UUID/固定对象键、条件流写和真实 HEAD。对象先成功写入后，独立短事务登记无引用 stored 技术事实；当前父、attempt、lease 和完整 context 均有效时，收尾事务才建立引用、派生 productionRecord 与事件。来源引用保留30天；晚结果不会挂到当前业务父，只由既有无引用清扫规则回收。cover 使用 media_info/cover 引用，来源使用 production_record/source 引用；引用不绕过原分类和归属守卫。

production_record 父先预锁已有样片350再制作记录360；属于批次时通过同事务注入的 batchLockSiblings 预锁，再领取 job400。playable 父与同短剧兄弟350排序预锁，重读新增成员则 BUSY 零写。handler current 在同事务一次排序锁全部源、派生、封面及旧引用文件410；不在文件锁后补拿业务父锁。批次原片无需伪建 productionRecord，真实检查后调用同事务 productionChecked；派生检查通过后才替换活动批次文件。

预告片 SD480×854、HD720×1280 两个独立云任务都完成且通过产物回读才安装 current；target 变化的晚结果退役，失败保留旧预告。样片取真实门店 name，经 shared 清洗、截10字和北京时间日期生成完整正式文案；固定许可 Noto CJK 字体渲染透明720×96 PNG，再使用同桶固定临时对象的原生 Image 水印，样片输出720×1280。云任务成功状态不能代替重新下载、探测、七字段回读与对象确认。

`MEDIA_PRODUCTION_FILE` 必须完整给工作根、根内 socket、AI主体五个配置值及六个模板标识；ProduceID 和 PropagateID 由实际文件/来源事实生成。缺配置受控失败，不自行补法务主体值。store/ad/drama/trailer 由组合根同事务公开事实注入，media 不直接读取同层 content 的私有表。local/test 工具测试注入保留真实领域事实与外呼守卫，生产环境拒绝注入。

`productionFacts` 只回有限技术/检查/AI/派生/水印事实，不返回对象键、短签名或用户工具正文。`retireDramaMedia` 证明 DB retired、在途取消与专属引用即时释放，返回 objectRefs 和 `cdnPending:true`；真实公开 URL/CDN 清除尚未配置，不能声称停止播放。当前真实库15例、客户端小IO15和装配4例已通过；存储新增字节/元数据欺骗2反例先真实失败，完整修正后受影响14例和CI/配置6例均已通过，API/worker类型通过。新源镜像31例中30通过、1条原业主样本条件跳过；最长完整中文水印实际两行alpha均不触画布边缘。约199.8MiB五轮体检+封面最慢232ms，三轮补标七字段完整回读、最慢424ms，原沙箱与轮数/上限不变；这是Mac本机观察。同步实际main bfcf9817后的旧装配、必跑MinIO、新鲜类型、严格分层、双次官方生成/门禁与API/worker构建已通过，相关纯类型迁移的32例定点回归通过；真实云、法务与平台读标未验。

正式审查指出的mediatool取消项已定点闭合：私有UNIX随机调用标识与102注册屏障防止取消先于登记；queued取消不spawn，running取消等待自己的子进程close后才释放槽位。调用者不把request.destroy当清理完成；原响应或固定cancel确认都不能验证时，沿原绝对期限返回不可用并保留工作目录。关闭A不取消、等待或删除B资源。真实旧镜像反例先失败，新源取消7例和原受影响38例通过；真实容器33例中32通过、原样片1条件跳过，原199.6MiB五轮最慢163ms/三补标最慢656ms通过，仍是本机观察，未调用真实云。

## 9. W3-02 批量上传

`media.uploadBatches` 提供 create/get/start/refreshCredentials/update/complete/cancel/commit 八个用例。通过 L4 注入的用途公口读取真实剧目集数、工单范围及制作快照；media 不查 delivery 表。原片 commit 同事务生成新版本、交接引用并发出既有 `drama.masters_changed`，成片由交付公开用例消费批次。

匹配保留已登记总集数；full 必须覆盖全部集号，partial 保留未选集。顺序建议须显式接受。修改严格三选一，替换先让出旧 pending token 与有效条目唯一键；被替换的历史仍可查询。批次活动将期限顺延 72 小时并同步 pending 文件，最晚为创建后 7 天。confirm 只经过真实 HEAD/头校验进入 promoting；拒收事实提交后再返回错误，不把直传完成当作体检完成。

凭据只授权本批 `incoming/b{uploadBatchId}/`，30 分钟、8 MiB 块、文件并发 3、块并发 4；返回前后均复核本人及当前权限，不存凭据。批次 COS ListMultipartUploads 另用严格 `cos:prefix` 条件，原单文件授权不扩大。GET 不写业务行；权限变化后持有人仍可查看，但不能续签或变更。

已普通同步包含 W3-04 的实际 main 并装配其真实处理器：批次父对象预锁、promote 入库/拒收通知及 productionChecked 在原结果事务内收敛；原片不伪造 productionRecord。新增四项公开执行器连库回归先真实失败、接线后完整通过；原批次目录、交付写侧、体检与 promote 租约九文件45项完整通过，接口七项的先前证据保留。真实容器20集ready、跨刷新续传与交付消费已通过：完整live旧21项通过、新批次输入方式失败；修正后定点auth+20集两项通过，严格核20个latest成片到ready文件ID对应且待质检current保持null。原两集制作/QC/保存/包质检证据保留，不混称重新跑全22项。原片编辑 UI 移交 W3-12；真实云断点、大文件与平台联调另验。

## 10. W3-12 后台内容与站点文件前置

既有 `banner`、`trailer_src`、`drama_license_doc` 按 a01 第2.17节开放后台登记：分别要求 ops 编辑、`drama.media.manage`、drama 编辑或 `drama.copyright.revise`。三类均限定平台归属；不接受主体、门店或代传范围。原片仍只能经过批次，系统派生类别仍不能通用登记。

Banner 和预告片源按正式矩阵允许员工签发短时读地址；版权证明仍要求 drama 查看并逐次记录 access 审计。文件必须已入库且未被拦截。后台预告片源预览走既有 `admin.file.downloadUrls`（a04 第3.22节），不新增可播放资产接口。接口用例使用真实鉴权、隔离库和完整登记/完成/promote链，存储为 FakeStorage；这些边界用例不代替 W3-12 实际媒体制作与浏览器上传验收。

## 独立模型预算账本前置

`createModelBudgetLedger`只借用窄eval传输，构造零IO，提供reserve与显式maintain；不装配当前模型owner、worker或Redis连接，不提供初始化、恢复、退款、删除token或close。两正式参数登记为文件200/全局槽0，任一个0均关闭；实际模型默认仍关闭。ASR新提交1槽，vision/digest固定3槽，同店同北京日同file只首次计文件，0文件摘要仍占3槽；不为ASR query预留。上下文只验证结构，真实主体/来源hash/原deadline必须由后继PG许可核验，不能将此口当授权。

调用方须在全部祖先PG已结束后调用；test/dev公开kernel断言也拒绝detach，production另以isInTransaction拒绝当前事务链，本片不声称可强制识别任意已脱离的祖先事务。传输最多等250ms且不越原admitUntil/lease/deadline，迟到/取消/未知均保守关闭；Lua错误不回滚，已预留不退。业务Clock与RedisTIME只容5000ms偏差并保存时间/北京日高水位，不以偏差延长授权。

单HASH原子预留同时记录无日期job/attempt/kind token与q到期索引，先验完整批再一次HSET。HLEN含索引硬界250000，可信maxFields只能降低；128序号槽维护包含空洞，游标循环，不HSCAN/HGETALL。token须双方时钟均过原deadline+5000ms才删，先持久提高closedBefore再删；旧原deadline永不因回拨重授。日计数只清当前日前两日及更早项，活token不按午夜清。索引与目标实际值/到期关系必须相符，损坏不修复、不自动建账。缺账本/marker/水位关闭；任意HDEL、旧快照恢复与Redis丢失不在协议证明内。

active token对人工retry保守冲突，不支持立即重试；attemptNo会被既有人工重试重置，完整epoch仍待后继，不声称永久身份。两个具名告警只登记/测试真实writer，自动预算告警与初始化、维护调度、连接所有权/关停及P1-R-P2实际装配均未完成。当前SOURCE未运行类型/测试/生成/DBRedis，容量、云账单和生产时延未验。

## 三个模型处理入口的许可接线（SOURCE）

`MediaAssetsDeps.modelBudget`是可选成对端口：`readPermit(tx,facts)`只补两项正式额度，
`reserve(context,signal)`借用已验收账本。端口属性存在时为权威；缺方法、非法事实、异常或未知结果
均受控关闭，不回退旧`allowModelCall:true`。仅未提供新端口时保留旧回调行为和调用次数，旧回调
不代表原子账本保护。真实runtime只透传显式注入，worker尚未安装账本，默认仍关闭。

缓存先于许可与签发。实际来源完整重读后，P1短事务按父370→实际job400→全部文件410锁序
校验当前run/prompt/provider/attempt/租约、主体门店及来源hash，同Tx读正式参数。必须等
`tx.run`成功提交后才在PG外调用一次reserve；reserved后P2新事务重新锁完整图并比较来源与
当前参数，再等提交成功才调用模型。图增长拒绝，不补低锁；终态来源依所属父370写协议保护，
不保证任意绕协议原生SQL。回滚、迟到、取消与源变只保守占槽，无退款、重授或PG/Redis原子性声明。

P1的readAt在最后锁等待与来源await之后取得，窗口至多250ms且不越原lease/deadline或签名到期；
P2参数按新时钟读，但不续原窗口。完整Provider纯输入先验在付费前执行，最终事务提交和reserve
返回后均重新核时钟/取消。ASR新提交计原文件1、1槽；视觉无论图片或6–14帧仍计原文件1、3槽。
摘要保留原16000 Unicode码点正文和完整来源hash，只有最终正文实际保留非空洞察字符的文件计入；
前缀、换行、文本、说明与标签占原布局，全部丢弃来源不计文件，纯文本/说明摘要0文件仍3槽。

ASR query/poll/recover不读新额度、不reserve、不签名、不重提，只回查原TaskId并核原来源/租约/期限。
显式旧回调每次query仍调用一次，false跳过、异常pending；完整新端口且无旧回调时，可在原守卫下
继续回查，不因次日、额度归零/耗尽或账本丢失挡住已受理任务。它不证明query免费或账单事实。

L4 `readModelBudgetPermit`只在当前Tx按readAt读两正式参数，非法值用本次局部标记拒绝，
缺值沿正式默认200/0关闭；不在业务锁中发告警。当前仅源码与轻量检查，实际新旧整文件、类型、
正式生成/资源收尾尚待独占验证。连接、初始化/恢复、维护、自动告警与worker关闭仍为后继，
真实云、费用、模型质量、容量、E22及完整W3-15未宣称完成。

## 预算运行时生命周期（SOURCE）

已接受三owner许可后，worker组合根安装实例作用域的完整pair，借用入口专用Redis transport。
构造零IO，`--check`不创建预算客户端。正常入口lazy连接、关闭离线排队与未确认EVAL重发，
连接未ready立即关闭；250ms传输上界不延长原许可、租约或总期限。默认200/0与冷HASH仍关闭，
没有初始化、恢复、任意HDEL、退款或人工retry代次机制，不表示已启用付费。

沿既有`media_job_run`扫描轮次执行128槽有界维护，不增加interval。额度超限/不可用告警
在PG外写真实规则，非法参数只记本次受控事实，由PG外drain消化；队列最多64项，溢出仅安全日志。
duplicate/stale/默认关闭不冒充超限，不持久化正文、URL、凭据或异常。stop先禁新许可、取消准入，
等业务循环/消费者收尾，再关预算/自有Redis与告警；某项close失败仍独立清理并保留原失败。
ops不关闭借用transport、PG、队列或其他实例资源。本片仍SOURCE，实际类型/完整回归尚待独占验证。

## W2-10 品牌素材 callerTx 复制

`createStoreAssetCopyOwner` 显式装配既有 readStore/SLA/timers/Media.link 公口，只校验本域事实，不授予商家权限。
prepare 先持门店130、日历共享锁及全部未删除来源370，再选 content/brand_story；opaque plan 绑定实例、精确Tx及一次消费。
共同410后逐条真实link，同主体复制全部文件/肖像材料、标签及洞察，保留原处理和复核事实；失败整笔回滚。
未复核副本从新创建时间计算SLA并arm新timer，已复核副本无SLA；复制时不提交任务或外呼。
保留pending/processing意味着I11在15分钟后仍可真实汇合，不承诺永久零任务/费用。
SOURCE尚未执行新旧整叶、类型或独立审查；不是store.create HTTP、真实云或生产容量验收。

## 账本只读诊断（SOURCE）

ops inspector固定accepted的 `lyx:${appEnv}:model_budget:v1`，只读元字段与最多128个索引槽。
closedBefore是原deadline拒绝水位而非总开关；token不是当前PG许可、模型调用或账单凭证。
采样保留holes/hasMore及独立时钟/日界事实，不输出业务标识或正文，不证明整个HASH合法。
独立CLI导入/check零IO，inspect经现有环境口、PG外独占连接；异常/取消/迟到关闭并消费回复。
不修改ledger、owners、运行时或默认200/0；没有初始化/恢复/退款/维护/任意key覆盖功能。
新旧完整测试/类型与自有资源证据等待独占验证，真实运维、容量与E22仍未验。

## W3-06 文件恢复与彻删核心

`media.retention`提供六个后台接口的真实用例。写操作接收真实员工会话元信息与required幂等上下文；恢复/彻删跨两TX和外呼持同fileId专用sessionMutex，signal传存储原语。恢复结果未知或settle失败也按最终DB事实补回marker，已提交/后继恢复不撤销。彻删失败保留deleting，正式占用过期后同键接续。

彻删同时保护live引用、keepUntil、法定canRelease和各拥有者精准inUse；缺当前事实明确拒绝。删除提交后另TX按ZIP390→派生文件410升序执行hooks，实际media_info/cover沿原release保留30天。COS必须完整枚举精确key版本，Suspended也不遗漏；MinIO未声明版本恢复，明确unsupported。真实桶恢复/清扫/彻删均未验。


## W3-06 分步清扫

`media.retention.sweep`只接受真实job的signal/runTx，逐阶段独立小事务；失败记摘要及P2后继续下一阶段，观察租约/互斥失效立即中止。维护、候选清单和逐文件互斥分开，不嵌套sessionMutex；外呼传该作用域真实signal。每日北京时间03:00后由持久file_purge_run去重，候选最多5000，执行每轮最多100，list_only只提清单，auto超正式阈值/100原片/50 secure熔断held。每日候选还以media自有refs/24小时事实补偿缓存滞后，不能因每轮只修100缓存漏候选或提前done；不扩大run原candidateIds。批准后每文件持锁重算缓存并重新读四事实，3次guard中止，deletedCount和文件结果同TX。

每文件用公开三段式system幂等记录续作未知marker，仅本run/file的resumed接管deleting，不能冒领手工erase。对象调用或settle未知保留deleting和意图，下一轮按最终DB事实接续；aborted运行另限量复用同键证明旧意图，只恢复对象不继续删除或计数；幂等证据超过既有24小时被清理后宁告警/guard拒绝，不猜对象结果。此保证仅覆盖已观察失锁，不能即时撤销外部副作用或未观察的网络窗口。

删除和彻删消费各真实拥有者的精确fileId inUse，不用readColumns历史全表快照充当当前事实；漏接当前事实明确拒绝。OCR raw在本域按rawPurgeAt限量清除，fields/历史不删；需求日期经既有asset_feedback派生、T-0/asset_request.due持久去重，最新notifyScope和成员范围在投递时复核。I8另TX先ZIP390后文件410重试真实缓存/cover钩子，I13检查引用缓存并由sweep补偿。账号证明只在拥有者3年canRelease后沿原release加分类7天，其他法定证据不泛化释放。

本地6组清扫DB、3组精准引用、2组核心回归和1组真实worker装配已分轮通过；唯一独审及候选缓存遗漏点修闭环。
清单生成与执行均以真实引用/24小时事实补缓存滞后，执行严格限本run原候选，锁内再核全部守卫。
101文件仅测100批边界，未做生产容量结论。W3-08可消费实际六接口；批准仅代表approved，删除结果须重新读取。


## W4-04 异步银行回单技术前置

`enqueueBankReceiptOcr(tx, ctx, {fileId, entityId})`只在调用方事务内核实际stored/pay_receipt文件、
创建pending结果与原ocr/local任务；未配返回`{ocrResultId:null,status:unavailable}`，不造成功。
同文件/主体/版本的pending或ok结果复用；返回ok缓存后调用方立即read重算比对，不重发旧事件。
`readBankReceiptOcr(tx,{ocrResultId,fileId,entityId,mediaJobId?})`复核范围，只返回六字段及payerAccountMask、告警。
事件消费传mediaJobId时另核真实任务全部绑定、终态安全输出与当前文件版本；伪job/错结果返回null。
回单storeId固定null；识别字段/原响应只在ocr_result加密保存，原文沿30天清除计划。

原runner槽、租约、三次失败退避与期限保持，六秒有界取消包含签名准备和Provider请求。
收尾同TX保存结果并发已有`media.ocr.completed`；payload只含v/ocrResultId/fileId/entityId/mediaJobId/docType/status，
任务最终只留结果ID和状态。media不读写billing表，不自动确认收款；迟到凭证由billing绑定当前指针再裁剪。
唯一审查56.879秒、15叶首尾hash一致、P1/P2/D=0，后续三点核0阻断；services/API类型通过，
新增SDK1/DB1与旧执照最小协议1合并3/3G（另1旧例未选），总6.77秒，未重复历史矩阵。
首轮类型两处接线错误及未验边界记前置变更；真实云准确率/费用未验。
worker配置接线另由独立伴随合入，不能把本源码装配当预发部署。

### 无主体财务回单（W4-18）

后台 pay_receipt 未指定 entity/store 时，只允许当前本人、all 范围、finance.receipt.confirm 加 finance.refund.execute 或 finance.recon.resolve 且完成再次验证，派生本人 secure/platform 文件。拒绝代门店上传；invoice 仍要求主体。platform/pay_receipt 的后台元数据与签名读取同样限 all，包含原上传人降级为 own/group 的情况；消费退款/对账仍走各域状态及本人文件守卫，不放宽资金操作。两新增真实 DB 目标和原 billing-upload 相邻目标已通过；真实云未验。
