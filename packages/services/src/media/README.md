# media 文件最小集（W1-07）

M1 只开放 MinIO 预签名表单的小文件通道。服务入口是 `createMedia`，API 用进程运行时的 `media`，worker 用 `promoteFile` / `scanPromote`；对象存储的调用全部在事务外，队列只负责唤醒，`media_job` 是任务事实源。

## 1. 上传与入库

`register(actor, input, { idem })` 先判类别与归属，再按扩展名推规范 MIME、核对分类上限，忽略客户端 MIME。商家一次 1–9 个，后台一次一个；批内任一不合格，整批无新增。商家开放档案三类、两类证照、回单与账号截图，按能力点判权；M1 这七类都不允许店员登记。已停用门店的老板仍能上传回单。后台海报需要短剧库编辑等级；样片、成片没有分类守卫即拒绝，其余后台分类按 M1 边界关闭。

相同上传人、分类、归属、clientToken 和大小的 pending 登记复用。冻结索引 `uq_file_object_client_token_noscope` 未含 entity_id：同一上传人跨主体使用同 token 时返回 `VALIDATION_FAILED`，字段 files.N.clientToken 提示重新生成，绝不返回另一主体的凭证。相同主体在不同门店的主体级文件可以复用；门店级文件按门店各有一行。此边界移交后续结构包，不修改冻结 schema。

登记有效 24 小时，表单有效 10 分钟；`refresh` 重新签表单，不写 sts_issued。refresh 与后台 downloadUrls 的路由都是 idem:none，事务只标记上下文已用，不存中间 FileRow。过期登记仍留 pending，清扫归 M3。

`complete` 是三段式：锁 file_object，写 30 秒确认标记；事务外 HEAD 与最多 4KB 的文件头校验，绑定 etag；事务二按确认标记条件推进 promoting，并同时插入去重任务 promote:fileId 与 file.uploaded。不存在的对象清标记后返回 UPLOAD_NOT_FOUND，同幂等键可补传重试；大小优先于文件头判据，不合格持久化 rejected 与 file.rejected，再返回 UPLOAD_REJECTED。已确认不再重复建任务。幂等结果存完整 JSON 视图：商家 FileStatusView，后台 AdminFileView；首请求最多轮询 3 秒取得较新状态，重放仍返回事务二保存的 promoting 快照。

worker 的 promote 并发为 2，锁序是 media_job(400) → file_object(410)。领取时推进 attemptNo 并写 30 秒租约；事务外按 incoming etag 条件复制，改写规范 MIME 与 attachment，再核对正式区大小/etag。收尾只接受当前 attemptNo、leaseOwner 且未到期的租约，成功写 stored 与 file.stored，偷换/核对不符写 rejected，暂时故障在最大尝试与期限内重试。消费者每 30 秒重唤醒超时 queued 与过期 running，属于消费者生命周期，不另登记领域循环。

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

制作上下文/留痕归 W1-16a；引用方逐表登记由各业务包完成。真实存储、STS、分块、全量执行循环及清扫归 G3-A，接手时删 promote 补偿扫描；图片审核的微信窄接线见下节，视频及其余审核归 M3。分类登记表后续只增开放类别与守卫，不在本包放开未来权限。

## 5. 微信图片审核（W2-21 窄接线）

注入 `wechatImage` 后，原 promote 成功事务为 weapp 商家上传的 profile_image/profile_promo/store_asset/channel_screenshot/ticket_attachment JPG/PNG（不超过 5 MiB）创建唯一 audit_image_wx 任务并置 pending。任务仍由原 promote 队列与补偿扫描执行；锁序保持 media_job(400) → file_object(410)，签读 URL 和 Provider 外呼均在短事务之外。领取只接受同 AppID、最近两小时身份公口的真实结果；没有身份/配置或提交未获 pending+traceId 时转入唯一 CI fallback 任务。

WX 提交先持久化 submitting/attempt/租约，结果仅由同 attempt/lease 收尾为 submitted；35 分钟未完成或提交租约过期转 CI，避免未知外呼结果重复提交。CI 只在既有 MediaProvider.audit 明确 processed:true 且 pass/review/block 时关闭任务；当前 local processed:false 或不可用会持久化受控失败，文件仍 pending。此实现没有宣称 CI 云驱动已经可用。

公开 `applyWechatImageResult(tx,{traceId,result:{suggest,label},receivedAt},ctx)` 使用注入 clock 写 decidedAt；risky 保存原来源结果并映射文件 block。未知/尚未提交 trace 返回 BUSY，由原 webhook inbox 重试预算承接，不吞成 ignored；终态重复、超时后的回调、退役文件与对象键不匹配均不得覆盖文件。pending/review 仍遵循既有引用与签读规则，block 继续由原 refs/sign 守卫拒绝。未新增通用审核流水线或状态历史机制。

本叶验证使用真实隔离 PostgreSQL 与受统一 TX 外呼守卫约束的假 Storage/Wechat/Media，覆盖生产 promote 触发、并发领取、三种回调、提前回调重试、旧尝试、退役/错对象、超时与 CI processed:false；未调用真实微信或 CI。进程/worker 的配置、最近身份注入、来源 handler 与关闭生命周期由中央装配接管。

## 6. W3-01 分块登记、续签与取消

支持 STS 的 StorageProvider 对>20MiB登记选择 multipart：8MiB分块、块并发4、每文件前缀30分钟短授权；无能力仍是原post，不伪造STS。首次STS占1次，实际续签先在短TX内按原 file_object 锁顺序复核本人、scope、pending、确认租约及24小时上传期限，并原子预扣（最多30）；随后TX外调用，返回前短TX再做 fresh 复核。确定 rejected/unconfigured/unsupported 未签发才退本次1；网络/5xx/未知结果或崩溃保守保留占用，不声称官方已签发30次。成功签发后状态改变不退预算，也不给客户端凭据；凭据不进数据库/幂等结果/日志。

后台新增恰 `admin.file.refreshCredentials`（none、no-store）和 `admin.file.cancel`（required）。取消仅本人staff登记，确认中拒绝；pending→expired，同意图重放不重复中止，无取消业务事件/审计。提交后尽力中止本file确切incoming key的未完成分块，不扩大权限；旧MinIO post取消仍走原删除。微信图片审核接线、扫描及promote补偿循环保留，W3-03接手统一循环后才删除30秒补偿扫描。

complete仍是原三段式，在TX外读取HEAD/4KiB头、核声明大小与真实类型/ETag；服务端可选CRC写incomingCrc64。条件copy后正式HEAD必须与大小、copy ETag及确认CRC一致才stored；不相信端侧“上传成功”或客户端CRC。冻结构noscope唯一索引未带entity_id保持原拒绝策略，同actor/token跨主体仍VALIDATION_FAILED；没有本包DDL，独立结构包再评估。

公开后台 `createMultipartUploadAdapter` + `createAdminMultipartUploadPorts` 供后续批量页调用现typed中央API，不改通用UploadField：文件并发3/块4，失败保留UploadId/clientToken，ListParts恢复仅补缺块，STS按服务端到期时间单飞续签；取消/close用generation+AbortSignal丢弃晚进度。Complete/Cancel同意图key只在File的WeakMap会话中保留；不使用localStorage/sessionStorage、不打印密钥；成功释放会话。若同内存会话实际尝试Complete后响应未知，仅ListParts404+唯一NoSuchUpload才进入现有业务确认，最终由服务端检查决定；未Complete/一般云错不得绕过。不新建UploadId，不假云成功。外部CORS需允许Authorization/x-cos-security-token并暴露ETag，E4未验证。

本地新增真实库反例覆盖额度并发、确定失败返还/未知占用、成功签发后取消、确认租约、scope、服务端CRC；新API走原鉴权/Origin/限流/幂等全管线。真实云、历史版本操作、GB压测及未来批次页面未宣称完成。
