# 订剧选择广告

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | m.order.quote 的 ads 与 m.order.create 的 adIds |
| 骨架里的做法 | quote.ts 返回 ads=[]；checks.ts 带 adIds 一律 ORDER_AD_INVALID reason=not_in_store |
| 登记的工作包 | W1-15a |
| 回补里程碑 | M5，G5-B |
| 回补的工作包 | W5-08 |
| 依据 | W1-15 第 7、10 节；计划 第 7.3 节留桩清单；m04 第 2.4–2.9、3.15 节；x01 第 3.10、4.1 节 |

## W5-08 回补

order/ad-facts.ts 经 ad 公开事实口读取已确认版本；quote 返回真实候选且零业务写入，create 锁内复核门店、广告位、剧目许可和取消状态后写实际 order_item_placement。修改中或新版本待确认仍可选择旧确认版，未确认广告不能提交。读侧返回实际选用广告与浮动引用；样片确认沿原入口钉版。facts.db.test.ts 以真实提交、生产、确认、重开及暂停恢复验证候选、引用数量和钉版隔离。本桩只关闭服务端广告选择，m5-weapp-order-ads 的页面任务保持原状态。
