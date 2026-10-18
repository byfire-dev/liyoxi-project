# 流程运维（W2-23）

运行时通过`Runtime.flowOps`提供七接口的查询/人工恢复，`Runtime.alertActions.runCli`提供三个受限命令。依据a01第2.20、3.77–3.83节，01分组第2.3–2.5节，15分组第2.1/2.3节。

- 读权限为system模块view或flow.ops.view，写权限为flow.ops.manage。返回的actions同时取决于真实运输状态与写权限；不改变业务到期时刻或业务状态。
- timer与outbox_delivery按AdminPage分页，webhook按receivedAt/id递减keyset分页；同一时间的边界由id稳定排序。webhook totalApprox最多读取10000个匹配id，近似总数不替代hasMore/nextCursor。
- 人工恢复仅允许failed timer→scheduled/cancelled、dead delivery→retry、dead webhook→received。对固定目标行加锁后复验；不新增订阅者、不重发业务事件、不重新发webhook.received。
- required HTTP幂等上下文交原TxRunner，目标变更与审计同事务，重放不再次执行。未命中目标404，非允许状态409；CLI也对同一目标串行。
- CLI在同一事务加载active员工/当前角色与权限，不虚构会话或step-up；ack/close需sys.health.manage，reset-webhook需flow.ops.manage。三个动作都需要5–200字note，HTTP可选note不加强。
- 告警只允许open→acked、open/acked→resolved，保留指纹/首次时刻/通知计数；人工关闭不发恢复通知。后续×4重复通知间隔由W2-24求值器消费acked状态，本包未验证真实通知。

安全响应只投影正式认识的字段：timer仅接受完整严格SLA快照，未知payload/result返回null；支付回调仅接受严格支付摘要，其他来源未知summary返回null。任意额外字段使该摘要整体拒绝，密文与openid不返回。错误只保留固定错误类别，原始消息隐去。出站列表只有事件元信息，没有载荷。

目标数据库测试用原scanner/claim/run/consume，验证失败耗尽后的恢复和恰好一次消费；受控模拟audit INSERT失败确认整个事务回滚。API目标测试走真实后台鉴权、Origin、required与admin.global限流。权限矩阵测试的空壳只证明声明层；真实OR权限由flow-ops API/DB测试证明。

无新依赖、DDL、锁序或流程机制。媒体任务页签与接口交W3-08，未接入前不显示按钮。CLI产物、后台真实浏览器、正式独审/远端CI与main合流以W2-23台账及调度结果为准。
