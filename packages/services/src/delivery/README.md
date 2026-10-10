# delivery 同事务取消暂停收尾

`readCancelReviewHoldTargets(tx, assembly, approvalRequestId)` 零锁零写，经现有 orderSide
端口读取真实取消申请、明细与审批关联，再读取选中订单项的工单、当前阶段与暂停原因。
调用者必须先读取所有拥有者的图，预锁 approval30/request50/line60/entity100/store130/
drama140/order160/item170/ticket180 及其他拥有者所需完整并集；然后同 Tx 调用
`holdCancelReviewPauses(tx, deps, ctx, targets)`。图变化须重试整个事务，不能补低序锁。
首次原因要求真实 pending 审批及原提交身份，approved 只可重放已有 active 同一原因；
关闭、解除过的原因不得复活。仅暂停第 1–9 步，已上线等后续步骤不加入新原因。
第一条原因记暂停起点和剩余工作分钟（无时限 null、已到期 0），叠加原因保留原快照；
同状态 ticket.hold 写历史、审计、严格 ticket.held 与同 UPDATE 汇总，仅取消当前阶段的
sla.breach，不改策略快照或其他 timer。重放零写，所有副作用均随外层事务回滚。
新增端口方法缺拥有者时抛 INTERNAL；正式 API/worker 必须绑定 order 同源只读实现。

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
