# 续费升级降级与加购

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | m.plan.quote、m.paymentOrder.create 的续费/升级/降级分支与pointPackId加购分支；分别由W4-05、W4-06回补 |
| 骨架里的做法 | 原M1的catalog.quotePlan与purchase-write.createOrder拒绝续费/升级/降级及pointPackId分支，留待M4回补 |
| 登记的工作包 | W1-11b，PR 待填写 |
| 回补里程碑 | M4 |
| 回补的工作包 | W4-05（续费/升级/降级，PR #143）、W4-06（pointPackId，本地合入） |
| 依据 | W1-11b 第 2、5、7、10 节；开发计划第 7.3 节留桩清单 |

2026-10-27从actual main `726ac1d0`核对：W4-05的PR #143合入提交`9fe07804`及零积分月规则`2a3fb380`、W4-06加购实现`24a1c0e2`及验收收口`97dce83b`均为当前主干祖先，本桩各购买分支已回补。

实际`packages/services/src/billing/catalog/index.ts`按真实当前周期与套餐等级计算续费、即时升级、降级预约及下期升级；`payment/purchase-write.ts`在锁内复用同源报价，复核预期金额并冻结内容。pointPackId分支复核老板能力、现价/上架、有效套餐、退款与购买策略，同事务记录topup积分规则同意。原真实DB/HTTP、幂等与零重复证据见[W4-05状态](../status/W4-05.md)和[W4-06状态](../status/W4-06.md)，对应`subscription/lifecycle.test.ts`、`subscription/topup.test.ts`及API的`billing-subscriptions.test.ts`、`billing-point-packs.test.ts`。

2026-10-18业主决定已落实：零积分折算月免收，未来完整月正常收费；HTTP定点已精确核12000分报价/创建/唯一重放，旧12200分预期金额受控拒绝。整单为0不建即时升级单，保留下期升级报价。本次仅核实代码、入库证据及合流，不重跑历史目标；真实云、商户支付/银行到账、消息送达及M4整体验收仍未验。
