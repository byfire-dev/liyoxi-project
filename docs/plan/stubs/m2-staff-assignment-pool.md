# 员工分配池与轮询

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | 员工按城市轮询、分配池维护与各来源在办量；涉及 staff.pickNext、admin.staff.list 的推荐与在办量 |
| 骨架里的做法 | `staff.pickNext(tx, pool, scopeKey)` 选池内工号最小的启用成员，取员工共享锁后复核；不看城市、当班，不读写游标。列表推荐同一候选，`withLoad=true` 返回 0 与空来源数组；池成员 M1 由演示种子给出。W1-16a PR1 的工单三个负责人在办来源（10 分组 第 2.1、5 节）尚未注册：实际 staff 公共入口没有在办来源端口，随 G2-A 接齐，当前不返回虚构在办量 |
| 登记的工作包 | W1-01b |
| 回补里程碑 | M2（G2-A） |
| 回补的工作包 | W2-03；城市与当班、游标轮询、真实已落地来源和原子移交 |
| 依据 | 开发计划 第 7.3 节“交付经理按城市轮询分配”；W1-01b 任务书 第 2、7 节；D3 第 6.3 节 |

W2-03 的城市命中与不限城市回退、客服当班、UUID 游标升序与回绕、同 TX 预准备重入均走真实员工与游标；只读推荐零游标写入。profile/order/delivery/publish/follow_up 的已落地在办量经 typed 公口取真实事实，发布专员由公开指派入口消费；禁用和改派在同 TX 持员工前置锁，再锁真实业务行。未实现的 M5 广告与 M7 客服来源由 W4-20/W2-31 后续登记，不注册恒零。

真实证据：[轮询与原子移交](../../../packages/services/src/staff/work-assignment.db.test.ts)、[跨域公开消费](../../../packages/services/src/testing/staff-publisher.db.test.ts)、[原轮询兼容](../../../packages/services/src/staff/management.db.test.ts)、[API](../../../apps/api/test/staff-full.test.ts)。原认证并发、受影响域回归及完整 13 项不变量零违规已验证；本地构建与门禁已通过，待独立审查/主线合流，详见 [本包状态](../status/W2-03.md)。
