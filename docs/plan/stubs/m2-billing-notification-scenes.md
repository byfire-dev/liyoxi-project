# 付款通知场景解析

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | billing 事件通知场景端口 |
| 骨架里的做法 | 真实 billing/notify-facts.ts 与 register.ts 登记付款单、订阅期、积分余额和协议事实；notify/registry.ts 消费实际 billing_order.paid、订阅激活/续费和六种积分事件，dispatch.ts 在原消费事务生成站内消息/投递。付款按当前购买模式裁剪，金额只取真实分值；policy.db.test.ts 三档、delivery/direct 21项、配置/派发/scope 13项目标通过。未来升级/恢复/延长没有实际 producer，不伪接；真实通道到达另验 |
| 登记的工作包 | W1-11b，PR 待填写 |
| 回补里程碑 | M2 |
| 回补的工作包 | W2-17 PR3（源码与本地目标验收；调度完成独审和本地合流后填写提交，远端 PR/CI 仍暂停） |
| 依据 | W1-11b 第 2、5、7、10 节；开发计划第 7.3 节留桩清单 |
