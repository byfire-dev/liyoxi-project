# 交付环节时限

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | 环节 due_at、sla_snapshot、工单 step_due_at、方案 staff_due_at 与超时定时器 |
| 骨架里的做法 | delivery/machines.ts 写真实进入/完成环节与历史；上述时限留空，不登记 sla.breach。delivery_target_at 按实际参数和开工 Tf 工作日计算，已有实现 |
| 登记的工作包 | W1-16a PR1 |
| 回补里程碑 | M5（G5-A） |
| 回补的工作包 | G5-A |
| 依据 | W1-16a 第 5、7 节及第 10 节第 10 项；10 分组 第 2.2 节 |
