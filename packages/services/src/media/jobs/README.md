# 统一媒体任务运输（W3-03，实施中）

数据库 `media_job` 是唯一事实源，Redis 队列只唤醒。任务采用正式 local/remote 两模式、20行领取上限、本机2/远端8并发、15秒扫描与45秒本机退出预算。预算定义在本目录 policy.ts；没有缩短正式期限以适配本机资源。

处理器按既有 kind 注入，当前业务输入须经该处理器严格校验。未知 kind、未接处理器及 `processed:false` 不能记成功。父对象先锁、任务其次、文件最后；结果与父汇合必须同事务，并由当前 state/attempt/leaseOwner/生产代次拒绝晚结果。

首个真实回归 `promote-lease.db.test.ts` 对现有 promote 调用证明旧30秒租约与正式五分钟租约的差异，并证明31秒后二次worker不能重领；使用隔离库与可释放假存储等待，不运行真实云。尚未运行的目标不列为通过。

这里只提供运输与后续 handler 接线，不声称 probe、转码、补标、ZIP 等13个未来业务处理器已完成；既有微信图片回执/35分钟兜底继续保留真实语义。完整上游/官方协议/必要伴随计划见调度交接，外部CI开通、模板、权限、回调到达和ProduceID法务仍未验。

扫描只等待真实短事务认领结束；IO仍登记在同一个inFlight集合，队列run等待完整执行、scanner的后台completion一律被捕获。后台收尾故障回滚，持久租约供原恢复策略接管。扫描的beat只在实际认领完成后更新，未改60秒watchdog或伪造执行期心跳。原stored断言在原数据库等待条件满足后判断，scan返回数不是已完成数。

第一轮完整新目标收集27项，25项绿；90秒硬超时与45秒关停的最后全局timer计数断言各红（实际取消/queued/attempt/预算均已通过），日志留存。真实pg-pool默认10秒idleTimeout归还连接后仍有借用pool计时器，本叶后续改精确追踪自己的90/45秒handles是否clear，不把借用计时器当成owned泄漏，也不删取消或时间边界断言。首次旧promote两项功能RED与此轮2RED分别记载，不能混为setup失败。

这两个case已按完整标题单独收集并通过，实际检查自己的90/45秒handles被清理；未重跑其余25个已绿case。CI与env首轮16项通过后补技术时长边界，当前CI15、worker4、API7及同步main950407后的旧ops13/登记反例1均已实际通过。signal参数位置、ignored Prisma客户端与公共CI出口的首次类型失败保留，按原工具及最小伴随修复。最终同步main1d67后的类型、剩余旧兼容、矩阵和门禁须以最终结果收口。

处理器的纯claims只判断任务是否归属（种类配置、subject/parent与固定dedupe），非归属拒领且不写任务；current复核当前文件状态、来源与业务仍需要，真正失效才取消。错误的retryable保留为持久人工重试事实；可选automaticRetry:false阻止自动queued。CI未处理结果使用这一区分，保留failed/isRetryable:true，不把processed:false当处理完成或自动再次外呼。原微信15项与最大尝试3的新扫描反例共16项、受影响的四条执行器并发/退避反例均已实际通过。

冻结的M1 promote队列保留真实升级兼容：worker仅将合法历史jobId转入canonical media_job，不启动第二执行器或扫描。无效引用拒绝，转发失败保留原队列重试；当前生产发布只用media_job。最后尾链真实Redis重复历史消息只产生attempt1与stored/file.stored各一次，五消费者关闭、转发失败传播、Worker类型及M0/M1四计数通过。原手机代理条件一项跳过单列，MinIO required16项与runtime4项实跑通过。根唯一正式审查、本地普通提交及合流尚待执行，不声称真实CI账户或未来handler已验。

独立审查两项P2已用真实PG反例先证实并定点修复：settle/expire在已有父锁与job锁下重新判断parent needed，handler.current不掩盖父失效；全局latest栈删除。API与worker各自media.I10/I11闭包绑定所属执行器，attach一次、close后固定拒绝，不能回退兄弟runtime。原runner17加两条父失效反例全19绿；双真实runtime隔离、API7/worker5和相关类型/lint/depcheck绿。正式审查只进行原一轮，修复交根精确闭环。
