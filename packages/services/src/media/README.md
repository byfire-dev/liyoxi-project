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

制作上下文/留痕归 W1-16a；引用方逐表登记由各业务包完成。真实存储、STS、分块、全量执行循环及清扫归 G3-A，接手时删 promote 补偿扫描；图片审核归 M2，视频及其余审核归 M3。分类登记表后续只增开放类别与守卫，不在本包放开未来权限。
