# 订阅完整机制与R1必要伴随

| 项 | 内容 |
| --- | --- |
| 改了什么 | W4-05原4API/1x01范围不变；完整续费/升级/降级、读模型及R1预计约1,200–1,500行非测试源码，notify只增加既有R1消费与manual-reminder、m.plan_expiring场景事实，既有upgraded事件补typed载荷 |
| 原因 | 当前通知扫描仅消费R4/R7，单登记billing R1不会投递；升级需沿原账本保存点、整数算式与历史成本事实，不能用空实现收口 |
| 影响的包 | W4-05；W4-04共享purchase-write仅各改自己的merchant与后台/凭证段，W4-06 topup保持 |
| 类别 | 估算 |
| PR | 本地codex/w4-05-subscription-advance；ROOT已批准体量与窄伴随，尚未验收 |

必要伴随位于notify/registry.ts、reminders.ts、dispatch.ts，billing/register.ts、notify-facts.ts、subscription/reminders.ts；契约billing/fulfill.ts、events/billing.ts与ledger.ts只登记已有事件/文案。ROOT另批准notify-facts.ts按topup真实同意范围只要求points，修正W4-06只读事实遗漏；此前验证未涵盖全量docs.N5。无新公共框架、外部通道、权限、事件名、DDL或依赖。

shared/valuation纯回放前置已实际合入`cf5e0cce`，daily价值/I11/I13的真实DB投影仍由独立前置交付后装配，不能拍当前可变周期/计划反推历史。ROOT批准内部事件的versioned dailySnapshot同TX捕获与active-only `Ledger.applyExtension`期限原语；后者不实现W4-08审批、revive/unexpire或现金规则。本包保持进行中；合法m>0且topupPoints=0/proratedFen>0的即时升级成本表达另等业主明确，不借本记录改变原规则。

daily前置`c1ce0022`实际合入后，补每期ended的内部expired终态（有预约续接也记录），不变外部expired发送语义；原预约测试仅增这条真实历史。日任务在本域sweep构造独立assembly，runtime/ops-worker只接原ledger与正式projection，无新循环/租约框架。投影旧史缺失在kernel保存点隔离，不能回滚正常advance或报整轮成功；I11/I13只读重算仍须真实公口，不调用写者冒充不变量查询。
