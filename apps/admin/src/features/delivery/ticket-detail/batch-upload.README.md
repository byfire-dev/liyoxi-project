# TicketDetail 批量成片上传

W3-02 在既有“登记成片”弹层内选择多个视频、读取服务器集号匹配、确认顺序建议及逐文件上传。样片仍走原单文件路径。八个批次接口的 typed 客户端可供 W3-12 原片界面消费；当前成片界面使用交付 `episode-outputs` 的 `uploadBatchId` 分支，绝不调用原片 `commit`。

服务器 `expectedCount`、`coverage`、`counts`、`state` 和当前工单 actions 是唯一业务事实。选了几个文件不会缩小剧目总集数。AI 声明在建批时提交，服务器补充声明员工、声明时刻及剧目强制事实。页面展示原/新时长、体检拒收、差异警告；部分集才能跳过，替换后只使用服务器新条目的 fileId/key。

每批三个文件，每文件四个 8 MiB 分片。凭据只在弹层内存中，整批续签单飞；目标必须为本批 `incoming/b{uploadBatchId}/` 下的真实对象键。文件直传并入库 100% 与批次体检 ready 分开；批次每 2 秒读一次，最多 1800 次，读取失败或预算耗尽暂停并可手动刷新，ready/committed/canceled/expired 停止。关闭弹层解除订阅、停止 timer、取消 API/云请求；不隐式取消 uploading/verifying 批次。较晚旧 GET 不覆盖较新的修改或另一个弹层 scope。

刷新后从实际 `openUploadBatches` 找回批次，使用者重新选择名称和大小一致且未经修改的原始文件。适配器恢复入口接收服务器窄技术 grant，不补造 FileRegistration 的状态、clientToken 或额度。COS ListMultipartUploads 仅查询服务器声明的精确批次前缀，响应内只接收精确对象 key，最多 10 页、每页 1000 项、响应 64 KiB；唯一精确候选才能 ListParts，校验分片编号、大小、ETag，仅补缺块。多个候选、越界响应及无法确认的结果停止。pending 文件没有原上传记录时返回 `resume_unknown`；目前不能区分尚未开始与未知 Complete，必须替换得到新 fileId/key 后重传，不能盲目 Init 覆盖对象。已入库或正在入库的条目不会再次 PUT。

排队文件开始上传前再次核对当前服务器 DTO 的批次、条目、fileId/key 与 pending 状态；已被替换或跳过的排队项不会再上传旧 key。这个检查不撤销已经在途的合法分片，最终确认仍由服务器即时校验归属与状态。

当前测试使用虚构服务端 DTO、原中央客户端及受控 COS 假 HTTP；不包含真实云凭据、外部上传或平台到达结论。完整 W3-02 的 20 集实际 worker→体检→ready→交付消费证据由同包集成验收提供；本叶不能用 fixture ready 计作该全链通过。

本包私有完整 live 入口为 `node apps/admin/scripts/live-output-batch.mjs --video <已验证的合法标准视频.mp4> --resume-video <已验证且大于8MiB的合法视频.mp4>`。它建立本轮测试库/Redis 前缀，使用生产 handlers 和完整 middleware；只在 Provider HTTP 边界接本机假 COS，实际分片拼接写同 scope 的 FakeStorage，旧样片与签读保存保留真实本机 MinIO。旧制作 live 的两个成片改走真实批次，原 QC、包质检与样片保存断言保留；新 case 核服务器 20 集、人工顺序、实际已存 part 的跨刷新恢复、真实体检 ready 和交付消费。通用 live 脚本没有这个边界，不能把其默认运行与本私有入口混称。这里是验收源与装配设计，实际 W3-04 处理器、合法媒体、完整 live 结果仍待同包集成后记录；没有直接写 mediaInfo/check/ready 的支撑。
