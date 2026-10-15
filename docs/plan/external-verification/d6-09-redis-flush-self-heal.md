# D6 第 9 项 清空预发 Redis 后的自愈

| 项 | 内容 |
| --- | --- |
| 编号 | D6 第 9 项 |
| 来源 | [计划](../../08-development-plan.md) 第 8.6 节表二；[D6](../../appendix/design/d6-notify-docs-data.md) 第 12 节 PoC 第 9 项 |
| 验证什么 | 清空预发 Redis 后通知、渲染、导出、周期任务的自愈 |
| 通过标准 | 各自恢复，周期任务照常触发 |
| 依赖的业主事项 | 预发环境（E1–E4）（推） |
| 谁来做 | 各里程碑的预发演示 |
| 最晚关闭点 | M2、M5、M7 各验自己的部分 |
| 不通过的退路 | D6 第 12 节未写退路 |
| 状态 | 未开始 |
| 结论 |  |
| 证据 |  |
| 关闭日期 |  |

业主事项的状态见 [业主清单](../owner-checklist.md)。填写规则见 [README](README.md)。

## 执行方法与当前边界

待业主批准真实预发演练窗口后执行，当前仍未开始。先确认本项目实际Compose项目名、六容器健康、PostgreSQL可用与当前worker身份，记录同容器ID/PID/启动时间、RestartCount、worker_lease持有者/acquiredAt/heartbeatAt，以及真实服务产生并已提交的待处理事件、到点任务ID。明确 `LYX_REDIS_FLUSH_ENABLED=true` 且 `STG_FREEZE=false` 后，仅执行 `infra/deploy/node-step.sh redis-flush <本节点项目>`；它核配置来源与容器身份，只清目标DB0，禁止手工对共享开发Redis执行FLUSHALL或删卷。

清空后不重启worker，120秒内分别核同PID、同主租约且心跳前进、全部非空实际subscriber投递完成、目标timer真实fired并有结果。记录清空/完成时间和实际结果；任一缺失不得记通过，随后关闭演练开关。通知、渲染、导出仍由所属里程碑补足各自证据。

`pnpm stg:rehearse --redis-flush --without-image-smoke` 是随机自有六容器、假密钥和正式服务端口的本机检查，默认不启用清空、不接真实预发；输出脱敏 `redis-recovery.json`。本地检查不能替代本项真实预发验收。
