# W2-27：九规则运行手册按实际入口补齐

| 项 | 内容 |
| --- | --- |
| 改了什么 | 补验收8指定九规则的现象、先看、判断、处置、不要做、升级、事后七栏；修check-env必需标签，核对表跟随server-errors角色及真实外验待办。 |
| 原因 | 代码子片已本地交付，原处置表仍待填；D7中的通用CLI名称并未全部实现，手册不能指导运维执行不存在的命令。 |
| 影响的包 | W2-27、W2-29；仅runbook/checklist与本包task/status/change文档，不改代码、权限、流程恢复或节点命令。 |
| 类别 | 顺序 |
| PR | 本地codex/w2-27-runbook-operations；正常提交后交ROOT唯一内容审查。 |

核现有node-step的status/logs/log-stats/check-env及参数、流程运维页的单dead投递/failed timer恢复、alerts-ack三子命令和生产probe/租约/周期登记事实。表中明确无通用重投/历史补跑/全局resume CLI，Redis内存仍须独立云/节点监控，不用ping成功冒认容量健康。

只做人工对表、所属格式/diff及status/plan检查，不重复业务类型、测试、镜像构建或独审。真实SaaS/E18/DNS、云监控/外部拨测及预发演练仍未验，W2-27保持进行中；已有性能RED和历史失败不删改。
