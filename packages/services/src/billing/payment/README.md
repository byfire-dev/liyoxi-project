# payment：唯一付款入账入口

W1-11a 第二段。依据：03 第 1.3 节；08 分组第 2.1、2.2、2.6 节；h01 第 2.6 节；ADR-0046。接在已合并的账本与履约实现上，不创建付款单、不确认银行到账、不接微信。

## 1. 入口与依赖

```ts
const fulfillment = createFulfillment({ clock, events });
const payment = createPayment({ clock, events, flow, fulfillment, timers, bizNo });
await tx.run((handle) => payment.applyPayment(handle, { paymentTxnId, ctx }));
```

`createPayment` 与 `createFulfillment` 从 `@liyoxi/services` 导出，进程装配时构造一次；修改业务行的 `applyPayment` 必须接调用方的事务句柄。`ctx` 不给时使用 `billing.apply_payment` 系统身份；W1-11b 对公确认传财务上下文，权限、凭证、再验证仍由确认用例把关。

加锁：无锁读交易找到付款单 → 付款单 290 → 交易 300 → 重读 → 履约最后拿账户 420。已经入账则还原付款单存下的 `FulfillResult`，返回 `{ result: { status: "applied", billingOrderId, fulfillment }, replayed: true }`，不再写历史、事件、审计、差异、单号或定时器。非成功或全额退回返回 `skipped`。

## 2. 入账与差异

先校验实收。金额不等，未完成的付款单同句置已取消、清 `transfer_state`，开 `amount_mismatch`，终态保留；交易不入账。金额相等，再按原状态处理：已支付/已退款开 `duplicate_receipt`，已取消开 `paid_after_cancel`，待支付或待确认走对应状态链付清。

付清随迁列同句写实付、渠道成功时间、入账交易、入账时间并清 `transfer_state`；交易同事务写 `applied_at`。调用已合并第一段 `fulfill(tx, { billingOrderId, ctx })`，写回履约结果与说明。完成时间取 `fulfill` 操作行的账本时钟，不取预约生效时刻或渠道时间。受阻时仍已支付，开 `fulfillment_blocked` 并发受阻事件。未触发的本单 `po.transfer_ttl` 在入账或金额不符后取消；本包不创建该定时器。

差异以 `{kind}:{outTradeNo}` 去重，先查，已存在即返回旧 id；实际新插入才经 `flow.transition(created: true)` 写状态历史、事件与审计，并置付款单 `has_open_exception`、交易 `recon_state = diff`。插入前取 CY 号、插入带冲突防重。金额不符取差额绝对值，其余取实收。渠道事实不含付款人与 openid；平台事实取开单时付款单的当前状态与应付。

保存点内业务、完整性约束、自检与推进错误只回滚履约写入并返回受阻；可重试数据库错误、账户忙、连接/事务故障、内核违规继续外抛，整个入账事务回滚。去掉业务故障后直接调用 `fulfill` 可成功；`applyPayment` 重放不会自动处理原受阻差异，处理入口在 M4。

## 3. 状态链、事件、不变量

`machines.ts` 注册 `billing_order.status` 的三行数据守卫与随迁列、`payment_exception.status` 的新建行；权限不重复写在数据守卫里。事件载荷在契约 `events/billing.ts`：`billing_order.paid`、`cancelled`、`fulfillment_blocked`、`payment_exception.opened`。新建与迁移事件由 flow 填 `fromState`、`toState`、`transition`。

三条付款不变量随 billing 登记，均 P1、每日 `full`、不自愈：

- `payment.I1`：已支付/已退款恰有一条匹配的已入账成功交易，金额与所指交易一致，履约完成或受阻；反向也核对。
- `payment.I2`：待支付/待确认/已取消无已入账交易且未履约，两个待完成态没有成功收款；成功超过 10 分钟、未入账、未全额退回的交易有未决差异。无主体孤儿上报不带 `entityId`。
- `payment.I4`：非已退款的受阻单有未决履约受阻差异；超过 72 小时仍受阻也违规。

## 4. 验证

```sh
pnpm --filter @liyoxi/services exec vitest run src/billing/payment/
LYX_FC_RUNS=200 LYX_FC_SEED=42 pnpm --filter @liyoxi/services exec vitest run src/billing/payment/apply.property.test.ts
```

`apply.concurrency.test.ts`：十条独立连接、20 轮，顺序重放三次各表不变。`apply.fault.test.ts`：完整履约写入轨迹逐点故障、真实唯一冲突与自检、可重试死锁、账户忙、五个外层写步骤。`apply.interleave.test.ts`：真实 `advanceDueAccounts` 扫描与付款交错 200 轮。`apply.property.test.ts`：任意实付、月数、预约、并发度、重放次数；缺省连库 10 轮，验收 seed 42/200 轮。`apply.test.ts`：分支、状态守卫、差异旧单与取消本单定时器。`invariants.test.ts`：每条反例、边界时间、孤儿与空库加种子十五条全量零违规。

夹具在 `@liyoxi/services/testing`：`createPaymentHarness`、`pendingPlanOrder`、`transferReceipt`、`applyReceipt`、`joinPayment`。银行资料与审批全部为现场生成的假值。

## 5. 留桩

只接受 `bank_transfer`；微信与孤儿交易抛 `INTERNAL`，补单选项尚未实现，登记 [M4 留桩](../../../../../docs/plan/stubs/m4-billing-payment-channels.md)。升级与加购仍由第一段的内容留桩返回受阻。四类差异只开不处理，M4 接重试履约、退款与恢复流程。本包没有路由、实际银行操作、微信 Provider 或新迁移。
