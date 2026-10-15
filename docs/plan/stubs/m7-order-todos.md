# 订单待办

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | OrderDetail.pendingTodo、OrderCard.pinnedTodo、OrderItemRow.pendingTodo 与 order MerchantFacts.todoCount |
| 骨架里的做法 | read.ts/merchant-read.ts 的详情与卡片待办为null，MerchantFacts 待办数0；未查询或派生不存在的待办 |
| 登记的工作包 | W1-15a；b 扩展列表与事实字段 |
| 回补里程碑 | M7 |
| 回补的工作包 | G7-B（待M6拆编号） |
| 依据 | W1-15 第 7、10 节；计划 第 7.3 节留桩清单；m04 第 2.4–2.9、3.15 节；x01 第 3.10、4.1 节 |
