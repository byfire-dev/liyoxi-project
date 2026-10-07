# V18 账务测试全绿

| 项 | 内容 |
| --- | --- |
| 编号 | V18 |
| 来源 | [计划](../../08-development-plan.md) 第 8.6 节表一；[05](../../05-risks-and-open-issues.md) 第 5 节 V18 |
| 验证什么 | 账务并发测试与性质测试在真实数据库上全绿 |
| 通过标准 | 通过 |
| 依赖的业主事项 | 无 |
| 谁来做 | W1-10、W1-11a 起；M4 全量 |
| 最晚关闭点 | M4 退出；M8 复核 |
| 不通过的退路 | — |
| 状态 | 进行中 |
| 结论 | M1 的真实数据库账本模型/冻结并发、账户锁、入账只履约一次与保存点故障测试已由 W1-10/W1-11a 完成；W1-21 集成链另核实际积分与 full 不变量。M4 全量账务与 M8 复核尚未完成，本项保留进行中。 |
| 证据 | [W1-10 CI](https://github.com/byfire-dev/liyoxi-project/actions/runs/37411348227)、[W1-11a CI](https://github.com/byfire-dev/liyoxi-project/actions/runs/37421442684)；模型/并发及保存点目标路径见 [M1 回顾](../retro/m1.md) 第 2 节 |
| 关闭日期 |  |

业主事项的状态见 [业主清单](../owner-checklist.md)。填写规则见 [README](README.md)。
