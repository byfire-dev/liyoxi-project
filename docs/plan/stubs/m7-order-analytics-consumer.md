# 订剧埋点事件消费

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | order.submitted → analytics.fromOutbox → order_submit |
| 骨架里的做法 | submit.ts 仅发真实 order.submitted；analytics 目录明确 order_submit 来源 outbox，消费者未实现，不重复直记或声称 analytics 行已落库 |
| 登记的工作包 | W1-15a |
| 回补里程碑 | M7 |
| 回补的工作包 | G7-B（待M6拆编号） |
| 依据 | W1-15 第 7、10 节；计划 第 7.3 节留桩清单；m04 第 2.4–2.9、3.15 节；x01 第 3.10、4.1 节 |
