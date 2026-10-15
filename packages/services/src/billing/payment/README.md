# payment：唯一付款入账入口

W1-11a 第二段。依据：03 第 1.3 节；08 分组第 2.1、2.2、2.6 节；h01 第 2.6 节；ADR-0046。接在已合并的账本与履约实现上。第 1–5 节为 W1-11a 入账入口，第 6 节为 W1-11b 创建与财务确认主链；W4-01 回补微信预下单及可信成功入账，见第7节。

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

M1时只接受 `bank_transfer`；W4-01已回补关联付款单的可信微信成功入账，孤儿仍抛 `INTERNAL`，补单选项尚未实现，登记 [M4 留桩](../../../../../docs/plan/stubs/m4-billing-payment-channels.md)。升级与加购仍由第一段的内容留桩返回受阻。四类差异只开不处理，M4 接重试履约、退款与恢复流程。本包没有路由、实际银行操作、微信 Provider 或新迁移。

## 6. 购买与对公凭证主链（W1-11b）

`Runtime.billing` 由 `createBillingPurchase` 构造，显式注入事务、时钟、账本、原入账、协议、主体、media、SLA、配置与密钥读取器。`getPurchasePolicy`、`listPlans`、`quotePlanPurchase` 与 `wallet` 只读；策略由 shared 的有序首匹配纯函数给出，参数与财务版本按同一注入时刻读。钱包复用账本读侧及 tenant 额度。

新建付款单的报价与购买策略仍取账户锁后的账本时刻；协议同意保留 docs 实际采样时间，完成同意后再取真实创建时刻。收款银行版本、对公有效期参数和截止时间均按该创建时刻读取或计算，避免同意晚于新单、跨银行版本生效时选到旧账户。复用未完成单保持既有行为：同版本同意由唯一约束保留原记录，协议换版时仍可能追加新版本同意，本次时序修复不改变该语义。

`createOrder` 在实体、已有付款单锁后拿账户，重算报价、对比金额、写两份协议同意与 FK 单号，捕获生效收款账户版本、登记 TTL。新内容快照可带创建时 `planName`；旧快照缺项才回查当前名称，不参与履约计价。商家 DTO 只在本次响应解密账号并禁止缓存；幂等最终 JSON 快照按契约脱敏，重放 `bankAccount.accountNo=null`。

`submitProof` 只接受当前老板、同归属 stored/pay_receipt 文件，按 files 端口永久 link。替换将旧凭证置 superseded，不多写一次主状态迁移；`due_at` 和 SLA 快照真实计算。`getAdminOrder` 与 `getProof` 按资源范围查询，超范围 404；`listProofs` 与 `proofSummary` 是 global 处理队列，同过滤条件计数，详情不签发文件 URL。

`confirmProof` 检查权限、再验证、锁版本、到账金额与单号回显、银行流水核对，按付款单 290 → 流水事务咨询锁 → 本事务创建并锁实际交易 300 → 凭证 310，再次核对全部前置后调原 `applyPayment`，履约最后拿账户 420。咨询锁用参数绑定的 `pg_advisory_xact_lock(hashtextextended(key,0))`，独有命名空间 `lyx:billing:transfer-confirm:<channel>:<规范化流水>`，不按付款行或主体分锁；首次冲突查询前取得，提交/回滚自动释放，不占行锁 rank。失败回滚整个交易，不另写四个已付列。流水 NFKC、去空白和连字符、转大写；同银行碰撞拒绝，不同银行必须回显完整冲突单号，后到事务在前单提交后查询真实冲突。`rejectProof` 写驳回理由及说明、顺延有效期并重登记；大额二人复核阈值达到则本期拒绝。

`bindBillingTimers({clock,flow,timers})` 返回幂等解绑函数，乱序关闭不恢复已关实例；无绑定明确失败。上传/替换不取消 TTL，到点有 pending 凭证则 skipped；驳回按新有效期登记；原入账付清后取消本单任务。worker 等全部循环与在途消费者关停 settle 后通过 `closeBillingTimers` 解绑，保留关闭失败传播，重复停止只清理一次。

`proposeFinanceConfig(tx,deps,ctx,input,staff)` 使用正常提议权限与双人审批；银行账号只写密文列，payload 只含脱敏串。银行批准后 24 小时生效，其余即时。`seedPlaceholderFinanceConfig` 注入 25 小时前时钟、使用两名真实 active 财务；重复零新增，已有配置不覆盖，停用员工明确失败。占位账号全零、户名标明勿转账，真实值待 E13。

新增每日 full/P1、不自愈项：`payment.I12` 保留配置审批与生效时刻检查，并核对对公单捕获的版本是该单创建时已经批准、生效的最新 bank_account（与 financeConfigAt 同按 effective_at、id 倒序），历史正确版本不因后来配置生效而违规。配置错误仍报 finance_config_revision，订单错误报 billing_order 和归属 entityId。`I14` 核对待确认单与恰一张 pending 凭证双向一致，`I15` 核对 accepted 与恰一笔 succeeded 收款双向一致。账本原不变量测试完整保留，新项在 `payment/purchase-invariants.test.ts`。

目标用例：`apps/api/test/billing.test.ts`、`apps/worker/test/transfer-ttl.test.ts`、`billing/demo-seed.test.ts`、`payment/purchase-invariants.test.ts`、`shared/purchase-policy/policy.test.ts`。八项既定留桩见 W1-11b 状态文件；本包不改表结构、既有入账函数签名或层白名单。

## 7. W4-01 微信预下单

`Runtime.billing.wechatPrepay` 消费当前真实会话与老板成员关系，按主体100→付款单290→交易300取得或创建尝试；服务器策略、金额、资格、退款与北京时间日限额都在事务内复核。A提交后才调微信JSAPI，B重读并保存prepay；有效同payer尝试只重签，换payer先查关旧尝试后建下一尝试。调起参数仅B成功后出本次响应，持久幂等结果始终为null，同键重放不重复签名或调用渠道。

可信已付查单先经`recordChannelSuccess`独立提交资金事实，再调原`applyPayment`与保存点履约。金额不符、付款人或正式attach编码不符取消并开原差异；业务履约受阻保已付，账户忙/基础设施失败只回滚入账，保已成功未入账与唯一事件。微信按原时限参数创建单并登记`po.expire`；其处理器、回调、sync/cancel与兜底仍由W4-02完成。

本地新6DB+2HTTP聚合首轮8/8通过（11.07秒）；覆盖A已提交/未知应答、C50、占用/B拒绝、换payer、真实履约一次、不符/退款闸门、保存点与账户忙恢复。Provider精确24项通过（4.25秒），services/API类型通过。外部IO使用typed替身与既有官方签名向量，不代表E2真实商户、密钥、资金或微信消息验收。
