# 交付环节时限

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | 环节 due_at、sla_snapshot、工单 step_due_at、方案 staff_due_at 与超时定时器 |
| 骨架里的做法 | delivery/machines.ts 写真实进入/完成环节与历史；上述时限留空，不登记 sla.breach。delivery_target_at 按实际参数和开工 Tf 工作日计算，已有实现 |
| 登记的工作包 | W1-16a PR1 |
| 回补里程碑 | M5（G5-A） |
| 回补的工作包 | W5-03 PR2（#211 发布登记预留，待 CI/actual main） |
| 依据 | W1-16a 第 5、7 节及第 10 节第 10 项；10 分组 第 2.2 节 |

W5-03 PR1 #208（`e57f2619`）已 actual main，但不回补本桩。本地 PR2 已补环节 `due_at/sla_snapshot`、工单 `step_due_at`、方案 `staff_due_at` 与原 `sla.breach × delivery_ticket_stage` 接线；注入时钟按工作分钟和实际日历计算，暂停全部解除才恢复剩余分钟，日历导入重算当前有效环节。旧投递必须重新核对当前环节、截止、timer 身份和快照，不将商家纯提醒变成定时器。

本地统一验证：真实 HTTP 10/10、取消暂停恢复/持有和制作动作 63/63、环节 SLA 14/14、发布回归 6/6；生命周期原 9/9，`early_end` 与真实广告全链各定点 1/1。actual W5-02 合流后，真实带广告的公开 create→withdraw 新定点 1/1（14 旧例未重复）、批准/撤回/执行 HTTP 3/3，核对原环节、三时限、60 分钟、timer、资金和 placement。唯一独审的 1 P1 / 2 P2 已实施定点修复并由上述断言核对，保留原发现。

后台权限 golden 正式回放 4/4，仅增本片 11 行；官方契约/登记/计划/状态检查通过，669 项 = 444 typed + 220 meta-only + 5 registry-only，x01 114 行无差异。兼容检查 exit 0 但本地无在役可比快照，实际比较 0 份。最终 services/API/contract 三包类型通过，分层检查 4569 modules、0 violations；精确 inventory 契约定点 4/4（39 skip）、主干合流后通知与跨日催办四定点 4/4（6 skip）。

本桩随 PR2 源码回填“已回补”，发布登记预留 #211，待 ROOT 提交发布、CI 与 actual main；本地回填不放行下游。PR1 #208 / `e57f2619` 已实际合入，PR3 尚未开工，W5-03 整包保持进行中。
