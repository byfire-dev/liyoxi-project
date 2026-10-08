# W2-18 接收先交付、分区能力后接入

| 项 | 内容 |
| --- | --- |
| 改了什么 | W2-18 按交付顺序预拆为接收与客户端接线 PR1、分区任务与重分区命令 PR2；原工作包范围、归属与 M2 退出条件保持不变 |
| 原因 | 接收能力可独立验收；受限分区和重分区依赖独立数据库能力先合流，常驻 worker 不使用迁移账号 |
| 影响的包 | W2-18；独立数据库能力先于 W2-18 PR2，真实渠道验证仍由 W2-27 承接 |
| 类别 | 顺序 |
| PR | —（本地候选与集成记录，尚无远端 PR） |

2026-10-08调度裁定的小幅预拆。原任务范围、4HTTP/3x01、外部验证及M2退出条件不减少，W2-18整体保持进行中。

实际main的普通invoker `lyx_14_analytics_event_ensure_partition(date)`没有受限运行能力；app角色刻意不能CREATE public，也没有完整月重分区能力。ADR-0045要求独立数据库能力，不能让常驻worker拿迁移账号口令。首版之后结构/授权变更必须独立PR，不能随业务包隐性修改或消费未合分支。

| 分段 | 范围 | 实际依赖/退出条件 |
| --- | --- | --- |
| PR1 | 4HTTP、登录后真实subscribePlan与参数、两端中央request接线/错误信封转发、10事件DML接收/跨月去重、analytics.dedup_purge真实job、两桩回补 | W1-04/W1-05/W0-24已实际合流；隔离库/假HTTP本地验收、独立审查与原CI/main条件 |
| PR2 | analytics.partitions、analytics_repartition薄CLI、受限预建/完整重分区与相关CLI/重复并发验收 | 独立最小DB能力先actualmain；服务再按注入clock+实际retention_months限制合法月份，不能先调用未合函数 |

错误平台DSN/项目、真实微信订阅模板/授权及网关限量由W2-27获授权后实测。本地mock和202受理不称外部到达。现GitHub403不能push/PR/CI，预拆为了先冻结可独立审查的PR1，不冒称actualmain能力已满足。
