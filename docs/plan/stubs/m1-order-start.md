# 订剧开工定时器处理器

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | order.start 的业务 handler、两关键订阅者与补偿扫描（已回补） |
| 骨架里的做法 | W1-17b 登记 critical/rearmAfterSkip 处理器；真实 capture、经理指派、createTickets、历史/审计/事件同事务。下单与资质决定仅 arm；每 5 分钟补偿缺失/failed/skipped 并逐命中 P3，不直接开工。两个组合根绑定实际公开函数，独立 worker relay/dispatch/consume/runTimer 与关闭解绑验收通过 |
| 登记的工作包 | W1-15a |
| 回补里程碑 | M1 |
| 回补的工作包 | W1-17b |
| 依据 | W1-15 第 7、10 节；计划 第 7.3 节留桩清单；m04 第 2.4–2.9、3.15 节；x01 第 3.10、4.1 节 |

20 轮三独立连接/真实 PID 栅栏并发与扣减后提交前 SIGKILL 回滚、同消息重试验收均通过。非终局驳回的 rejected_stale 与终局整店取消仍见 [M5 后续](m5-order-qualification-reject-followup.md)，不是本处理器已实现的行为。
