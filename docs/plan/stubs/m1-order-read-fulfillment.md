# 订单履约读侧内容

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | OrderDetail.deliveryPlan / items[].ticketStep、OrderItemRow/Detail.ticketStep、AdminOrderDetail.deliveryPlan / items[].ticket 与开工后时间轴 |
| 骨架里的做法 | read.ts deliveryPlan/ticketStep=null，提交节点真实done，开工节点current，后继节点todo；b 独立 merchant-read/admin-read 的 ticket/方案仍null，实际 capture 消费分拆待履约读侧补齐 |
| 登记的工作包 | W1-15a；b 扩展具体字段范围 |
| 回补里程碑 | M1 |
| 回补的工作包 | W1-17 |
| 依据 | W1-15 第 7、10 节；计划 第 7.3 节留桩清单；m04 第 2.4–2.9、3.15 节；x01 第 3.10、4.1 节 |
