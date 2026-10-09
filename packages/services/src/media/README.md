# media 文件最小集（W1-07）

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
