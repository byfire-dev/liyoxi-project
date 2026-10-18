# billing：账本内核

每个主体的积分账本：只增流水、按批次存放、账户行是唯一的锁（W1-10）。账户与批次交进入（锁、时钟、推进）、月度发放、加购入账、读函数与每分钟扫描；冻结单一族交 `hold`、`capture`、`release`、`refund`、`adjust`、快照计价、九条不变量与唯一取整门禁。依据：[07 分组](../../../../docs/data-model/07-billing-ledger.md)；[03](../../../../docs/03-key-designs.md) 第 2 节；D1 第 6.2、7.1、8 节；x01 第 3.7、4.3、5.8 节；任务书 `docs/plan/tasks/W1-10.md`。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `ledger/context.ts` | 账户锁（等锁 3 秒，`ACCOUNT_BUSY`）、账本时钟、`ensureAccount` |
| `ledger/operation.ts` | 一次账本操作的登记与落库：按写入顺序写批次、操作行、流水、账户缓存。账本的写只有这一个出口 |
| `ledger/advance.ts` | 时间推进：到点的发放、期末清零、预约周期接续、过期后加购积分停用 |
| `ledger/hold.ts`、`ledger/adjust.ts` | 冻结、扣减、释放、退回与调整；尾部退回和原周期结束后的快照去向 |
| `ledger/self-check.ts` | 写入时自检 |
| `ledger/index.ts` | `createLedger`：对外的账本函数 |
| `pricing/` | `paramsAt`（计费参数）、`priceAt`（剧目积分价）、`quoteHold`（锁内重算积分与下单快照） |
| `read/` | `getEntitlements`、`getWalletView`、`listOperationsByHold` |
| `sweep.ts` | 每分钟扫描的用例函数 `advanceDueAccounts`（循环 `billing_advance`） |
| `invariants.ts`、`register.ts` | `billing.I1`–`I8`、`I16` 的检查与登记 |
| `seed.ts`、`seed-data.ts` | 套餐、价目、参数的种子（W0-21） |
| `subscription/`、`ports.ts` | 付清后的履约（建周期与发放计划、发首月）、`billing.I9`、`I10`、`I12`、两个端口的实现（W1-11a），见 [subscription/README.md](subscription/README.md) |
| `payment/` | 唯一对公入账入口、四类差异开单、两条状态链与 `payment.I1`、`I2`、`I4`，见 [付款 README](payment/README.md) |
| `reporting/` | 周期内部v1历史快照捕获、policy1流水估值与主体历史日投影；接线及legacy边界见下 |

W4-05前置公口：`captureSubscriptionDailySnapshot(tx, entityId, termId)`只读捕获调用方已持账户锁、
已变更完成的真实term/pending schedules；相关事件写者同TX放入内部`payload.dailySnapshot`，不改outbox载荷。
`createBillingDailyProjection({ledger}).snapshot(tx, entityId, through)`只接已闭合业务日，
从主体创建日起按流水bizDate和每term历史快照重建，写可重算daily与policy1估值；不拍当前余额。
`rebuildEntityValuation(tx,{ledger},entityId)`也可独立重建估值，conversion取真实origin转出价值。

只读巡检用`computeEntityValuation(db,entityId,at)`与`computeEntityDaily(db,entityId,through,at)`，
后者返回`{days,valuations}`；两者只查真实源表，不读写派生表、不锁账户或advance，
at由调用方注入并提供一致读视图，业务字段比较忽略计算时间等元数据。
原写者在原账户锁下委托同一计算结果；未推进的真实到期事实明确拒绝，不在巡检中自愈。

任一相关旧事件缺快照即`BillingDailyHistoryMissingError`，整主体投影失败，旧史不猜填；
调用方advance后用`kernel.savepoint`隔离投影，保推进提交/逐主体继续，不能把缺史写成0或吞其它错误。
本前置未接实际事件写者、sweep与13个月验收；后继开通/预约/rollover/expired/upgrade及extend/refund/resume
写者均须真实同TX捕获。单目标：`pnpm --filter @liyoxi/services exec vitest run src/billing/reporting/daily.db.test.ts`。

## 2. 用账本

```ts
const ledger = createLedger({ clock, events }); // 进程装配时建一次；任务进程里 buildWorkerServices 已建

await tx.run(async (handle) => {
  // 先锁本事务要改的已有业务行（付款单、订单项……），最后才进账本：账户锁是全事务最后一把
  const { now } = await ledger.lockAccount(handle, entityId); // 拿锁、取账本时钟、推进
  // …同一事务里写的时间敏感字段（提交时间、同意时间）用这个 now…
  await ledger.purchase(handle, { entityId, billingOrderId, points, payFen, ctx });
});
```

- 账本函数第一个参数是事务句柄，自己不开事务，不写审计（由调用它的用例写）。
- 每个操作同一个骨架：拿账户锁 → 账本时钟 → `advance` → 按操作键查，已登记即返回第一次的结果（`replayed: true`）→ 守卫 → 落库 → 自检 → 发事件。
- **账户锁**：一个事务只锁一个主体的账户，锁第二个即抛 `LedgerError("one_account_per_tx")`。只对拿锁那一句设 `lock_timeout` 与 `statement_timeout`，总等锁至多 3 秒，两项原有超时更短则分别沿用；成功后恢复两项原值。等不到抛 `AppError("ACCOUNT_BUSY")`（503，可重试），不进 `tx.run` 的重试。SQL 超时后事务已中止，直接退出或由调用方回滚保存点，不在失败路径再发恢复 SQL。
- **账本时钟**：拿到锁之后取注入的时钟，与该主体上一次操作的时刻取较大者；同一事务再次进入用同一个值。流水的 `occurred_at`、`biz_date` 用它；到点类操作用逻辑时间（发放 = 应发时刻，清零 = 周期止点、业务日 = 止日）。
- 没有计费账户行的主体，进入时会补建；正常情况下主体创建时由 tenant 经端口建（端口实现由 W1-11a 登记，调 `ledger.ensureAccount`）。
- 账本的内部错误是 `LedgerError`（`reason`：`guard`、`op_key_conflict`、`term_chain`、`self_check`、`one_account_per_tx`），都是代码缺陷或数据异常，按 500 处理；业务上的拒绝是 `AppError`。

| 函数 | 做什么 | 操作键 |
| --- | --- | --- |
| `lockAccount(tx, entityId)` | 拿锁、取时钟、推进；返回 `{ entityId, now, today }` | — |
| `advance(tx, entityId, { wait? })` | 推进到现在；`wait: "skip"` 而账户被占着时返回 `null` | — |
| `grant(tx, { grantScheduleId, ctx? })` | 月度发放。到点的发放 `advance` 会自己做；履约建好周期后发首月调它，`ctx` 把这一笔记在入账的操作人名下 | `grant:grant_schedule:{id}` |
| `purchase(tx, { entityId, billingOrderId, points, payFen, ctx })` | 加购入账：新建长期有效的加购批次，成本 = 实付。套餐已过期也照常入账（停用） | `purchase:billing_order:{id}` |
| `hold(tx, { entityId, storeId, refType, refId, pricing, title, ctx, expectS? })` | 锁内重新计价并存快照，套餐先于加购，按批次顺序冻结；给 `expectS` 时拒绝已变的报价 | `hold:{refType}:{refId}` |
| `capture(tx, { pointHoldId, title, ctx })` | 冻结转为已消耗；订阅过期或退款处理中也可扣减 | `capture:point_hold:{id}` |
| `release(tx, { pointHoldId, reasonClass, title, ctx })` | 开工前释放全部冻结；按分摊尾部退回 | `release:point_hold:{id}` |
| `refund(tx, { pointHoldId, qty, reasonClass, source, refNo, ctx })` | 扣减后部分或全额退回；原周期结束时按下单快照转加购或清零 | `refund:{取消明细 id}` 或 `adjust:{审批单号}` |
| `adjust(tx, { entityId, approvalRequestId, requestNo, pointAdjustmentRequestId, direction, lotKind, points, reasonCode, ctx })` | 审批后的积分调整；增加建批次，扣减按指定类型的批次顺序，余额不足拒绝 | `adjust:{审批单号}` |
| `resumeAddon(tx, { subscriptionTermId, ctx? })` | 过期后重新开通时恢复加购积分闸门，不改变批次数量 | `resume:subscription_term:{id}:{止日}` |
| `refreshNextDue(tx, entityId)` | 重算 `next_due_at`。建周期、改发放计划的一方在自己的写入之后调（`grant` 已含） | — |
| `ensureAccount(tx, entityId)` | 没有才建账户行 | — |

推进里发生的操作：期末清零 `expire:subscription_term:{id}:{止日}`、过期停用 `suspend:subscription_term:{id}:{止日}`。

## 3. 时间推进

到点的事只在 `advance` 里发生，按逻辑时间的先后一件一件做，幂等、可追赶：

1. 当前周期里已到应发时刻的发放计划 → 发放（新建套餐批次，到期 = 周期止点，成本 = 该月分摊的套餐款）。
2. 周期到了止点 → 清零（“可用”移到“已清零”，冻结留在原批次），周期置为已到期。
3. 有预约周期 → 接续生效（下一轮发它的首月）；没有 → 订阅过期，写 `addon_suspend`，加购积分停用（闸门关上，批次数量不动）。

调用点两个：每个账本写操作的开头；任务进程的循环 `billing_advance` 每分钟扫 `next_due_at` 已到的主体（`FOR UPDATE SKIP LOCKED`，被占着的跳过；一个主体出错不影响别的，经告警端口报 `billing.advance_failed`，它的 `next_due_at` 不前进，下一轮再试）。

发的事件：`billing.points.granted`（去重键 `billing.points.granted:{发放计划 id}`）、`billing.points.purchased`、`billing.points.expired`（`billing.points.expired:{周期 id}`，清零数为 0 不发）、`billing.subscription.rolled_over`、`billing.subscription.expired`。

## 4. 读函数

都不拿账户锁、不推进、不写库；时刻由调用方给（注入时钟的现在）。

| 函数 | 给什么 |
| --- | --- |
| `getEntitlements(db, entityId, at)` | 订阅状态（按周期起止现算，不读 `sub_status`）、是否退款处理中、生效周期与权益快照 |
| `getWalletView(db, entityId, at)` | m07 第 2.7 节 `Wallet` 的 `subscription`、`points` 两段。积分从批次现算：到点还没推进时，该清零的不显示成可用 |
| `listOperationsByHold(db, pointHoldId)` | 一张冻结单的账本操作，按写入先后 |
| `previewReturn(tx, { holdId, qty, reasonClass }, at)` | 取消的真实退回去向；复用释放/退回分摊算法，按此刻周期与原快照计算，不推进或写账本。冻结只能全额，扣减后可预览零数量的仅终止；调用方负责对象范围和写侧锁 |
| `paramsAt(db, at)` | 时刻 `at` 生效的十二个计费参数（值的结构在契约 `BILLING_PARAM_VALUES`） |
| `priceAt(db, dramaIds, at)` | 剧目积分价：单剧修订优先，否则取该剧热度等级的模板价；取不到时给原因（`no_tier`、`no_template`、`not_found`） |

## 5. 自检与不变量

- 每个账本操作提交前，对当前主体从批次重算：七个桶、账户缓存、冻结中的冻结单合计、操作行上的“操作后可花、操作后冻结”。不一致抛 `LedgerError("self_check")` 回滚，不上报、不自愈。
- 工厂直接插的冻结单（`make.pointHold`、`make.orderItem`）不动账本：对这样的主体调账本函数会被自检拦下。要自洽的数据，积分一律经账本函数入账。
- 账本九条不变量（`I1`–`I8`、`I16`）与订阅三条不变量（`I9`、`I10`、`I12`）一并登记，由 ops 的 `invariant.full` 每日跑，`heal: "none"`。`I4` 核对冻结单与分摊及批次冻结桶，`I5` 核对状态与扣减、释放、退回操作；订阅三条的说明见 [履约 README](subscription/README.md)。`I11`、`I13`、`I15`、`I17` 留待后续履约与 M4。
- 付款三条 `payment.I1`、`I2`、`I4` 同样随 billing 每日登记、不自愈；具体资金与异常条件见 [付款 README](payment/README.md) 第 3 节。

## 6. 测试里怎么用

```ts
import { createLedgerHarness, dumpLedger, openTerm, topUp, useSeededDatabase } from "@liyoxi/services/testing";

const db = useSeededDatabase("services");
const h = createLedgerHarness(await db.prisma()); // 账本 + 真实的事件目录 + 可拨时钟 + 工厂
const { entity } = await h.make.merchant({ verified: true });
const { term } = await openTerm(h, { entityId: entity.id, months: 3 }); // 生效的一期，首月已发
await openTerm(h, { entityId: entity.id, after: term }); // 接在后面的预约周期
await topUp(h, { entityId: entity.id, points: 1000 }); // 加购入账
h.clock.set(term.endsAt);
await h.tx.run((tx) => h.ledger.advance(tx, entity.id));
expect((await dumpLedger(h.prisma, entity.id)).account.planAvailableQty).toBe(0);
```

夹具在 `packages/services/src/testing/billing.ts`（依赖规则只许模块之间引入口文件，所以不放在本目录）。建周期与发放计划是履约的事（W1-11a）；它合并之前用 `openTerm` 造。`joinLedger` 另开一条独立连接，并发用例里一条连接算一方；`createLedgerHarness` 的 `onStep` 在每个写步骤之后调一次（故障注入）。

```sh
pnpm --filter @liyoxi/services exec vitest run src/billing/
pnpm --filter @liyoxi/worker exec vitest run test/billing-advance.test.ts
```

都连库（带种子的库），要本地的 PostgreSQL 与 `DATABASE_URL`；任务进程的那一份另要 Redis（`CLAUDE.md` 第 9 节）。

甲类的用例：`ledger/account-lock.concurrency.test.ts`（等锁 3 秒）、`ledger/advance.concurrency.test.ts`（两个扫描并行、跨零点等锁）、`ledger/fault.test.ts`（逐步故障注入）、`ledger/advance.property.test.ts`（性质测试：任取开通日、周期、预约周期、加购与推进的时刻，余额等于按周期起止算出的参考值，多推进多少次结果都一样，七条不变量 0 违规）。性质测试连库，缺省 10 轮、固定种子，要多跑：

```sh
LYX_FC_RUNS=200 LYX_FC_SEED=42 pnpm --filter @liyoxi/services exec vitest run src/billing/ledger/advance.property.test.ts
```

冻结单一族的验收：`hold.concurrency.test.ts` 用 20 条独立连接与屏障重复 20 轮，核对余额不超扣及同键冻结、扣减恰一次；`op-key.test.ts` 对照重放前后的全表快照；`return.test.ts` 验五行状态表、尾部退回与快照去向；`adjust.test.ts` 验调整增减与重新开通。

`ledger.model.property.test.ts` 随机 1–60 步同时驱动真库与独立内存账本：发放、加购、冻结、扣减、释放、部分和全额退回、跨月跨期清零、套餐和加购调整。模型不调生产的分摊与退回函数，每步对照七个桶、账户缓存、冻结单及其分摊，并只读回放流水、检查 `I1`–`I5`。轮次和种子同上：

```sh
LYX_FC_RUNS=200 LYX_FC_SEED=42 pnpm --filter @liyoxi/services exec vitest run src/billing/ledger/ledger.model.property.test.ts
```

`capture`、`release`、`refund` 状态不符抛 `HoldStateError`，带操作、当前状态、拒绝原因及剩余可退数量；幂等重放先于状态守卫。业务取整仅经 `@liyoxi/shared/pricing`：ESLint 覆盖 services、API、worker 的非测试 `src` 源码，直接调用、方括号及解构都拦。四条既有耗时日志只按文件和精确表达式豁免，构建脚本不属于业务源码；反例见 `infra/ci/selftest/cases/lint-one-rounding-function.mjs`。

## 7. 已知的限度

W2-10 关闭前置的 `deletionGuard(tx, entityId)` 按 m07 第1节返回四项真实计数：
`subscription_active` 为 active/scheduled 周期；`payment_open` 为待支付/待确认或有在途异常的付款单（同单只计一次）；
`refund_open` 为 closedAt 为空的申请；`invoice_open` 为 pending/red_pending 申请。
四项都按主体隔离，只读调用方事务，不使用展示权益缓存或按时间推进状态。
该出口不代表主体关闭、退款/发票执行器或 tenant 跨层守卫装配已完成。

- `billing.points.expired` 的去重键照 x01 写成按周期的：周期被延长复活后再次到期（M4）会被当成已发过。做延长的包（G4-A）要把它改成带止日的。
- 清零数为 0 时仍写清零操作（幂等登记、账户上记“最近一次清零 0”），但不发 `billing.points.expired`。
- 读函数给的是“到点之后的样子”，不是推进之后的结果：到点还没推进的那一分钟里，新一期的首月发放还看不到。
- `advance` 一次至多做 500 件事（防数据异常时空转）；超过即抛错，这个主体的账本操作都会失败，要人工看。
- 预约周期没有接在上一期的止点上（`term_chain`）时不接续、直接抛错：宁可拒绝服务，也不带着对不上的周期继续记账。

## W4-07 既有套餐运营 SOURCE

`Runtime.billingPlansAdmin` 接正式列表、改名与上下架四接口。列表返回实际当前/待生效价目、
公告、员工引用及本域按北京月/主体去重的订阅计数；不填零或从展示状态推断统计。
名称只改plan.name，带lockVersion；上下架只在本套餐行锁内检查当前值并递增版本，
上架须当前有效价目包含全部正式enabledCycles价格。原tx.run幂等与审计共事务。
下架影响现商家列表/新报价，已有周期权益与已创建付款单名称/价格快照不改。
首片六组HTTP/DB、类型/依赖边界与唯一独审由ROOT验收通过，已合本地main。

## W4-07 套餐价目公告链 SOURCE

`billingPlansAdmin` 续接新建套餐、价目修订创建/记录/撤回及真实KPI五接口。新套餐只建
未上架public目录；首条修订免公告，可立即生效。后续修订先经`config.notices`建公告，
再插不可变价目，同事务发原登记`billing.plan_revision_scheduled`及写一条业务审计。
撤回只填`cancelledAt`并同事务撤公告；当前/待生效/历史由业务时钟计算，不加切换job。
周期价格覆盖当前和待生效enabledCycles；省略时按月费生成。相邻等级价格及积分比较
覆盖本次生效和已有排期切换点；撤回同样不能破坏其他已排期价目的等级顺序。固定
`billing.plan_catalog`事务咨询锁复用现有原语，先于单plan行锁，避免跨套餐并发写偏斜；
不新增kernel锁序、DDL或权限。公告期按07§2.2完整保存时刻加noticeDays，日期生效向上
取北京零点（非午夜保存时比a07“今天+天数”多一天）；最早合法日期由错误details给出。
旧订阅/付款快照保持，商家列表和报价按原读口在生效时刻消费新价目；优惠仍用原
previous_revision读取规则。KPI与套餐列复用同一事实筛选，全局月内指标另按主体去重，
不把不同版本计数相加，MRR用整数求和。

价目公告链七组真实HTTP/DB风险及类型/依赖/审计/权限/挂载定点已ROOT验收通过，已合本地main。

## W4-07 参数与模板变更集

`Runtime.billingParameters`接12键参数列表、变更集保存/记录与未来单键撤回四正式接口。
逐键校验只消费contract canonical，当前值仍取`paramsAt`；完整公告期、变化键/档、待生效
冲突与当前/未来周期价格覆盖沿同catalog咨询锁，公告/修订/原scheduled事件/审计共TX。
上架先取同锁并核周期价格交叉区间，防下架套餐绕过参数检查后缺价上架。content只读公口
提供候选ID/等级，billing经`priceAt`仅对真实template价差发原tier_template事件；custom与
历史冻结/订阅/付款快照不改。撤回只填cancelledAt，共享公告最后一键撤回才同TX撤公告。
实现细节见[定价README](pricing/README.md)；新增六组DB与两组正式HTTP、类型/依赖与
官方契约/登记/审计/权限/挂载定点已ROOT验收通过，唯一生产独审无P1/P2。

W4-05/06已合流，`billingPlansAdmin.quote`补最后一条`admin.plan.quote`（源码已落地，
目标验证见W4-07状态）。带主体时按canonical主体scope复用真实`quotePlan`，权限为billing或
order任一查看；renewal缺省下期，显式intent仍由共同算法决定。后台policy只展示价格、
无购买提示/渠道，不代表线下开单能力。通用试算读两个当前有效价目，来源可已下架，
目标必须可购；升级沿shared.quoteUpgrade保留零积分月免收，剩余天数超真实基数明确400。
报价不拿账户锁、不advance、不缓存或写业务。共同报价源仅在新增非立即升级报价限制
未来未生效的预约数，到点未advance的周期不占未来名额；已付款冻结履约不反查软上限。
本机替身验证不代表M4、远端CI或真实支付验收完成。


W4-13 当前实现发票与受控财务配置（验收中）：发票申请保存已认证抬头/重加密税号与全额快照，四个 item_name 参数未配时拒绝申请；开具/红票/退款所属公口按 order290→invoice330 串行，文件走 stored/link。财务配置仍用 finance_config_change，不同人决定、bank+24h、其它即时。电子邮件经原 notify 任务、真实附件与最新 delivery 结果回写；queued/受理 sent/未配 skipped 分开，E20 真实到达/OFD兼容未验。退款接口尚待 W4-10，既有 refundRequests 桩不整体关闭。

## W4-08 调整、补偿延长与账户流水

`runtime.billing.adjustments` 提供两个审批资源及只读报价；
`runtime.billing.accounts` 提供后台账户列表/汇总/详情/流水与商家流水。
17 个 typed 接口按 a07/m07 的权限与真实范围接入，写入口接公共 required 幂等上下文；
积分调整详情按 billing/finance 任一查看等级，延长详情按 order/billing 任一查看等级。
带动作权限的写回显不额外要求模块查看等级；查看接口仍独立检查模块与主体范围。

- `points_adjust` 和 `subscription_extend` 均无额外执行步。提交只写审批/领域单及服务端摘要；
  通过在员工20、审批30之后，最后进入唯一账户420，再复核当前余额、期限与退款闸门。
  领域 `appliedAt`、账本操作、审批状态、审计和事件同事务提交；任一步失败回到原待审事实。
- 普通积分增减复用 `ledger.adjust`；`platform_refund` 只接受本主体已扣冻结的可退数量，
  复用真实 `ledger.refund` 和原快照去向，过期套餐可转加购；它不产生现金退款。
  原因说明仅入领域单/文案参数，不放进自由文本事件。
- 未到期顺延复用 W4-05 `applyExtension`，发起后已经续接则作用新周期，不恢复旧期积分。
  需要补偿旧积分时另提关联调整单，由不同员工独立审批。
  到期且未续费、未退款的原待审申请可走 `reviveTerm`：按
  `max(原止日, 审批当日−1)+days` 复活，且只以最近真实 expire 的
  `available→expired` 来源冲回 `expired→available`，不恢复其他 forfeit。
  W4-05 的期限原语及零积分月免收口径不变。
- 客服依据由 support 的 `createBillingApprovalRefs({clock})` 注入：
  `prepare(tx,{serviceTicketId,entityId})` 在 submit.validate 中预锁票据270，
  `attach(tx,{serviceTicketId,entityId,approvalRequestId})` 只追加引用，
  `list(tx,{entityId,approvalRequestId})` 仅读同主体，最多100条。
  为后继退款预留的 kind 为 `plan_refund`，不意味着本包实现现金退款。
  账户在途取消摘要由 order 的 `readBillingPendingCancels` 同样只读注入。
- GET 与报价不拿账户锁、不推进、不写历史或派生表。余额从真实批次/周期现算；
  流水先按“操作×积分类型”分行再分页，游标绑定主体和筛选并包含积分类型位置。
  商家同次冻结只在非空 requestId、同账本时刻、操作人、groupRef 一致时合并，空 requestId 不猜合并；
  后台 capture 单列，商家只更新冻结行状态。所有公式和说明使用历史文案参数。
- `billing.I18`（P1/full/heal:none）检查两表 approved 与 applied 双向一致、
  账本主体/审批引用/操作类型/执行时刻，以及 extend/revive 历史日期公式。
  延长原因编码须存在；历史原因停用仍合法。
  它检查请求保存的历史前后日期，不把后续再次延长后的当前周期止日当作首次结果。
  `billing.I17` 保持原提醒语义。估值/日快照仍走既有 policy1 和历史事件快照公口。

本包定点：`src/billing/adjustments/approval.test.ts`、`read.test.ts` 与
`apps/api/test/billing-adjustments.test.ts`；只用公开合成配置、真实本机测试库和已有替身。
真实员工操作、真机、真实付款或退款均不由这些测试替代。
