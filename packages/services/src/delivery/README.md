# delivery 同事务取消暂停收尾

`readCancelReviewPauseTargets(tx, approvalRequestIds)` 只读，按审批 UUID 找到仍生效的
`cancel_review/approval_request` 原因。返回原因集合及 drama/order/item/ticket/plan/cover
完整锁图，不涉及其他审批或 `plan_amendment`，不按取消申请 UUID 猜引用。

调用者在写任何拥有者之前，先读取所有申请、所有拥有者的目标集合，按全局锁序与主键升序
锁住整体并集（含 approval_request 以及回调所需父行）。其后同一 Tx 调
`releaseCancelReviewPauses(tx, deps, ctx, { targets, releaseEvent })`；releaseEvent 仅为
`rejected/withdrawn/voided`。本函数重入既有锁并在预锁前后复核整个目标图，发现变化整笔失败，
调用者须重新读取并重试整个事务；不得在高序锁之后补一个新发现的低序对象。

每条原因经原 `ticket.resume` 同状态迁移写历史、审计及严格 `ticket.resumed` 事件，随后标记
原因已解除。部分解除只减计数，保留暂停起点、剩余分钟、其他原因与环节。最后原因解除才按
当时工作日历恢复剩余工作分钟，保留原策略/数值/单位，仅更新计算时间与日历批次，累计一次
暂停工作分钟；无员工时限则不造 timer，0 分钟保持立即到期语义。历史超期标记不清除。

全部对象预锁后才逐工单调用原 `reevaluate`；订单重推导仍走原 orderSide 端口，媒体封面仍走
原 media.link，旧阶段被推进则取消其 SLA timer。任何下游失败都会回滚原因、汇总、阶段、
timer、历史、事件及接收方写入。未被原 timers.arm 规则登记为 scheduled 的时钟拒绝提交，
不把已 skipped 的旧语义目标称为完成恢复，也不修改 timer 通用重设规则。

API 与 worker 在 ops 装配层固定包装现有唯一 `sla.breach`：仅 delivery_ticket_stage
交给 delivery 的真实处理器，其他主体原样交给原 staff/approval 组合。到点在父 ticket 锁下
重验当前未完环节、未暂停、deadline、策略快照与 timer 身份，原子标记超期并发严格
`ticket.sla_breached`；过时投递不产生副作用。没有新增通用注册机制或旧 sample/launch
纯提醒 timer。此出口没有取消提交/执行 producer；W2-10 主体关闭与正式取消类型尚未完成。
