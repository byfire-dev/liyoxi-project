# delivery 交付生命周期与同事务暂停收尾

## W5-03 PR2 本地实现

PR1 公共 `AdminFlow.adminTransition` 已由 #208 合入 actual main（`e57f2619`）。本节描述本地 PR2 源码，验证仍进行中；PR2 尚未 actual main，PR3 order 对账尚未开工。W5-04/05/06 只有在完整 PR2 代码验收并 actual main 后才能消费，其他原下游仍等 W5-03 整包。

`createDeliveryM5(deps: DeliveryM5Deps)` 为本包十一条 HTTP 提供用例公口：`activityList`、`assignEditor`、`assignPublisher`、`forceTransition`、`reevaluate`、`reissueCreate`、`remind`、`rework`、`rescheduleLaunch`、`reissueCancel`、`reissuePublish`。只读入口接收真实员工上下文与范围；写入口接收身份、员工、资源、typed body 和既有幂等选项，返回实际 DTO 与 `replayed`。HTTP 只做 typed 输入、正式鉴权与响应投影；纠偏沿 PR1 中央再验证、确认、白名单和事务保存点，不接账本。

负责人通过显式指派变更。样片和剧集登记不再隐式写 `editor_id`；`assignEditor` / `assignPublisher` 在真实员工集合内复核启用角色，首次指派不写 `from_staff_id` 为空的改派记录，改派写真实来源和原因。范围以服务端上下文为准，选人下拉候选不替代授权。调用方准备制作前置时应先指派对应剪辑师，不依赖首次上传认领。

环节 SLA 使用注入时钟与既有工作日历，统一维护 `delivery_ticket_stage.due_at/sla_snapshot`、工单 `step_due_at` 与方案 `staff_due_at`。暂停保留第一原因加入时的剩余工作分钟，部分解除保留原快照，最后原因解除才恢复；日历导入重算当前有效环节，旧 timer 的截止、身份、快照或投递版本不符时跳过。正式 `delivery.onCalendarImported` 与原 `sla.breach × delivery_ticket_stage` 使用同一实现，纯商家提醒不创建 SLA timer。

`delivery.I2` 逐项检查暂停来源、集合与汇总并记录实际自愈；`delivery.I14` 检查补发集号及已发布补发与新包的工单、订单项和变更集一致性。补发发布继续消费真实制作事实和保存的通过质检记录，替换行齐全后才切换当前剧集、包和授权；不伪造媒体已检或恒零不变量。人工催办经 `manual_reminder.sent` 正式通知公口读取当前场景与真实商家收件人，重复投递去重、场景失效不通知。

M1 delivery 的 `flow.reevaluate_sweep` / `flow_reevaluate_sweep` 保持原唯一 worker 叶；M5 order 的 `flow.reconcile_sweep` / `flow_reconcile_sweep` 由 PR3 消费实际上游公口后实现，不重复计作 PR2 x01。十一条 typed 契约与 HTTP 测试、新生命周期 DB 测试、受影响旧夹具及生成对账的最终结果见 `docs/plan/status/W5-03.md`；未验项保持未验。

本片三个既有进度事件通过 delivery 的 keyed reader 接通知：补发发起重读当前启用剪辑师；补发发布重读当前有效补发包；改期重读当前订单项日期。通知只消费布尔有效性及安全投影，不直接查询这些业务表；同一个 scene 的重验按 `bizType` 精确选 reader，避免把补发通知重验成当前发布人的工单。商家 `m.order_progress` 沿原仅站内通道，人工催办与再次改期使用真实事件 id 区分合法新发生，并对同一事件重放去重。

通知小片前，调度已回传 HTTP 原 7/7、生命周期原 9/9 加 `early_end` 定点 1/1、stage-SLA 原 12/12 加日历窗口定点 1/1、production-actions 7/7、publish 6/6；取消暂停回归中原 timer 零假设改成完整快照后定点通过。此前 services/API 类型、分层、机器表、窄 ESLint 与格式检查通过。新增通知与跨日催办断言、通知小片后的最终类型及官方生成仍待验，以上本地结果不代表 CI 或 actual main。

## 既有取消暂停公口

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
`cancel_review/approval_request` 原因。返回原因集合及 `reevaluation` 完整求值锁图（含广告、活样片及在途发布审批/跟进/文件）；
上游须将该图的低位 staff/approval 与所有高位拥有者目标一起预锁。只解除指定取消原因，
不解除其他审批或 `plan_amendment`，不按取消申请 UUID 猜引用。

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

本地暂停窄前置验收：完整原/新 11 文件 DB132G（新45、原87），严格契约13G（新8、原5）；
必要类型、依赖、契约/注册与独占新库枚举对账通过，自有资源0。覆盖真实API/worker端口身份、
hold→release→阶段到点、相同/并行原因、同Tx未提交事实及回滚、双连接锁竞争和图变化整Tx拒绝。
原失败证据保留；本段等待唯一独审与本地合流，完整W2-10继续进行。

非 launch 的方案、样片和成片写入口先经 `lockReevaluationInputs` 锁住 drama140 与所有
当前广告150；方案包含草稿、当前及已确认快照的广告并集，父锁取得后复核目标未变。
取消暂停恢复的公开目标包含 `reevaluation` 完整图，包含其他账号在途审批及跟进/文件；
上游须将该图并入统一预锁，在修改审批事实前一次锁全。恢复在同事务缓存该图，后续求值
只复用已锁事实，不能在文件锁之后追加旧审批或广告。`plan_confirm` 的最后原因解除时，
环节 `dueAt`、工单 `stepDueAt` 与员工等待中的方案 `staffDueAt` 同步恢复。
