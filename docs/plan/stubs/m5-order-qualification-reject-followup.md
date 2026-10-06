# 资质驳回后的订剧后续

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | 非终局驳回的 order.rejected_stale 与终局驳回的整店 qualification_cancel |
| 骨架里的做法 | W1-17b 的关键订阅者按当前资质事实仅把待开工、无在途取消单改 qualification_rejected；不登记 rejected_stale 定时器、不创建取消申请。迟到 approved 不越过当前驳回结论 |
| 登记的工作包 | W1-17b |
| 回补里程碑 | M5（G5-A） |
| 回补的工作包 | G5-A 的售后与资质驳回流程 |
| 依据 | W1-17 第 7、10.6 节；x01 第 2.5 节 order.onQualificationDecided；D3 第 6.1 节 |
