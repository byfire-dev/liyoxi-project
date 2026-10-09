# TicketDetail 批量成片上传

W3-02 在既有“登记成片”弹层内选择多个视频、读取服务器集号匹配、确认顺序建议及逐文件上传。样片仍走原单文件路径。八个批次接口的 typed 客户端可供 W3-12 原片界面消费；当前成片界面使用交付 `episode-outputs` 的 `uploadBatchId` 分支，绝不调用原片 `commit`。

服务器 `expectedCount`、`coverage`、`counts`、`state` 和当前工单 actions 是唯一业务事实。选了几个文件不会缩小剧目总集数。AI 声明在建批时提交，服务器补充声明员工、声明时刻及剧目强制事实。页面展示原/新时长、体检拒收、差异警告；部分集才能跳过，替换后只使用服务器新条目的 fileId/key。

每批最多三个文件进行直传，每文件四个 8 MiB 分片。实际云传输和服务端 complete 确认完成后释放直传名额；promoting 的入库等待继续使用原单文件适配器真实查询，不阻塞后续文件的直传，不改写文件或批次 ready。凭据只在弹层内存中，整批续签单飞；目标必须为本批 `incoming/b{uploadBatchId}/` 下的真实对象键。文件直传并入库 100% 与批次体检 ready 分开；批次每 2 秒读一次，最多 1800 次，读取失败或预算耗尽暂停并可手动刷新，ready/committed/canceled/expired 停止。关闭弹层解除订阅、停止 timer、取消 API/云请求；不隐式取消 uploading/verifying 批次。较晚旧 GET 不覆盖较新的修改或另一个弹层 scope。

刷新后从实际 `openUploadBatches` 找回批次，使用者重新选择名称和大小一致且未经修改的原始文件。适配器恢复入口接收服务器窄技术 grant，不补造 FileRegistration 的状态、clientToken 或额度。COS ListMultipartUploads 仅查询服务器声明的精确批次前缀，响应内只接收精确对象 key，最多 10 页、每页 1000 项、响应 64 KiB；唯一精确候选才能 ListParts，校验分片编号、大小、ETag，仅补缺块。多个候选、越界响应及无法确认的结果停止。pending 文件没有原上传记录时返回 `resume_unknown`；目前不能区分尚未开始与未知 Complete，必须替换得到新 fileId/key 后重传，不能盲目 Init 覆盖对象。已入库或正在入库的条目不会再次 PUT。

排队文件开始上传前再次核对当前服务器 DTO 的批次、条目、fileId/key 与 pending 状态；已被替换或跳过的排队项不会再上传旧 key。这个检查不撤销已经在途的合法分片，最终确认仍由服务器即时校验归属与状态。

当前测试使用虚构服务端 DTO、原中央客户端及受控 COS 假 HTTP；不包含真实云凭据、外部上传或平台到达结论。完整 W3-02 的 20 集实际 worker→体检→ready→交付消费证据由同包集成验收提供；本叶不能用 fixture ready 计作该全链通过。

本包私有完整 live 入口为 `node apps/admin/scripts/live-output-batch.mjs --video <已验证的合法标准视频.mp4> --resume-video <已验证且大于20MiB的合法视频.mp4> --probe-facts </tmp/lyx-w302-generated-manifest.json> --mediatool-image <sha256:image-id>`。它建立本轮测试库/Redis 前缀，使用生产 handlers 和完整 middleware；只在 Provider HTTP 边界接本机假 COS，实际分片拼接写同 scope 的 FakeStorage，旧样片与签读保存保留真实本机 MinIO。旧制作 live 的两个成片改走真实批次，原 QC、包质检与样片保存断言保留；新 case 核服务器 20 集、人工顺序、实际已存 part 的跨刷新恢复、真实体检 ready 和交付消费。通用 `pnpm admin:e2e:live` 现在同进程委托此完整入口；缺省自动准备固定镜像和两份真实合法输入，也可显式复用下述四参数。默认保留所有新旧用例；受影响重跑不能混称完整集合。Actual W3-04 assembly, legal media and the real 20-episode path have now passed; initial failures and segmented browser results are recorded in W3-02 status. This support never writes final mediaInfo/check/job/ready facts directly.


私有验收的两份成片必须真实满足 20 秒≤时长<20分钟、9:16且至少720×1280、H.264 High/Main、单条AAC音轨；续传片真实大于20MiB，跨过既有multipart阈值；真实编码字节不得padding，8MiB分片/四分片并发不变。`--probe-facts` consumes the actual generation manifest `results` (name/size/sha256), plus the two sibling `<name>.probe-report.json` raw `report` files. The runner verifies real bytes and projects the input through the public testing adapter. These are already-existing input-master facts; no final file/job/check/ready is directly seeded.

The default entry still runs all original live specs. An affected rerun may select only `--test-file test/e2e/live-output-batch.spec.ts`, keeping its original live-auth dependency. Whole-batch selection uses 20 exact-byte hardlink paths in the owned 0700 temporary directory, preserving quantity and hashes while avoiding Playwright's 50MB buffer limit. The real Node server uses the existing tsx loader and receives one SIGTERM for its original cleanup chain; the unchanged 10s fallback remains. Actual segmented results and initial failures are recorded in W3-02 status; the current 20-episode path has passed. Cloud/platform verification remains separate.

旧single sample的17947字节、1秒及签读/保存证据保留原无production工具的Runtime；批次八接口使用独立配置实际W304工具的Runtime。两者借同一本机对象存储但各自拥有业务装配；私有pump仅按本轮两个真实target的batch文件查due jobId，再经原`media.promote({jobId})`执行全部正式租约/守卫/收尾，每15秒一轮、每轮最多原20个due IDs且每2个一组等真实执行完成，从不调用全库scan/busy-scan、不推进业务时钟或放宽60秒ready断言。旧两集成片时长投影使用真实20秒夹具探测值，其余QC/包/保存断言不变。W304实际public工具未装配时私有server明确拒绝启动，不能将仅写好验收源称完整链路已过。派生任务归属仍须上游actualmain接线时核对。

母片提交只发正式`drama.masters_changed`事件；未来W3-09拥有`content.onMastersChanged`回填消费者。本包输入fixture可据真实已存在母片时长补其episode输入，不在生产提前实现未来subscriber。
