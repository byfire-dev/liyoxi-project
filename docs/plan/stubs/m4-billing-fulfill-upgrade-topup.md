# 升级、加购两种内容的履约

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | 升级补差（当期权益换版本、补发、改写其后的发放计划）与加购履约；分别由W4-05、W4-06回补 |
| 骨架里的做法 | 原M1的fulfill遇到upgrade/topup即blocked，留待M4回补 |
| 登记的工作包 | W1-11a |
| 回补里程碑 | M4 |
| 回补的工作包 | W4-05（升级，PR #143）、W4-06（加购，本地合入） |
| 依据 | 计划 第 7.3 节留桩清单“微信支付、续费升级、退款、对账、发票”一行；任务书 W1-11a 第 5、7 节；D1 第 6.4、6.5 节 |

2026-10-27从actual main `726ac1d0`核对：W4-05的PR #143合入提交`9fe07804`、零积分月规则提交`2a3fb380`，以及W4-06加购实现`24a1c0e2`、验收收口`97dce83b`均已在当前主干祖先链。本桩两种内容的代码范围均已回补。

实际入口为`packages/services/src/billing/subscription/fulfill.ts`：升级经`upgrade.ts`复核当前周期与冻结报价，更新当期权益、补发已到月积分并改写后续待发计划；加购经`topup.ts`调用原`ledger.purchase`，保留永久addon批次、保存点回滚与付款单操作键防重。原真实DB/HTTP定点与审查记录见[W4-05状态](../status/W4-05.md)和[W4-06状态](../status/W4-06.md)，对应测试为`subscription/lifecycle.test.ts`、`subscription/topup.test.ts`及API的`billing-subscriptions.test.ts`、`billing-point-packs.test.ts`。

2026-10-18业主决定已落实于同源`quoteUpgrade`：零折算积分月免收，未来完整月正常收费发放；跨月确认、实际批次成本与I12守恒已有定点证据。整单为0仍拒绝即时升级并建议下期升级，不开放零价即时切档。本次仅核实代码、入库证据及合流，不重跑历史目标；真实云、商户资金、消息送达及M4整体验收仍未验。
