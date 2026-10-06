# 订单履约读侧内容

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | OrderDetail.deliveryPlan / items[].ticketStep 与开工后时间轴 |
| 骨架里的做法 | read.ts deliveryPlan/ticketStep=null，提交节点真实done，开工节点current，后继节点todo |
| 登记的工作包 | W1-15a |
| 回补里程碑 | M1 |
| 回补的工作包 | W1-17 |
| 依据 | W1-15 第 7、10 节；计划 第 7.3 节留桩清单；m04 第 2.4–2.9、3.15 节；x01 第 3.10、4.1 节 |
