# 订阅完整机制与R1必要伴随

| 项 | 内容 |
| --- | --- |
| 改了什么 | W4-05原4API/1x01范围不变；完整续费/升级/降级、读模型及R1预计约1,200–1,500行非测试源码，notify只增加既有R1消费与manual-reminder、m.plan_expiring场景事实，既有upgraded事件补typed载荷 |
| 原因 | 当前通知扫描仅消费R4/R7，单登记billing R1不会投递；升级需沿原账本保存点、整数算式与历史成本事实，不能用空实现收口 |
| 影响的包 | W4-05；W4-04共享purchase-write仅各改自己的merchant与后台/凭证段，W4-06 topup保持 |
| 类别 | 估算 |
| PR | 本地codex/w4-05-subscription-advance；ROOT已批准体量与窄伴随，尚未验收 |

必要伴随位于notify/registry.ts、reminders.ts、dispatch.ts，billing/register.ts、notify-facts.ts、subscription/reminders.ts；契约billing/fulfill.ts、events/billing.ts与ledger.ts只登记已有事件/文案。ROOT另批准notify-facts.ts按topup真实同意范围只要求points，修正W4-06只读事实遗漏；此前验证未涵盖全量docs.N5。无新公共框架、外部通道、权限、事件名、DDL或依赖。

实际缺口：shared/valuation尚无已合回放实现，daily价值/I11/I13须独立前置完整交付后装配，不能由本包临时少数路径估值替代。本包保持进行中；合法m>0且topupPoints=0/proratedFen>0的即时升级成本表达另等业主明确，不借本记录改变原规则。
