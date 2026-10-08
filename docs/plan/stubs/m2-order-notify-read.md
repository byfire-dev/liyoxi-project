# 订剧通知场景取数

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | orderForNotify 通知读端口 |
| 骨架里的做法 | order/notify-facts.ts 与 register.ts 登记真实 orderForNotify/协议事实；notify/registry.ts 按实际 order.submitted/order.started 解析当前主体老板、状态与正式 order.detail 深链。dispatch.db.test.ts 六项真实事务反例覆盖重复/乱序、回滚、移除成员、actual order.started 与合法主体归属更换；不追加重复订购事件、不拿 payload 旧角色放行 |
| 登记的工作包 | W1-15a |
| 回补里程碑 | M2 |
| 回补的工作包 | W2-17 PR3（源码与本地目标验收；调度完成独审和本地合流后填写提交，远端 PR/CI 仍暂停） |
| 依据 | W1-15 第 7、10 节；计划 第 7.3 节留桩清单；m04 第 2.4–2.9、3.15 节；x01 第 3.10、4.1 节 |
