# 商家端：套餐、积分、付款与发票

| 项 | 内容 |
| --- | --- |
| 范围 | 商家端小程序 `sub/billing` 分包的六个画板与付款流程：M:Wallet、M:WalletExpired（M43 一页两态）、M:PlanPick（M44，含 M10 对公转账弹层、M11 付款结果）、M:TopUp（M45）、M:Ledger（M46）、M:Invoices（M35）；付款结果页 `sub/order/result?type=payment`（原型无，d7:560）；M:Mine、M:Cart、M:Ads 上的套餐积分展示与购买入口 |
| 接口数 | 18（V1.0 18，V1.1 0） |
| 依据 | 数据模型 07 分组（价目、订阅、积分账本）、08 分组（付款单、收款交易、对公凭证、开票）、02 分组（主体、门店、成员、邀请）、04 分组（门店档案联系人）、13 分组（协议同意）、14 分组（参数、字典）；草案 d1 第 6、7.9、11 节，d2 第 4、5、10.3、11、12.2 节，d7 第 4.7 节；接口裁决 A1–A126（重点 A17、A18、A19、A20、A23、A25、A34、A50；第二轮 A77–A80、A89、A95、A124）；通用约定 C1–C84；m02 第 2.1 节（名额口径） |

本文路径一律省略 `/api/v1`。引用写法：`d2:489` 指 `docs/appendix/design/d2-payment.md` 第 489 行；`08-billing-payment.md:162` 指 `docs/data-model/08-billing-payment.md` 第 162 行；`proto-merchant-a.md:640` 指 `docs/appendix/research/proto-merchant-a.md`。

## 1. 概览

老板在小程序里看套餐与积分、按月查积分明细、选套餐（开通、续费、升级、降级）或加购积分、用微信支付或对公转账付款，并按付款单申请开票、下载发票。全部接口是主体级的：套餐、积分、付款单与发票挂在当前门店（`X-Store-Id`）所属的经营主体上，不随门店切换（PRD §6.16.1）。全部接口只对老板开放，店员 403（d4-identity.md:864、868）。

钱与权益的真相在服务端：报价、应付金额、可用渠道、生效时间、积分发放都由服务端计算，端上不自行算钱（proto-merchant-a.md:702）；付款结果以服务端状态为准，不以 `wx.requestPayment` 的回调为准（d2:555；d7:719）。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `m.wallet.get` | `GET /m/wallet` | 套餐与积分（一页两态） | member；`wallet.read`；店员 403 | none（查询） |
| `m.pointLedgerEntry.list` | `GET /m/point-ledger-entries` | 积分明细，按月分段 | member；`ledger.read`；店员 403 | none（查询） |
| `m.purchasePolicy.get` | `GET /m/purchase-policy` | 购买策略（无金额上下文的入口） | member；`plan.purchase`；店员 403 | none（查询） |
| `m.plan.list` | `GET /m/plans` | 上架中的套餐版本与权益 | member；`plan.purchase`；店员 403 | none（查询） |
| `m.plan.quote` | `POST /m/plans/quote` | 套餐报价（开通、续费、升级、降级、下期换版本） | member；`plan.purchase`；店员 403 | none（试算） |
| `m.pointPack.list` | `GET /m/point-packs` | 上架中的加购积分包 | member；`points.topup`；店员 403 | none（查询） |
| `m.paymentOrder.create` | `POST /m/payment-orders` | 创建付款单（套餐或加购） | member；`plan.purchase`（加购另断言 `points.topup`）；店员 403 | required（结果脱敏 `bankAccount.accountNo`） |
| `m.paymentOrder.get` | `GET /m/payment-orders/{paymentOrderId}` | 付款单详情与状态 | member；`plan.purchase`；店员 403 | none（查询） |
| `m.paymentOrder.wechatPrepay` | `POST /m/payment-orders/{paymentOrderId}/wechat-prepay` | 微信预下单，取调起参数 | member；`plan.purchase`；店员 403 | required（三段式，多事务；结果脱敏 `payParams`） |
| `m.paymentOrder.sync` | `POST /m/payment-orders/{paymentOrderId}/sync` | 主动查单并尝试入账 | member；`plan.purchase`；店员 403 | none（A50，三段式） |
| `m.paymentOrder.cancel` | `POST /m/payment-orders/{paymentOrderId}/cancel` | 取消待支付的付款单 | member；`plan.purchase`；店员 403 | required（三段式） |
| `m.paymentOrder.transferProof.create` | `POST /m/payment-orders/{paymentOrderId}/transfer-proofs` | 提交或重新上传对公转账凭证 | member；`plan.purchase`；店员 403 | required |
| `m.paymentOrder.list` | `GET /m/payment-orders` | 付款单列表（按 `invoiceState` 取“可开票”页签） | member；`invoice.*`；店员 403 | none（查询） |
| `m.paymentOrder.summary` | `GET /m/payment-orders/summary` | “可开票 · N”计数 | member；`invoice.*`；店员 403 | none（查询） |
| `m.invoiceRequest.list` | `GET /m/invoice-requests` | 开票记录 | member；`invoice.*`；店员 403 | none（查询） |
| `m.invoiceRequest.summary` | `GET /m/invoice-requests/summary` | “开票记录 · N”计数与开票页上下文 | member；`invoice.*`；店员 403 | none（查询） |
| `m.invoiceRequest.create` | `POST /m/invoice-requests` | 按付款单申请开票 | member；`invoice.*`；店员 403 | required |
| `m.invoiceRequest.downloadUrls` | `POST /m/invoice-requests/{invoiceRequestId}/download-urls` | 签发发票文件的短时地址 | member；`invoice.*`；店员 403 | none（签发短时地址） |

路由注册顺序（A8、C12）：`POST /m/plans/quote`、`GET /m/payment-orders/summary`、`GET /m/invoice-requests/summary` 先于同层的 `/{xxxId}` 注册。

**对其他模块提供的口径函数**（契约只登记名字与口径，签名由实现定；其他文档展示同一组量时引用这里，不另写算法）：

| 函数 | 口径 | 调用方 |
| --- | --- | --- |
| `billing.getPurchasePolicy(ctx)` | 2.1 `PurchasePolicy` 的求值（规则表、渠道、文案键）；`ctx` 带主体、平台、版本，可带类型与金额 | 本文全部购买入口；m08 `m.bootstrap.get`、`m.notifySetting.list` 的订阅点位裁剪；m04、m06 的购买引导 |
| `billing.getWalletView(entityId)` | 2.7 `Wallet` 的 `subscription`、`points`（含 `isRefundPending`、`spendablePoints` 的主体级口径） | 本文 `m.wallet.get`；m08 `OverviewPlanCard`；m04 `launchOverview` 与 `spendablePoints`；m06 `m.ad.quote`；a03、a07 的积分卡 |
| `billing.quoteAdUnit(entityId)` | `{ unitPoints, discountBp, S }`；套餐未生效（`none` / `expired`）时 `discountBp`、`S` 为 null（d1:1649） | 本文 `Wallet.rules.discountedAdUnitPoints`；m06 `m.ad.quote` |
| `billing.deletionGuard(entityId)` | 未办结事项计数：`subscription_active` = 本主体 `subscription_term.status` 为 `active` 或 `scheduled` 的周期数；`payment_open` = `billing_order.status` 为 `pending_payment` / `pending_confirmation`，或 `billing_order.has_open_exception = true` 的付款单数；`refund_open` = `refund_request.closed_at` 为空的申请数；`invoice_open` = `invoice_request.status` 为 `pending` / `red_pending` 的申请数 | m01 `m.me.deletion.create`（`DeletionBlockerKind` 的四项）；a03 `admin.entity.close` |
| `billing.describePaymentOrders(entityId, orderNos)` | 按付款单号批量取 `{ orderNo, paymentOrderId, type, title }`，`title` 同 2.5 `PaymentOrderCard.title` | m01 合同页“（续费专业版时）”“（开通专业版时）” |

2.3 `PlanQuote`、4.4 计算式模板码、4.5 明细文案码与后台（a07 的 `admin.plan.quote`、积分流水）共用，改动须同时通知 a07。

## 2. 公共结构

### 2.0 本文通用规则

| 规则 | 内容 | 出处 |
| --- | --- | --- |
| 主体范围 | 由 `X-Store-Id` 的门店推出主体 `entity_id`；按 id 取的付款单、开票申请不属于该主体返回 404 `NOT_FOUND` | C17、C29 |
| 退款处理中 | 主体级闸门：本主体任一 `status` 为 `scheduled` 或 `active` 的周期 `subscription_term.refund_request_id` 非空，即“退款处理中”。此时可花积分为 0，不能购买套餐与加购、不能订购与提交广告。本文 `isRefundPending`、`spendablePoints`、`PLAN_REFUND_IN_PROGRESS`、加购的 `refund_in_progress` 都按这一口径，不只看当前周期 | 07-billing-ledger.md:487、553；08-billing-payment.md:162 |
| 店员 | 本文 18 条接口 `clerkView` 都是 `none`：店员调用一律 403 `ROLE_FORBIDDEN`（下文各接口不再重复） | C55、C56；d4-identity.md:864、868 |
| 已停用门店 | 本文能力点都是主体级，已停用门店的老板照常可用，不返回 `STORE_ARCHIVED` | d4-identity.md:864、868 |
| 能力点 `invoice.*` | d4 能力点表里登记的单个组键，不是通配符；开票相关的 6 条接口（3.13–3.18）都按这一个键判权 | A128 |
| 金额与积分 | 金额整数分（`…Fen`），积分整数（`…Points` 或计数字段）；带符号的积分变动用整数正负表示，端上按设计规范显示全角“＋” | C31、C32；design-spec.md:967 |
| 时间 | 时刻 `string(date-time)`（UTC，`Z` 结尾）；日期 `string(date)`（北京时间）；月份 `YYYY-MM` | C34、C35 |
| 套餐状态现算 | 订阅是否生效按周期起止现算（`getEntitlements`），不读 `billing_account.sub_status` 缓存 | d1:844；07-billing-ledger.md:403 |
| 购买入口 | 价格、支付按钮与任何“去续费、去加购、去升级”的引导只在购买策略 `mode = in_app` 时出现；入口不走通用开关 | d2:1318-1334；d7:525、733 |
| 签名地址 | 本文只有发票文件需要地址，经 `m.invoiceRequest.downloadUrls` 单独签发；转账凭证图片不在任何 GET 里返回 | A19；C60；d4-identity.md:1736-1737 |
| 结果脱敏 | `m.paymentOrder.create` 的 `bankAccount.accountNo`（平台收款账号明文）与 `m.paymentOrder.wechatPrepay` 的 `payParams`（支付调起参数）不进幂等记录：同键重放时这两处为 null，响应带 `replayed: true`；路由元数据 `x-redact-on-replay` 登记这两条字段路径 | C50；A80；A124 |
| 字典项 | 响应里的单值字典字段给 `DictRef \| null`（`{ code, name }`，约定 C85 的通用结构，本文只引用不定义），字段名不带 `Code` 后缀：`TransferProofView.rejectReason`、`InvoiceRequestCard.reject.reason`、`InvoiceDocView.expressCompany`；名称按当前字典取，停用后仍返回。积分明细 `adjust` 参数里的 `reasonCode` 是系统枚举 `point_adjustment_request.reason_code`（M55），不是字典，不改 | C85、C87、A151 |

### 2.1 `PurchasePolicy` 购买策略

`billing.getPurchasePolicy()` 的结果（d2:1291-1335）。同一函数在 `m.purchasePolicy.get`、报价、钱包的加购拦截态、付款单详情的 `channels`（决定展示）与创建付款单（强制校验）中求值（d2:1325）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `mode` | enum(`PurchaseMode`) | 是 | `in_app` / `offline_contract` / `hidden` | `finance_config_revision.payload`（`config_key = purchase_policy` 当前生效版本，按顺序取第一条匹配的规则；未命中为 `in_app`），匹配条件取 `X-Client-Platform`、`X-Client-Version`、主体、类型、金额 |
| `isPriceShown` | boolean | 是 | 是否展示价格货架与支付按钮；`mode ≠ in_app` 时为假 | 计算 |
| `isPurchasePromptAllowed` | boolean | 是 | 是否允许出现任何购买引导；`mode ≠ in_app` 时为假 | 计算（d2:1299） |
| `channels` | array<`PurchaseChannel`> | 是 | 可用渠道；`mode ≠ in_app` 时为 `[]` | 计算，见下 |
| `copy` | object | 是 | 文案键，见下 | `finance_config_revision.payload` 规则的 `copySet` |
| `copy.planNounKey` | string | 是 | “套餐”的称呼文案键 | 同上 |
| `copy.pointsNounKey` | string | 是 | “积分”的称呼文案键 | 同上 |
| `copy.agreementKeys` | array<string> | 是 | 付款即同意的协议键（套餐 `member`、`points`；加购 `points`） | 13 分组 `agreement` 播种（13-notify-docs.md:694-695） |
| `copy.payButtonKey` | string | 是 | 主按钮文案键 | 同上 |

`PurchaseChannel`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `code` | enum(`billing_order.channel`) | 是 | `wechat_jsapi` / `bank_transfer` | 同数据模型 |
| `isEnabled` | boolean | 是 | 此刻是否可选 | 计算：微信 = 命中规则未把 `channels.wechat_jsapi` 置为 `off` 且 已配置微信支付 且 金额 ≤ `controls.wechatSingleLimitFen` 且 付款人当日已付（`payment_txn.channel_amount_fen` 按当前会话 openid、北京时间当日、`status = succeeded` 求和）+ 金额 ≤ `controls.wechatDailyLimitFen`；对公 = 命中规则未把 `channels.bank_transfer` 置为 `off` 且 金额 ≥ 参数 `payment.bank_transfer.min_fen` 且有生效的 `bank_account` 配置（08-billing-payment.md:1496）。没有金额上下文时只按配置判断 |
| `isRecommended` | boolean | 是 | 默认选中 | 计算：微信可用时为微信；金额高于参数 `payment.wechat.advise_transfer_above_fen`（默认不设）时为对公（d2:705） |
| `hintKey` | string \| null | 是 | 提示键，如 `limit_exceeded`（超限只能对公） | 计算（d2:702） |

### 2.2 `PlanCard` 套餐版本

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `planId` | string(uuid) | 是 | | `plan.id` |
| `code` | string | 是 | `basic` / `pro` / `flagship`，可新增 | `plan.code` |
| `name` | string | 是 | 基础版 / 专业版 / 旗舰版 | `plan.name` |
| `rank` | integer | 是 | 升降级比较 | `plan.rank` |
| `isCurrent` | boolean | 是 | 是当前生效周期的版本 | 计算：当前生效周期的 `subscription_term.plan_id` = 本行 |
| `planRevisionId` | string(uuid) | 是 | 当前价目修订 | `plan_revision.id`（该套餐 `effective_at ≤ now` 且未撤销的最新一行） |
| `monthlyFeeFen` | integer(分) \| null | 是 | 月费；`isPriceShown = false` 时为 null | `plan_revision.monthly_fee_fen` |
| `monthlyPoints` | integer(积分) | 是 | 每月套餐积分 | `plan_revision.monthly_points` |
| `discountBp` | integer | 是 | 订剧与广告折扣（万分比） | `plan_revision.discount_bp` |
| `productionModel` | enum | 是 | 同数据模型 `plan_revision.production_model` | `plan_revision.production_model` |
| `maxStores` | integer | 是 | 可管理门店数 | `plan_revision.max_stores` |
| `maxMembers` | integer \| null | 是 | 成员上限，null = 不限 | `plan_revision.max_members` |
| `schedulePriority` | enum | 是 | 同数据模型 `plan_revision.schedule_priority` | `plan_revision.schedule_priority` |
| `hasMonthlyReport` | boolean | 是 | 含月度效果报告 | `plan_revision.has_monthly_report` |
| `cyclePrices` | array<object> | 是 | 各购买周期的总价，只列参数 `enabledCycles` 里启用的周期（页面的周期选择据此生成）；`isPriceShown = false` 时为 `[]` | `plan_revision.cycle_prices` 与 `billing_param`（`key = enabledCycles`） |
| `cyclePrices[].months` | integer | 是 | 1 / 3 / 12 | 同上 |
| `cyclePrices[].priceFen` | integer(分) | 是 | 该周期总价 | 同上 |

### 2.3 `PlanQuote` 套餐报价

`billing.quotePlanPurchase()` 的结果（d1:849-864、951-997）。不落库、不缓存（A20）。报价接口按只读方式调用它（不拿账户锁、不 `advance`，周期按账本时钟现算）；创建付款单时服务端在账户锁内先 `advance` 再按同样的入参重算，并与 `expectAmountFen`、`acknowledgedDowngradeImpact` 比对。

| 字段 | 类型 | 必有 | 说明 | 来源（计算规则） |
| --- | --- | --- | --- | --- |
| `action` | enum(`PlanQuoteAction`) | 是 | `subscribe` 开通 / `renew` 续费 / `downgrade` 降级续费 / `renew_upgrade` 下期换高版本 / `upgrade` 立即升级 | 服务端判定（d1:853-859）：无生效订阅 → `subscribe`；同版本 → `renew`；更低 → `downgrade`；更高且 `intent = renew_next_term` → `renew_upgrade`；更高 → `upgrade` |
| `orderType` | enum(`billing_order.type`) | 是 | 付款单将取的类型：`subscribe` → `plan_new`；`renew`、`downgrade`、`renew_upgrade` → `plan_renew`；`upgrade` → `plan_upgrade` | 计算（d2:201） |
| `planId` | string(uuid) | 是 | 目标版本 | `plan.id` |
| `planRevisionId` | string(uuid) | 是 | 目标版本此刻的价目修订 | `plan_revision.id` |
| `planName` | string | 是 | 目标版本名称 | `plan.name` |
| `fromPlanName` | string \| null | 是 | 当前版本名称；无生效订阅为 null | `plan.name`（当前周期的 `subscription_term.plan_id`） |
| `months` | integer \| null | 是 | 购买月数；`upgrade` 为 null（升级不选周期） | 请求 |
| `payFen` | integer(分) | 是 | 应付 | `subscribe` / `renew` / `downgrade` / `renew_upgrade`：`plan_revision.cycle_prices[months]`（带首期优惠时取上一版价目）；`upgrade`：`quoteUpgrade` 的 `payFen`（d1:956-963） |
| `formula` | object | 是 | 计算式 | 同 `billing_order.formula_code`、`formula_args` 的生成规则（08-billing-payment.md:1379） |
| `formula.code` | string | 是 | 计算式模板码，见第 4.4 节 | 计算 |
| `formula.args` | object | 是 | 计算式参数 | 计算 |
| `formula.text` | string | 是 | 服务端渲染好的计算式，如“¥6,000 × 3 个月 ＝ ¥18,000” | 计算 |
| `effectiveMode` | enum | 是 | `immediate`（付款后立即生效：开通、升级）/ `next_term`（本期结束次日 00:00 生效：续费、降级、下期换版本） | 计算（d1:855-859） |
| `newTerm` | object \| null | 是 | 新周期的起止（日期，含头含尾）；`upgrade` 为 null | 计算：`subscribe` 起于今日，锚定日按今日；其余接在链尾（链尾 `subscription_term.end_date` + 1 天），锚定日沿用链尾（d1:135-158、905-908） |
| `newTerm.startDate` | string(date) | 是 | 起始日 | 同上 |
| `newTerm.endDate` | string(date) | 是 | 止日 | 同上 |
| `firstGrantDate` | string(date) \| null | 是 | 新周期首次发放套餐积分的日期；`upgrade` 为 null | = `newTerm.startDate` |
| `benefits` | object | 是 | 目标版本的权益（升级与降级的“本次变更”说明用） | `plan_revision` 当前修订 |
| `benefits.monthlyPoints` | integer(积分) | 是 | | `plan_revision.monthly_points` |
| `benefits.discountBp` | integer | 是 | | `plan_revision.discount_bp` |
| `benefits.productionModel` | enum | 是 | | `plan_revision.production_model` |
| `benefits.schedulePriority` | enum | 是 | | `plan_revision.schedule_priority` |
| `benefits.maxStores` | integer | 是 | | `plan_revision.max_stores` |
| `benefits.maxMembers` | integer \| null | 是 | | `plan_revision.max_members` |
| `benefits.hasMonthlyReport` | boolean | 是 | | `plan_revision.has_monthly_report` |
| `upgrade` | object \| null | 是 | 仅 `upgrade`：升级算式各项 | `quoteUpgrade` 的结果，与付款单快照 `BillingOrderContent`（`kind = upgrade`）同值（07-billing-ledger.md:1516） |
| `upgrade.currentTermEndDate` | string(date) | 是 | 本期止日（升级后有效期不变） | 当前周期 `subscription_term.end_date` |
| `upgrade.remainingDays` | integer | 是 | 本月剩余天数（不含今天，按 `baseDays` 封顶） | 计算（d1:957-959） |
| `upgrade.baseDays` | integer | 是 | 折算基数天数 | `billing_param`（`key = prorationBaseDays`） |
| `upgrade.remainingFullMonths` | integer | 是 | 其后已预付的整月数（季付、年付） | 计算 |
| `upgrade.feeDeltaPerMonthFen` | integer(分) | 是 | 每月差价 | 计算 |
| `upgrade.monthlyDeltaPoints` | integer(积分) | 是 | 每月积分差 | 计算；付款单快照里的键名是 `pointsDeltaPerMonth`（07-billing-ledger.md:1516），接口按 C32 改名 |
| `upgrade.proratedFen` | integer(分) | 是 | 本月折算差价 | 计算 |
| `upgrade.topupPoints` | integer(积分) | 是 | 立即补发的套餐积分 | 计算 |
| `downgradeImpact` | object \| null | 是 | 仅 `downgrade`：新周期生效前须移除的超额门店与成员数；任一项大于 0 时，创建付款单须带回这两个数（`acknowledgedDowngradeImpact`，3.7） | 计算（`tenant.previewQuota`，d4-identity.md:682）：门店 = max(0, m02 2.1 的 `storesUsed` − coalesce(`entity.store_limit_override`, 目标 `max_stores`))；成员 = max(0, m02 2.1 的 `seatsUsed` − coalesce(`entity.member_limit_override`, 目标 `max_members`))，目标不限时为 0（PRD §2.2-6；d1:1000-1003） |
| `downgradeImpact.storesToRemove` | integer | 是 | | 同上 |
| `downgradeImpact.membersToRemove` | integer | 是 | | 同上 |
| `promo` | object \| null | 是 | 首期优惠（沿用上一版价目一个周期）；不适用为 null | 快照 `promo`（07-billing-ledger.md:1515；`plan_revision.legacy_promo`） |
| `promo.type` | string | 是 | V1.0 只有 `previous_revision` | `plan_revision.legacy_promo` |
| `promo.appliedRevisionId` | string(uuid) | 是 | 实际计价用的修订 | 计算 |
| `validUntil` | string(date-time) \| null | 是 | 仅 `upgrade`：报价有效期截止 = min(本期 `ends_at`, 现在 + 参数 `billing.upgrade_quote_valid_hours`) | 计算（d1:963、993） |
| `quotedAt` | string(date-time) | 是 | 报价时刻（账本时钟） | 计算 |
| `policy` | `PurchasePolicy` | 是 | 按本次类型与金额求值的购买策略 | 2.1 |

### 2.4 `PointPackCard` 加购积分包

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `pointPackId` | string(uuid) | 是 | | `point_pack.id` |
| `points` | integer(积分) | 是 | 积分数 | `point_pack.points` |
| `priceFen` | integer(分) \| null | 是 | 价格；`isPriceShown = false` 时为 null。价格可以不等于积分数（d1:1771 C26） | `point_pack.price_fen` |

### 2.5 `PaymentOrderCard` 付款单卡片

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `paymentOrderId` | string(uuid) | 是 | | `billing_order.id` |
| `orderNo` | string | 是 | 付款单号 `FK…`；也是对公转账备注 | `billing_order.order_no` |
| `type` | enum | 是 | 同数据模型 `billing_order.type` | `billing_order.type` |
| `status` | enum | 是 | 同数据模型 `billing_order.status` | `billing_order.status` |
| `channel` | enum | 是 | 同数据模型 `billing_order.channel` | `billing_order.channel` |
| `transferState` | enum \| null | 是 | 对公子状态；同数据模型 `billing_order.transfer_state` | `billing_order.transfer_state` |
| `amountFen` | integer(分) | 是 | 应付 | `billing_order.amount_fen` |
| `title` | string | 是 | 如“续费专业版 · 1 个月”“升级旗舰版（本期剩余 12 天）”“加购积分 1,000” | 计算：按 `billing_order.type` 与 `billing_order.content_snapshot`（`planId` 取 `plan.name`、`months`、`remainingDays`、`points`）渲染 |
| `createdAt` | string(date-time) | 是 | | `billing_order.created_at` |
| `paidAt` | string(date-time) \| null | 是 | 收款时间 | `billing_order.paid_at` |
| `invoiceItemName` | string \| null | 是 | 开票项目（如“会员服务费”“积分充值”）；未支付为 null | 参数 `invoice.item_name.{type}` 的当前值（`param_value.value`） |
| `invoiceState` | enum(`PaymentOrderInvoiceState`) | 是 | 本单的开票状态，“可开票”页签与卡片角标用：`eligible` 可申请 / `applying` 已申请、开票中 / `invoiced` 已开票 / `expired` 超过申请时限 / `not_eligible` 不可开票。判定见 3.13 说明 | 计算 |
| `activeInvoiceRequest` | object \| null | 是 | 有效开票申请 `{ invoiceRequestId, requestNo, status }`（原型“已申请，开票中”）；没有为 null | `invoice_request`（该单 `status` 为 `pending` / `issued` / `red_pending` 的一行，`uq_invoice_request_active`） |
| `actions` | array<string> | 是 | 当前可执行的动作，取值见第 4.3 节 | 计算（C16） |

### 2.6 `PaymentOrderDetail` 付款单详情

包含 `PaymentOrderCard` 的全部字段，另有：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `paidAmountFen` | integer(分) | 是 | 实收；未支付为 0 | `billing_order.paid_amount_fen` |
| `refundedAmountFen` | integer(分) | 是 | 已退 | `billing_order.refunded_amount_fen` |
| `fulfillmentStatus` | enum | 是 | 同数据模型 `billing_order.fulfillment_status` | `billing_order.fulfillment_status` |
| `formula` | object \| null | 是 | `{ code, args, text }`，含义同 2.3；灾备重建的付款单为 null | `billing_order.formula_code`、`billing_order.formula_args` |
| `content` | `PaymentOrderContentView` | 是 | 购买内容 | `billing_order.content_snapshot` |
| `expiresAt` | string(date-time) | 是 | 待支付截止时间 | `billing_order.expires_at` |
| `isConfirmingResult` | boolean | 是 | “已超时，正在确认支付结果”：微信付款单仍为 `pending_payment` 且已过 `expires_at`（d2:667） | 计算 |
| `isProcessingReceipt` | boolean | 是 | “已收到付款，正在处理”：(`status = paid` 且 `fulfillment_status = blocked`) 或 (`status = cancelled` 且 `has_open_exception = true`)（d2:668；08-billing-payment.md:199） | `billing_order.status`、`billing_order.fulfillment_status`、`billing_order.has_open_exception` |
| `cancelledAt` | string(date-time) \| null | 是 | | `billing_order.cancelled_at` |
| `cancelReason` | enum \| null | 是 | 同数据模型 `billing_order.cancel_reason` | `billing_order.cancel_reason` |
| `refundedAt` | string(date-time) \| null | 是 | | `billing_order.refunded_at` |
| `fulfillment` | object \| null | 是 | 履约结果；`fulfillment_status = done` 时有值 | `billing_order.fulfillment_result`（`FulfillResult`，08-billing-payment.md:1383） |
| `fulfillment.effectiveAt` | string(date-time) | 是 | 生效时刻：开通、过期后续费、升级、加购 = 履约时刻；生效期间续费 = 本期结束次日 00:00 | `fulfillment_result.effectiveAt` |
| `fulfillment.isQueuedBehindActive` | boolean | 是 | 已有生效周期，排成预约周期 | `fulfillment_result.queuedBehindActive` |
| `fulfillment.term` | object \| null | 是 | 套餐与升级：履约出的周期 `{ planName, startDate, endDate }`；加购为 null | `fulfillment_result.termId` 指向的 `subscription_term.start_date`、`subscription_term.end_date`，版本名取 `plan.name`（`subscription_term.plan_id`） |
| `fulfillment.points` | integer(积分) \| null | 是 | 付款结果展示的积分：开通、续费 = 每月发放数；升级 = 补发数；加购 = 到账数 | 快照 `monthlyPoints` / `topupPoints` / `points` |
| `bankAccount` | `BankAccountView` \| null | 是 | 对公付款单的收款账户（创建时生效的版本）；微信为 null | `billing_order.bank_account_finance_config_revision_id` 指向的 `finance_config_revision` |
| `latestTransferProof` | `TransferProofView` \| null | 是 | 最近一次上传的凭证；没有为 null | `transfer_proof`（该付款单 `upload_no` 最大的一行） |
| `channels` | array<`PurchaseChannel`> | 是 | 按本单金额、类型与当前请求平台求值的渠道（2.1）；结果页据此决定“继续支付”之外是否给“改用对公转账”等入口（d2:706；d7:732）；付款单不是 `pending_payment` 时为 `[]` | `billing.getPurchasePolicy`（带本单 `amount_fen`、`type`） |

`PaymentOrderContentView`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `kind` | enum | 是 | `plan` / `upgrade` / `topup` | `content_snapshot.kind` |
| `planId` | string(uuid) \| null | 是 | 套餐：目标版本；升级：目标版本；加购为 null | `content_snapshot.planId`；升级取 `toPlanRevisionId` 所属的 `plan_revision.plan_id` |
| `planName` | string \| null | 是 | | `plan.name` |
| `months` | integer \| null | 是 | 仅 `plan` | `content_snapshot.months` |
| `pointPackId` | string(uuid) \| null | 是 | 仅 `topup` | `content_snapshot.packId` |
| `points` | integer(积分) \| null | 是 | 仅 `topup` | `content_snapshot.points` |
| `upgrade` | object \| null | 是 | 仅 `upgrade`：`{ fromPlanName, remainingDays, topupPoints, validUntil }` | `content_snapshot` 的 `fromPlanRevisionId`（取版本名）、`remainingDays`、`topupPoints`、`validUntil` |

`BankAccountView`（对公转账弹层 M10，PlanPick:L32-43）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `accountName` | string | 是 | 户名 | `finance_config_revision.payload.accountName` |
| `bankName` | string | 是 | 开户行 | `finance_config_revision.payload.bankName` |
| `accountNo` | string \| null | 是 | 收款账号明文，供商家复制转账；只在 `m.paymentOrder.create` 的同键重放结果里为 null（结果脱敏，此时改调 `m.paymentOrder.get` 取） | 解密 `finance_config_revision.account_no_enc` |
| `accountNoMask` | string | 是 | 脱敏串 | `finance_config_revision.account_no_mask` |
| `transferRemark` | string | 是 | 转账备注 = 付款单号 | `billing_order.order_no` |

平台收款账号不是商家的个人信息，商家必须看到全文才能转账（d2:722），按 A89 作为 C40 的明文例外返回（待法务、财务确认，第 6 节）；含它的响应带 `Cache-Control: no-store`（C18）。明文不落进幂等记录（C50 结果脱敏）。

`TransferProofView`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `transferProofId` | string(uuid) | 是 | | `transfer_proof.id` |
| `uploadNo` | integer | 是 | 第几次上传 | `transfer_proof.upload_no` |
| `reviewStatus` | enum | 是 | 同数据模型 `transfer_proof.review_status` | `transfer_proof.review_status` |
| `uploadedAt` | string(date-time) | 是 | | `transfer_proof.uploaded_at` |
| `dueAt` | string(date-time) \| null | 是 | 财务应确认的截止时间（上传后 1 个工作日） | `transfer_proof.due_at` |
| `reviewedAt` | string(date-time) \| null | 是 | | `transfer_proof.reviewed_at` |
| `rejectReason` | `DictRef` \| null | 是 | 驳回原因 `{ code, name }`（字典 `reject_reason`，场景 `transfer`；C85、A151） | `transfer_proof.reject_reason_code`，名称取当前 `dict_item.name`（停用后仍返回） |
| `rejectNote` | string \| null | 是 | 驳回说明 | `transfer_proof.reject_note` |

不返回凭证图片地址：取凭证图片要逐次留痕（d4-identity.md:1737），按 A19 不能在 GET 里签发（见第 6 节第 1 项）。

### 2.7 `Wallet` 套餐与积分

| 字段 | 类型 | 必有 | 说明 | 来源（计算规则） |
| --- | --- | --- | --- | --- |
| `subscription` | object | 是 | 订阅 | 见下 |
| `subscription.status` | enum(`SubscriptionStatus`) | 是 | `none` 从未开通 / `active` 生效中 / `expired` 已过期 | `getEntitlements` 现算（取值同数据模型 `billing_account.sub_status`，但不读缓存） |
| `subscription.isRefundPending` | boolean | 是 | 套餐退款处理中（可花积分为 0，不能购买与订购）；主体级，预约周期被标记也算 | 本主体任一 `subscription_term.status` 为 `scheduled` / `active` 的周期 `subscription_term.refund_request_id` 非空（2.0“退款处理中”） |
| `subscription.plan` | object \| null | 是 | `{ planId, code, name }`：生效中取当前周期的版本；已过期取最近结束的周期的版本；从未开通为 null | `subscription_term.plan_id` → `plan.id`、`plan.code`、`plan.name` |
| `subscription.months` | integer \| null | 是 | 购买周期，月付 / 季付 / 年付 | `subscription_term.months` |
| `subscription.startDate` | string(date) \| null | 是 | | `subscription_term.start_date` |
| `subscription.endDate` | string(date) \| null | 是 | 止日（含补偿延长） | `subscription_term.end_date` |
| `subscription.endsAt` | string(date-time) \| null | 是 | 到期时刻（= 止日次日 00:00）；已过期时为“已于 … 24:00 到期” | `subscription_term.ends_at` |
| `subscription.remainingDays` | integer \| null | 是 | 剩余天数 = 止日 − 今日（北京时间），如 09-30 看 10-12 到期为 12；非生效中为 null | 计算（proto-merchant-a.md:630；d1:966） |
| `subscription.benefits` | object \| null | 是 | 权益快照：`{ discountBp, monthlyPoints, productionModel, schedulePriority, hasMonthlyReport, maxStores, maxMembers }`；已过期时为最近周期的权益（“续费后立即恢复：发放新一期 6,600 积分”） | `subscription_term` 的同名列（`max_members` 为空 = 不限） |
| `subscription.scheduledTerms` | array<object> | 是 | 已付款、未生效的预约周期 `{ planName, months, startDate, endDate }` | `subscription_term`（`status = scheduled`），版本名取 `plan.name` |
| `usage` | object | 是 | 名额占用，口径与字段名同 m02 第 2.1 节（`tenant.getQuotaUsage`），本文不另算 | 见下 |
| `usage.storesUsed` | integer | 是 | 启用中的门店数 | m02 2.1：本主体 `store.lifecycle = active` 的门店数 |
| `usage.storeLimit` | integer | 是 | 门店上限 | m02 2.1：`entity.store_limit_override`；为空时订阅生效取当前周期 `subscription_term.max_stores`，否则取参数 `tenant.default_store_limit`（默认 1）（d4-identity.md:646-648、684） |
| `usage.seatsUsed` | integer | 是 | 成员数（含待接受邀请，不含老板） | m02 2.1：`entity_member`（`role = clerk`，`status = active`）计数 + `invitation`（`status = pending` 且 `expires_at > now`）计数（PRD §2.2-1；proto-merchant-a.md:646） |
| `usage.memberLimit` | integer \| null | 是 | 成员上限；null 只表示不限（旗舰版） | m02 2.1：`entity.member_limit_override`；为空时订阅生效取 `subscription_term.max_members`（空 = 不限），否则取参数 `tenant.default_member_limit`（默认 3） |
| `usage.limitReason` | enum | 是 | `plan` 按套餐 / `inactive` 套餐未生效、按参数默认值；只用于文案（引导升级，或引导开通、续费） | m02 2.1 |
| `points` | object | 是 | 积分 | 见下 |
| `points.spendablePoints` | integer(积分) | 是 | 可用积分 = 生效中且不在退款处理中 ? 套餐可用 + 加购可用 : 0；过期时不含加购积分 | `billing_account.plan_available_qty`、`billing_account.addon_available_qty`（d1:328）；闸门见 2.0“退款处理中” |
| `points.planAvailablePoints` | integer(积分) | 是 | 套餐积分（本期到点清零的部分；m04 首页的 `expiringPlanPoints` 即此值） | `billing_account.plan_available_qty` |
| `points.addonAvailablePoints` | integer(积分) | 是 | 加购积分（含停用的） | `billing_account.addon_available_qty` |
| `points.heldPoints` | integer(积分) | 是 | 冻结中（订购与广告占用）；是否展示由前端定（d1:1770 C25） | `billing_account.held_total_qty` |
| `points.isAddonSuspended` | boolean | 是 | 加购积分停用（套餐过期，续费后恢复）；文案用“停用”或沿用原型“冻结”由产品定（d1:1746 C1，第 6 节） | 计算：`subscription.status ≠ active` 且 `addonAvailablePoints > 0` |
| `points.planGrantedThisTermPoints` | integer(积分) | 是 | 本期已发放的套餐积分（“本期发放 6,600”） | 当前周期的套餐批次 `point_lot.original_qty` 之和（`point_lot.subscription_term_id` = 当前周期，`point_lot.kind = plan`） |
| `points.planPointsExpireAt` | string(date-time) \| null | 是 | 本期套餐积分清零时刻（“10-12 24:00 清零”）；非生效中为 null | 当前周期 `subscription_term.ends_at` |
| `points.lastExpired` | object \| null | 是 | 最近一次期末清零 `{ expiredPoints, expiredAt }`（“10-12 24:00 已清零 1,920”） | `billing_account.last_expired_qty`、`billing_account.last_expired_at` |
| `topUp` | object | 是 | 加购入口状态（M:TopUp 的拦截态，原型未画，proto-merchant-a.md:750） | 见下 |
| `topUp.canTopUp` | boolean | 是 | 此刻能否加购 | 计算：`topUp.blockReason` 为 null |
| `topUp.blockReason` | enum(`TopUpBlockReason`) \| null | 是 | `no_active_plan` 套餐未生效（PRD §6.15）/ `refund_in_progress` 套餐退款处理中（2.0）/ `not_offered` 购买策略不提供（`mode ≠ in_app`）；能加购为 null。多项同时成立时按此顺序取第一项 | 计算：`subscription.status`、`subscription.isRefundPending`、`billing.getPurchasePolicy`（类型 `topup`，不带金额） |
| `rules` | object | 是 | “积分怎么用”的规则参数（此刻生效值） | 见下 |
| `rules.adUnitPoints` | integer(积分) | 是 | 广告每条积分 | `billing_param`（`key = adUnitPoints`） |
| `rules.discountedAdUnitPoints` | integer(积分) \| null | 是 | 按当前折扣的广告每条积分（“专业版 9 折为 45”）；非生效中为 null | `billing.quoteAdUnit` 的 `S`（d1:1649；取整按 d1:160-176） |
| `rules.adFreeRevisions` | integer | 是 | 每条免费修改次数 | `billing_param`（`key = adFreeRevisions`） |
| `rules.topModelSurchargeBp` | integer | 是 | 顶级模型加扣比例 | `billing_param`（`key = topModelSurchargeBp`） |

### 2.8 `LedgerEntryRow` 积分明细行

存储是“每批次一行”（`point_ledger_entry`），展示是“每次账本操作 × 积分类型一行”（d1:1406-1408）：取 `ledger_operation` 的 `plan_delta_qty`、`addon_delta_qty`，非零的各成一行；同一事务里同一 `op_type`、同一 `point_hold.group_ref` 的冻结（一次订购多部剧，`group_ref` = 订购单号）合并为一行。广告每次提交一条（m06 `m.ad.create`，一条一个事务），`group_ref` 就是该条的广告编号（09-order-ad.md:681），所以广告按条出行；原型的“广告制作 · 4 条”“GG20260928001～004”（Ledger.dc.html:48；proto-merchant-a.md:779）V1.0 不做（A146：草案 d1 第 7.9 节的广告聚合以契约为准）；以后要合并，须 m06 增加批量提交并定义共享的批次键（写入 `point_hold.group_ref`），`refNo` 改为可表达区间或列表。

| 字段 | 类型 | 必有 | 说明 | 来源（计算规则） |
| --- | --- | --- | --- | --- |
| `rowKey` | string | 是 | 行标识（列表键），= 首个操作的 id + 积分类型 | `ledger_operation.id` |
| `category` | enum(`LedgerCategory`) | 是 | `gain` 获得 / `use` 使用 / `expire` 过期 / `other` 停用与恢复（只在“全部”里出现） | `ledger_operation.op_type` 按第 4.2 节映射 |
| `opType` | enum | 是 | 同数据模型 `ledger_operation.op_type` | `ledger_operation.op_type` |
| `lotKind` | enum \| null | 是 | `plan` 套餐积分 / `addon` 加购积分（来源标签）；`other` 行为 null | 取自哪一列的净变动 |
| `deltaPoints` | integer(积分) | 是 | 带符号的数量；`other` 行为 0 | `ledger_operation.plan_delta_qty` 或 `ledger_operation.addon_delta_qty`（合并行求和） |
| `occurredAt` | string(date-time) | 是 | 业务生效时刻（到点类取逻辑时间，如“09-12 24:00 清零”） | `ledger_operation.occurred_at` |
| `bizDate` | string(date) | 是 | 归属业务日，按月分段依据 | `ledger_operation.biz_date` |
| `title` | string | 是 | 如“订购《巷口那家店》《二次开业》”“发放本期套餐积分” | 服务端按 `ledger_operation.title_code`、`ledger_operation.title_args` 渲染（第 4.5 节） |
| `remark` | string \| null | 是 | 备注 1：门店 · 关联单号，或付款单号、周期说明（如“专业版续费，本期 09-13 至 10-12”） | 同上；门店取 `store.name`（`ledger_operation.store_id`），单号取 `point_hold.group_ref` 或 `billing_order.order_no` |
| `formula` | string \| null | 是 | 备注 2：计算式或支付信息（如“(3,000 ＋ 2,000) × 9 折”“微信支付 ¥1,000”） | 同上 |
| `storeName` | string \| null | 是 | 门店名称；主体级操作为 null | `store.name` |
| `refNo` | string \| null | 是 | 关联单号（订购单 `LYX…`、广告 `GG…`、付款单 `FK…`） | `point_hold.group_ref`；付款类取 `billing_order.order_no` |
| `itemCount` | integer | 是 | 合并的冻结数（一次订购的部数），未合并为 1 | 计算 |
| `holdStatus` | enum \| null | 是 | 仅冻结行：同数据模型 `point_hold.status`（“已冻结 / 已扣减”）；合并行取最早未扣减的状态 | `point_hold.status`（扣减 `capture` 不单独成行，只更新这里，d1:1415） |

### 2.9 `InvoiceRequestCard` 开票申请

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `invoiceRequestId` | string(uuid) | 是 | | `invoice_request.id` |
| `requestNo` | string | 是 | 申请单号 `KP…` | `invoice_request.request_no` |
| `paymentOrderId` | string(uuid) | 是 | | `invoice_request.billing_order_id` |
| `paymentOrderNo` | string | 是 | | `billing_order.order_no` |
| `paymentOrderTitle` | string | 是 | 如“开通专业版 · 1 个月” | 同 `PaymentOrderCard.title` |
| `invoiceType` | enum | 是 | 同数据模型 `invoice_request.invoice_type` | `invoice_request.invoice_type` |
| `medium` | enum | 是 | 同数据模型 `invoice_request.medium` | `invoice_request.medium` |
| `itemName` | string | 是 | 开票项目快照 | `invoice_request.item_name` |
| `status` | enum | 是 | 同数据模型 `invoice_request.status`；显示为 开票中 / 已开具（纸质为“已寄出”）/ 已驳回 / 红冲中 / 已红冲 | `invoice_request.status` |
| `amountFen` | integer(分) | 是 | 开票金额 | `invoice_request.amount_fen` |
| `title` | string | 是 | 抬头快照 | `invoice_request.title` |
| `taxNoMask` | string | 是 | 税号脱敏串 | `invoice_request.tax_no_mask` |
| `recvEmailMask` | string \| null | 是 | 接收邮箱脱敏串（电子） | `invoice_request.recv_email_mask` |
| `mailToMask` | string \| null | 是 | 收件信息脱敏串（纸质） | `invoice_request.mail_to_mask` |
| `appliedAt` | string(date-time) | 是 | | `invoice_request.applied_at` |
| `isHeldByRefund` | boolean | 是 | 退款处理中，暂停开具 | `invoice_request.held_by_refund_request_id` 非空 |
| `reject` | object \| null | 是 | `rejected` 时有值：`{ kind, reason: DictRef \| null, note, rejectedAt }`；`reason` 仅 `kind = manual` 时有值（字典 `reject_reason` 场景 `invoice`，C85、A151），`order_refunded` 时为 null、端上按 `kind` 显示“付款单已退款” | `invoice_request.reject_kind`、`invoice_request.reject_reason_code`（名称取当前 `dict_item.name`）、`invoice_request.reject_note`、`invoice_request.rejected_at` |
| `progressNote` | string | 是 | 进度说明，如“财务审核中，开具后通知您”“已发送至 yunjian****@163.com”“已寄出：顺丰速运 SF…” | 计算：按 `status`、`isHeldByRefund`、蓝字票据的 `invoice_doc.email_state`、`invoice_doc.express_company`、`invoice_doc.tracking_no` 渲染 |
| `docs` | array<`InvoiceDocView`> | 是 | 已开具的票据（蓝字、红字）；没有为 `[]` | `invoice_doc` |
| `actions` | array<string> | 是 | V1.0 恒为 `[]`；下载按钮看 `docs[].hasFile` | C16 |

`InvoiceDocView`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `docKind` | enum | 是 | 同数据模型 `invoice_doc.doc_kind` | `invoice_doc.doc_kind` |
| `invoiceNo` | string | 是 | 发票号码 | `invoice_doc.invoice_no` |
| `invoiceCode` | string \| null | 是 | 发票代码；数电发票为 null | `invoice_doc.invoice_code` |
| `amountFen` | integer(分) | 是 | 票面金额，红字为负 | `invoice_doc.amount_fen` |
| `issuedAt` | string(date-time) | 是 | 开具时间 | `invoice_doc.issued_at` |
| `hasFile` | boolean | 是 | 有可下载的文件 | `invoice_doc.file_id` 非空 |
| `fileFormat` | enum \| null | 是 | 同数据模型 `invoice_doc.file_format` | `invoice_doc.file_format` |
| `expressCompany` | `DictRef` \| null | 是 | 快递公司 `{ code, name }`（纸质；字典 `express_company`，C85、A151） | `invoice_doc.express_company`，名称取当前 `dict_item.name` |
| `trackingNo` | string \| null | 是 | 运单号（纸质） | `invoice_doc.tracking_no` |
| `shippedAt` | string(date-time) \| null | 是 | | `invoice_doc.shipped_at` |
| `emailState` | enum | 是 | 同数据模型 `invoice_doc.email_state` | `invoice_doc.email_state` |

### 2.10 `InvoiceContext` 开票页上下文

随 `m.invoiceRequest.summary` 返回（见 3.16 说明）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `invoiceTitle` | object | 是 | 抬头卡（Invoices:L20） | 见下 |
| `invoiceTitle.entityName` | string \| null | 是 | 主体名称；未认证为 null | `entity.name` |
| `invoiceTitle.taxNoMask` | string \| null | 是 | 统一社会信用代码脱敏串（前 12 后 2） | `entity.uscc_mask` |
| `invoiceTitle.isVerified` | boolean | 是 | 主体已认证（开票的前提） | `entity.verification_status = verified` |
| `applyDefaults` | object | 是 | 申请弹层的默认值（可编辑） | 见下 |
| `applyDefaults.recipientName` | string \| null | 是 | 默认收件人（当前门店的资质联系人） | `store_profile.contact_name` |
| `applyDefaults.contactPhoneMask` | string \| null | 是 | 资质联系人手机号脱敏串（选 `phoneSource = store_contact` 时用它） | `store_profile.contact_phone_mask` |
| `applyDefaults.loginPhoneMask` | string \| null | 是 | 登录手机号脱敏串（选 `phoneSource = login` 时用它） | `merchant_user.phone_mask` |
| `applyDefaults.address` | string \| null | 是 | 默认邮寄地址（当前门店地址，公开信息） | 字典 `region` 的 `dict_item.name`（`store_profile.province_code`、`store_profile.city_code`、`store_profile.district_code`）拼接 `store_profile.address_detail` |
| `applyDefaults.addrTel` | string \| null | 是 | 专票“地址与电话”的建议值 | 上面的地址拼接 `store_profile.store_tel` |

## 3. 接口

### 3.1 m.wallet.get　套餐与积分
`GET /m/wallet`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `wallet.read`；店员视图 `none` |
| 幂等 | none（纯查询，GET 不写库，A18、A19） |
| 乐观锁 | 不涉及 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Wallet、M:WalletExpired（一页两态）；M:TopUp、M:Ledger、M:PlanPick 的余额与当前套餐区；M:Mine、M:Ads 的积分展示 |
| 出处 | 路线图 `m07.wallet.get`；d1:1699；proto-merchant-a.md:622-673；07-billing-ledger.md:430-442 |

**请求**：路径参数、查询参数、请求体：无。

**响应**：`data` 为 `Wallet`（2.7）。

**错误**：无（通用错误按约定）。

**副作用**：无。账本读取不 `advance`；到点未推进的周期由“套餐状态现算”保证展示正确（d1:844）。

**说明**：
- `/m/wallet` 是 `point-accounts` 资源在当前门店所属主体上的单例视图（A5 第二类；`resources.json`）。
- 过期态（M:WalletExpired）：`subscription.status = expired`、`points.spendablePoints = 0`、`points.isAddonSuspended = true`、`points.lastExpired` 有值；名额按参数默认值（`usage.limitReason = inactive`，05-risks-and-open-issues.md:219）。底部“续费专业版 ¥6,000”的价格取 `m.plan.list`，购买策略不允许时不出现按钮（2.0“购买入口”）。“已订购的短剧继续交付、上线”的剧名取 `m.orderItem.list?tab=to_launch`（m04），本接口不读订购侧的表。
- 首页的上线概览积分卡取 m04 `m.home.get` 的 `launchOverview`，“我的”页的套餐积分卡取 m08 `m.me.overview.get` 的 `OverviewPlanCard`；两处都经 `billing.getWalletView`（第 1 节），口径与字段名同本结构。
- 续费、升级、加购入口是否出现看 `m.purchasePolicy.get` 的 `isPurchasePromptAllowed`；M:TopUp 的拦截态（套餐未生效、退款处理中、不提供购买）看 `topUp`。

### 3.2 m.pointLedgerEntry.list　积分明细
`GET /m/point-ledger-entries`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ledger.read`；店员视图 `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 不涉及 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Ledger（M46）；补充状态：触底加载 |
| 出处 | 路线图 `m07.point-ledger-entry.list`；d1:1703、1406-1421；proto-merchant-a.md:755-782；A34；C42 |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum(`LedgerTab`) | 否 | `all` / `gain` / `use` / `expire`，默认 `all` | 页签（路线图 `group=` 按 A24 改 `tab=`） |
| 查询 | `month` | string | 否 | `YYYY-MM`，默认当月（北京时间） | 分段月份，按 `ledger_operation.biz_date` 归月 |
| 查询 | `cursor` | string | 否 | 不透明 | 段内游标，首页不传 |
| 查询 | `limit` | integer | 否 | 1–50，默认 20 | |

**响应**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | array<`LedgerEntryRow`> | 按 `occurredAt` 倒序（同一时刻按 `ledger_operation.seq` 倒序）；本段该页签没有记录为 `[]`（“本月没有此类记录”） |
| `nextCursor` | string \| null | 段内下一页 |
| `hasMore` | boolean | 段内是否还有 |
| `month` | string | 本段月份 |
| `prevMonth` | string \| null | 更早的、有记录的最近月份（不分页签），没有为 null；端上据此显示“查看 N 月记录” |
| `firstEntryAt` | string(date-time) \| null | 该主体最早一条记录的时刻，没有为 null；与 `prevMonth = null` 一起显示“已显示全部记录（2026-08-13 首次开通套餐）” |

分页：月份分段 + 段内游标（C42、A34），不返回总数。

**错误**：`VALIDATION_FAILED`（`month` 格式不对或晚于当月）。

**副作用**：无。

**说明**：
- 页头余额（可用、套餐积分、加购积分）取 `m.wallet.get`。
- 冻结（`hold`）在“使用”里显示一行，开始制作后的扣减（`capture`）不另起一行，只更新该行的 `holdStatus`（d1:1414-1415）；原型明细里看不到冻结，这里按 d1 第 7.9 节的映射（proto-merchant-a.md:777）。广告按条出行（2.8）。
- 一笔订购同时扣了套餐积分与加购积分时拆成两行，各带来源标签（d1:1408；proto-merchant-a.md:778）。
- 只做幂等登记的操作（`fulfill`、`extend`）不出行；人工修复 `fix` 按变动方向归“获得”或“使用”。

### 3.3 m.purchasePolicy.get　购买策略
`GET /m/purchase-policy`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `plan.purchase`；店员视图 `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 不涉及 |
| 限流 / 开关 | `m.global`；购买入口不走通用开关（d7:525） |
| 对应画板 | M:Wallet、M:WalletExpired（续费、升级、加购入口）；M:PlanPick、M:TopUp（价格货架、渠道与协议文案，选定金额前）；M:Cart（积分不足的引导）；M:Mine |
| 出处 | 路线图 `m07.purchase-policy.get`；d2:1291-1346、1457；d7:525、733；05-risks-and-open-issues.md:41 |

**请求**：无。平台与版本取请求头 `X-Client-Platform`、`X-Client-Version`。

**响应**：`data` 为 `PurchasePolicy`（2.1），没有金额上下文时渠道只按配置判断。

**错误**：无。

**副作用**：无。

**说明**：
- 只读聚合视图，资源登记为 `purchase-policy`（`table: null`，读 `finance_config_revision`）。
- 能力点取 `plan.purchase`（店员 403），与 `wallet.read` 的角色集合相同（d4-identity.md:864）。
- 求值函数 `billing.getPurchasePolicy` 也供 m08 的启动引导与订阅设置裁剪订阅点位（第 1 节）。
- `mode` 为 `offline_contract` 或 `hidden` 时，页面不出现价格货架、支付按钮与任何“去续费 / 去加购 / 去升级”（d2:1318-1334）；这是应对“虚拟支付”定性的退路 B（05-risks-and-open-issues.md:41）。规则表不设“审核态”维度（d2:1346）。

### 3.4 m.plan.list　套餐版本
`GET /m/plans`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `plan.purchase`；店员视图 `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 不涉及 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:PlanPick 的版本卡与购买周期；M:WalletExpired 的“续费专业版 ¥X” |
| 出处 | 路线图 `m07.plan.list`；d1:1700；proto-merchant-a.md:686-687 |

**请求**：无。

**响应**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | array<`PlanCard`> | 上架中（`plan.is_listed = true`、`plan.scope = public`）且有当前价目修订的版本，按 `plan.rank` 升序；购买策略 `mode ≠ in_app` 时为 `[]` |

有界小集合，不分页，`data = { items }`（C42、A78）。

**错误**：无。

**副作用**：无。

**说明**：
- PlanPick 顶部的“当前有效期 … 剩 N 天”取 `m.wallet.get`；购买策略（是否展示价格、渠道、文案键）取 `m.purchasePolicy.get`，选定版本与周期后以 `m.plan.quote` 的 `policy` 为准；可选购买周期取各版本 `cyclePrices[].months`（只含参数 `enabledCycles` 启用的周期）。
- “plans”专指套餐版本，交付方案是 `delivery-plans`（A4）。

### 3.5 m.plan.quote　套餐报价
`POST /m/plans/quote`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `plan.purchase`；店员视图 `none` |
| 幂等 | none（试算，不写库、不缓存、不拿账户锁，A18、A20、C13） |
| 乐观锁 | 不涉及 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:PlanPick 的“本次变更”区（续费、升级、降级三种写法）与主按钮金额；M:WalletExpired |
| 出处 | 路线图 `m07.plan.quote`；d1:1701、849-864、951-1003；d2:1456；proto-merchant-a.md:688-690、702 |

**请求**（请求体）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `planId` | string(uuid) | 是 | 上架中的版本 | 目标版本 |
| `months` | integer | 否 | 须在参数 `enabledCycles` 内 | 购买月数；判定为 `upgrade` 时忽略；其余动作缺省时返回 `VALIDATION_FAILED`（“请选择购买周期”） |
| `intent` | enum | 否 | `upgrade_now`（缺省）/ `renew_next_term` | 目标版本更高时：立即升级，或续费更高版本、下期生效（d1:861） |

**响应**：`data` 为 `PlanQuote`（2.3）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 非升级动作缺 `months` |
| `NOT_FOUND` | 404 | `planId` 不存在 |
| `PLAN_NOT_AVAILABLE` | 409 | 版本未上架，或没有生效的价目修订 |
| `CYCLE_NOT_AVAILABLE` | 400 | `months` 不在 `enabledCycles` 内 |
| `UPGRADE_NOT_ALLOWED_TODAY` | 409 | 本期最后一天升级应付为 0，或差价不为正；`details.suggest = renew_next_term`（d1:861、969-970） |
| `SCHEDULED_TERM_LIMIT` | 409 | 已有的预约周期数达到参数 `maxScheduledTerms`（默认 1） |
| `PLAN_REFUND_IN_PROGRESS` | 409 | 主体处于退款处理中（2.0；08-billing-payment.md:162） |
| `PURCHASE_NOT_OFFERED` | 403 | 购买策略 `mode ≠ in_app` |

**副作用**：无。报价只读：不拿账户锁、不 `advance`、不写账本；套餐状态与周期链按账本时钟现算（`getEntitlements`，d1:844），与 `m.wallet.get` 同一读法。d1:851 的“账户锁内先 `advance`”只在创建付款单时执行（3.7），两次结果不一致由 `expectAmountFen` 比对兜住（`QUOTE_CHANGED`）。

**说明**：
- 服务端判定动作类型，前端不传类型（d1:851）；价目取此刻生效的修订（d1:862）。
- 降级 = 现在付款、下期生效（d1:998-1003；proto-merchant-a.md:713）。`downgradeImpact` 有大于 0 的项时，确认页须让老板勾选“我知道新版本生效前需停用 N 家门店、移除 M 位成员”才能付款，创建付款单时带回这两个数（d4-identity.md:682；05-risks-and-open-issues.md:218）；新周期生效时仍超限的处理由身份子系统负责（不自动移除，d4-identity.md:678-681）。
- 已预约旧版本续费后再升级：预约周期保持原样（d1:995），页面提示由前端按 `PlanQuote.action` 与 `Wallet.subscription.scheduledTerms` 给出。
- 原型“10-13 起按旗舰版续费”理解为下次续费的价目提示，V1.0 没有自动续费（d1:1777 C32）。
- 协议版本由 `m.agreement.list?scene=plan_purchase`（m01）提供，创建付款单时提交。

### 3.6 m.pointPack.list　加购积分包
`GET /m/point-packs`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `points.topup`；店员视图 `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 不涉及 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:TopUp（M45）的积分包单选 |
| 出处 | 路线图 `m07.point-pack.list`；d1:1700；d2:1456；proto-merchant-a.md:734、750 |

**请求**：无。

**响应**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | array<`PointPackCard`> | 上架中（`point_pack.is_listed = true`）的积分包，按 `point_pack.position` 升序；购买策略 `mode ≠ in_app` 时为 `[]` |

有界小集合，不分页，`data = { items }`（C42、A78）。

**错误**：无。

**副作用**：无。

**说明**：
- “仅在套餐生效期间可购买”的拦截态原型未画（proto-merchant-a.md:750），由 `m.wallet.get` 的 `topUp.canTopUp`、`topUp.blockReason` 承载（M:TopUp 本来就调它取余额）；拦截口径与创建付款单的守卫相同（退款处理中按 2.0 的主体级口径）。
- 购买策略取 `m.purchasePolicy.get`（不带金额）；选中积分包后端上按 `priceFen` 与渠道的限额提示展示，以创建付款单时的校验为准。

### 3.7 m.paymentOrder.create　创建付款单
`POST /m/payment-orders`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；路由能力点 `plan.purchase`，加购由服务层另断言 `points.topup`（两者角色集合相同）；店员视图 `none` |
| 幂等 | required（`Idempotency-Key` 必填）；重放返回上次成功的付款单。结果脱敏（C50、A80）：幂等记录里 `bankAccount.accountNo` 置空，重放时为 null 且 `replayed = true`，端上改调 `m.paymentOrder.get` 取收款账号；`x-redact-on-replay: [bankAccount.accountNo]` |
| 乐观锁 | 否：创建；“同主体至多一张未完成的套餐类付款单”由部分唯一索引 `uq_billing_order_open_plan` 兜底（d2:525） |
| 限流 / 开关 | `m.global`；无开关（购买策略在服务端校验） |
| 对应画板 | M:PlanPick 与 M:TopUp 的主按钮“微信支付 ¥X / 对公转账 ¥X”；M10 弹层的付款单号与收款账户 |
| 出处 | 路线图 `m07.payment-order.create`；d2:487-525、449-450、696-708；d1:1702；d7:710-711；08-billing-payment.md:162-163、179；proto-merchant-a.md:703、719 |

**请求**（请求体，`planId` 与 `pointPackId` 二选一）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `planId` | string(uuid) | 套餐必填 | | 同 `m.plan.quote` |
| `months` | integer | 否 | 同 `m.plan.quote` | |
| `intent` | enum | 否 | `upgrade_now` / `renew_next_term` | 同 `m.plan.quote` |
| `pointPackId` | string(uuid) | 加购必填 | 上架中的积分包 | |
| `channel` | enum(`billing_order.channel`) | 是 | `wechat_jsapi` / `bank_transfer` | 支付方式 |
| `expectAmountFen` | integer(分) | 是 | > 0 | 页面展示的应付（报价或积分包价格），服务端重算比对 |
| `agreementVersionIds` | array<string(uuid)> | 是 | 1–2 项 | 本次“付款即表示同意”的协议版本：套餐为《会员服务协议》《积分规则》，加购为《积分规则》，须是此刻的现行版本（C73）。交易接口只提交版本 id，协议键由服务端补（m01-account 2.7、3.12） |
| `acknowledgedDowngradeImpact` | object | 降级且有须移除项时必填 | `{ storesToRemove, membersToRemove }`，非负整数 | 老板在确认页勾选“我知道新版本生效前需停用 N 家门店、移除 M 位成员”时看到的两个数，原样取报价的 `downgradeImpact`（d4-identity.md:682）；其他动作不传 |

不传付款类型，类型由服务端按报价判定（d2:201）。不接收门店：下单门店取 `X-Store-Id`，只作展示（`billing_order.store_id`）。

**响应**：`data` 为 `PaymentOrderCreateResult`：`PaymentOrderDetail`（2.6）的全部字段，另加 `replayed`（boolean，同键重放为真）。对公付款单带 `bankAccount`（收款账户与转账备注 = 付款单号，d2:513）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | `planId`、`pointPackId` 都传或都不传；缺 `months` 等；判定为降级且有须移除项，却没带 `acknowledgedDowngradeImpact`（`fieldErrors.path = acknowledgedDowngradeImpact`） |
| `NOT_FOUND` | 404 | 版本或积分包不存在 |
| `PLAN_NOT_AVAILABLE` | 409 | 版本未上架或积分包已下架 |
| `CYCLE_NOT_AVAILABLE` | 400 | 周期未启用 |
| `UPGRADE_NOT_ALLOWED_TODAY` | 409 | 同报价；或升级单的微信有效期不足 3 分钟（d2:507） |
| `SCHEDULED_TERM_LIMIT` | 409 | 同报价 |
| `PLAN_REFUND_IN_PROGRESS` | 409 | 主体处于退款处理中（2.0；套餐与加购都拦，d1:1784 C39） |
| `TOPUP_REQUIRES_ACTIVE_PLAN` | 409 | 加购时套餐未生效（PRD §6.15） |
| `PURCHASE_QUALIFICATION_REQUIRED` | 409 | 主体资质未提交或已驳回：只有“已认证或审核中”的主体能购买（d2:449 P20） |
| `QUOTE_CHANGED` | 409 | 锁内重算的应付 ≠ `expectAmountFen`，或降级须移除数与 `acknowledgedDowngradeImpact` 不一致；`details` 为 `{ kind: 'plan', amountFen, quote: PlanQuote }` 或 `{ kind: 'topup', amountFen, pointPack }`（第 5 节；d2:497） |
| `PURCHASE_NOT_OFFERED` | 403 | 购买策略 `mode ≠ in_app` |
| `CHANNEL_NOT_ALLOWED` | 403 | 所选渠道在此金额与平台下不可用（如超过微信单笔或当日限额）；`details.channels` 带可用渠道 |
| `OPEN_ORDER_EXISTS` | 409 | 套餐类：已有内容或渠道不同的未完成套餐类付款单；`details` 带其 `paymentOrderId`、`orderNo`，前端引导“取消后重新下单”（d2:504） |
| `OPEN_ORDER_EXPIRING` | 409 | 同内容同渠道的未完成单剩余不足 5 分钟（d2:503） |
| `AGREEMENT_VERSION_STALE` | 409 | `agreementVersionIds` 不是现行版本（来源：m01-account 协议同意段） |
| `ACCOUNT_BUSY` | 503 | 等账户锁超时（报价在账户锁内先 `advance` 再重算，d1:851），可用同一个键重试 |

**副作用**：
- 状态迁移：`billing_order.status`：（新建）→ `pending_payment`（08-billing-payment.md:162-163）；对公同时 `billing_order.transfer_state = awaiting_proof`，记下当前生效的收款账户版本 `billing_order.bank_account_finance_config_revision_id`。写 `status_transition`。
- 复用：同主体已有 `quote_hash` 相同、渠道相同且距截止超过 5 分钟的未完成付款单时，直接返回该单，不新建（d2:502）。
- 写入：`biz_sequence` 取号 `FK…`；`billing_order` 的 `content_snapshot`（`BillingOrderContent`）、`formula_code`、`formula_args`、`quote_hash`、`amount_fen`、`expires_at`（微信 = min(现在 + `billing.payment.order_timeout_minutes`, 升级 `validUntil` − 2 分钟)；对公 = 现在 + `billing.payment.transfer_valid_days`，升级取 `validUntil`，d2:506-508）、`store_id`、`source = weapp`、`client_platform`（`X-Client-Platform`）、`client_version`、`placed_by_user_id`。
- 协议同意：先取单号，再随 `ref { type: 'billing_order', id, no }` 调 `agreements.assertConsents`，场景 `plan_purchase` / `topup`，`agreement_consent.method = by_action`、`biz_no` = 付款单号（08-billing-payment.md:179；13-notify-docs.md:866）。
- 定时器：微信登记 `po.expire`（`fire_at = expires_at + 60 秒`）；对公登记 `po.transfer_ttl`（`fire_at = expires_at`）（d2:1176-1177）。
- 出站事件 `billing_order.created`（x01 事件目录）。审计（降级时记下 `acknowledgedDowngradeImpact`）。
- 收款交易此时不建，首次预下单时才建（d2:449）。

**说明**：
- 守卫（08-billing-payment.md:162）：仅老板；主体已认证或审核中；购买策略允许该渠道与金额；报价金额与入参一致；降级须移除数已确认且与重算一致；无其他未完成套餐类付款单；加购须套餐生效中；主体没有处于退款处理中的周期（2.0）。
- 协议文案：套餐页与加购页的主按钮上方都要有“付款即表示同意《…》”，协议名取 `PurchasePolicy.copy.agreementKeys`（套餐 `member`、`points`；加购 `points`），同意记录为 `by_action`（13-notify-docs.md:695）。原型只在套餐页有这句（PlanPick.dc.html:45），加购页没有（TopUp.dc.html:46-53），按套餐页补上，见第 6 节。
- 待支付时想换支付方式：先取消原单再新建（d2:1564 P25）；微信因限额失败时，策略允许对公的，付款单页给“改用对公转账”（d2:706），是否允许看 `PaymentOrderDetail.channels`（按本单金额与平台求值）。
- 小程序内展示对公转账入口须提审确认（05-risks-and-open-issues.md:36）：对公渠道由购买策略的渠道开关控制，可不发版关闭。
- 是否开具发票与付款无关；付款结果页提示“可在我的 › 发票管理中按本付款单申请开票”。

### 3.8 m.paymentOrder.get　付款单详情
`GET /m/payment-orders/{paymentOrderId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `plan.purchase`（加购单由服务层另断言 `points.topup`）；店员视图 `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 不涉及 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:PlanPick、M:TopUp 的 M10 对公弹层与 M11 付款结果；付款结果页 `sub/order/result?type=payment`（原型无，d7:560） |
| 出处 | 路线图 `m07.payment-order.get`；d2:1459；proto-merchant-a.md:707；d7:560 |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `paymentOrderId` | string(uuid) | 是 | 属于当前主体 | |

**响应**：`data` 为 `PaymentOrderDetail`（2.6）。

**错误**：`NOT_FOUND`（不存在或不属于当前主体）。

**副作用**：无。

**说明**：
- 付款结果页展示“内容 / 新周期或生效 / 积分”：取 `title`、`fulfillment.term`、`fulfillment.effectiveAt`、`fulfillment.points`；加购结果“可用积分 2,920 + X”取 `m.wallet.get`。
- 支付失败或取消后结果页的入口：“继续支付”看 `actions` 里的 `wechat-prepay`；“改用对公转账”等其他渠道看 `channels`（`isEnabled` 的渠道且不同于本单 `channel`），走“取消本单 → 按新渠道建单”（d7:732；d2:706）。
- 对公付款单的收款账号明文也在这里取（`m.paymentOrder.create` 的重放结果里为 null）。
- 对公付款单的待确认、驳回原因（“凭证被驳回：原因”）取 `latestTransferProof`。
- 原型的付款结果是弹层，d7 统一为结果页，付款流程用 `redirectTo` 进入（d7:560）。

### 3.9 m.paymentOrder.wechatPrepay　微信预下单
`POST /m/payment-orders/{paymentOrderId}/wechat-prepay`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `plan.purchase`；店员视图 `none` |
| 幂等 | required；三段式用例（C51，形态为“多事务”，`x-three-phase`）：同键请求在占用期内得到 409 `IDEMPOTENCY_IN_PROGRESS`（可重试，d7:460）；幂等记录随事务 B 写；渠道侧另由 `out_trade_no` 幂等。结果脱敏（C50、A80）：幂等记录里 `payParams` 置空，`x-redact-on-replay: [payParams]` |
| 乐观锁 | 否：事务 A、B 都先锁付款单行再按状态守卫（d2:532、544） |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:PlanPick、M:TopUp 的“微信支付 ¥X”；结果页的“继续支付” |
| 出处 | 路线图 `m07.payment-order.wechat-prepay`；d2:527-556、1460；d7:714-732 |

**请求**：路径参数 `paymentOrderId`（string(uuid)，必填）；请求体：无。付款人 openid 取当前会话在本小程序下的微信身份。

**响应**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `payParams` | object \| null | `wx.requestPayment` 的调起参数：`timeStamp`、`nonceStr`、`package`（`prepay_id=…`）、`signType`（`RSA`）、`paySign`。两种情况为 null：本次发现付款单已支付（看 `paymentOrder.status`）；同键重放（`replayed = true`） |
| `replayed` | boolean | 同键重放的结果（C50）：此时 `payParams` 为 null，端上换新键重调本接口，不能当作“已支付” |
| `paymentOrder` | `PaymentOrderDetail` | 付款单当前状态；“已支付”以 `paymentOrder.status`（或 `isProcessingReceipt`）判断，不以 `payParams` 是否为 null 判断 |

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | |
| `STATE_NOT_ALLOWED` | 409 | 付款单不是 `pending_payment`，或不是微信渠道 |
| `PAYMENT_ORDER_EXPIRED` | 409 | 距 `expires_at` 不足 60 秒（d2:532、642） |
| `PAYMENT_ORDER_CLOSED` | 409 | 下单期间付款单已被取消或该尝试已关闭，已对渠道关单（d2:548） |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | 同键请求仍在处理（可重试） |
| `PROVIDER_UNAVAILABLE`、`UPSTREAM_TIMEOUT` | 503、504 | 微信下单不可用或超时（8 秒），可用同一个键重试 |
| `ACCOUNT_BUSY` | 503 | 换微信号关旧尝试时查得已支付、入账等账户锁超时：入账事务整体回滚，收款保持“成功未入账”（已发 `payment_txn.succeeded`，由订阅者 `billing.applyPaymentFallback` 与 `tx.unapplied_scan` 补做），可用同一个键重试（d2:635-637） |

**副作用**：
- 收款交易（渠道事实，不写 `status_transition`，08-billing-payment.md:309-319）：`payment_txn.status`：（新建）→ `created`（事务 A）→ `prepaid`（事务 B，写 `prepay_id`、`prepay_expires_at = 现在 + 2 小时`）。新尝试的 `attempt_no` = 已有尝试数 + 1，`out_trade_no` 带随机段，`attach` 按 d2:552 编码。
- 老板换了微信号（进行中尝试的 `payer_openid` 与当前不同）：先“查单 → 关单”旧尝试（`payment_txn.status`：`created` / `prepaid` → `closed`），再建新尝试；查得已支付则 `recordChannelSuccess` 并入账（`applyPayment` + `fulfill`，与 3.10、`po.expire` 是同一段代码，d2:635、4.6）：`billing_order.status`：`pending_payment` → `paid`，副作用与出站事件同 3.10（含留痕、履约受阻与实收不符的分支，不符时同事务取消 `po.expire`，差异单 `detected_by = apply`），返回 `payParams = null`。本接口因此是“入账入口”之一（x01 第 5.1 节待补登，见 cross_doc）。
- 进行中的尝试仍有效（同 openid、`prepaid`、`prepay_id` 剩余超过 5 分钟）时直接重签返回，不调微信。

**说明**：
- 三段式步骤（d2:531-549，C51 的“多事务”形态）：① 事务 A 锁付款单，守卫 `status = pending_payment`、`channel = wechat_jsapi`、现在 < `expires_at` − 60 秒，取得或新建尝试并提交；② 事务外调微信 JSAPI 下单（`time_expire` = 付款单 `expires_at`）；③ 事务 B 锁付款单，`created → prepaid`，写幂等记录；付款单已不是待支付（或受影响 0 行）则回滚并立即对 `out_trade_no` 再调一次关单，返回 `PAYMENT_ORDER_CLOSED`；④ 签名后返回调起参数。
- 中间事务已提交的技术状态不随业务失败回滚：返回 `PAYMENT_ORDER_CLOSED` 时，事务 A 建的尝试已由取消流程置 `closed`，该行保留；② 失败（`PROVIDER_UNAVAILABLE` / `UPSTREAM_TIMEOUT`）时尝试保持 `created`，同键重试或占用过期后从 ② 续做（同一 `out_trade_no` 以相同参数重复下单是幂等的，d2:537）。
- 调起参数只在事务 B 成功后返回（d2:553）。
- 用户取消或失败时付款单保持待支付，结果页的“继续支付”用新的幂等键再调本接口（d7:731-732）；收到 `replayed = true` 时同样换新键重调。支付成功回调里端上顺带请求订阅授权（点位 `pay_success`，d7:718；d6-notify-docs-data.md:859），结果经 `m.subscribeResult.create`（m08）上报。
- V1.0 只有 `wechat_jsapi`；虚拟支付届时另加调起分支（d7:734）。

### 3.10 m.paymentOrder.sync　主动查单
`POST /m/payment-orders/{paymentOrderId}/sync`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `plan.purchase`；店员视图 `none` |
| 幂等 | none（A50、C47）：只查询渠道状态，入账由账本操作键 `fulfill:billing_order:{id}`、`purchase:billing_order:{id}` 与 `payment_txn.applied_at` 的守卫去重；三段式用例（先调外部、再开事务，`x-three-phase`），不读写幂等记录、不占用 `in_progress`（C51） |
| 乐观锁 | 否：入账函数按锁序锁付款单与收款交易后按状态守卫（d2:605） |
| 限流 / 开关 | 单资源档：每单每 3 秒一次（C68；d2:555）；无开关 |
| 对应画板 | M:PlanPick、M:TopUp 的付款确认中；付款结果页 |
| 出处 | 路线图 `m07.payment-order.sync`；d2:555、600-638、1461；d7:719-728；A50 |

**请求**：路径参数 `paymentOrderId`（string(uuid)，必填）；请求体：无。

**响应**：`data` 为 `PaymentOrderDetail`（2.6），即查单与入账之后的状态。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | |
| `RATE_LIMITED` | 429 | 同一付款单 3 秒内重复调用，按 `Retry-After` 退避 |
| `ACCOUNT_BUSY` | 503 | 入账时等账户锁超时；整个入账事务回滚，收款保持“成功未入账”，稍后再调或由 `tx.unapplied_scan` 补做（d2:637） |

渠道查询失败（不可用、超时）时不报错，返回付款单当前状态，端上按节奏继续轮询。

**副作用**（除第一条外只在查得渠道成功时发生，与回调、超时流程是同一段入账代码，d2:635）：
- 查得渠道 `CLOSED`：该尝试 `payment_txn.status`：`created` / `prepaid` → `closed`（只记渠道事实，不调关单、不动付款单；08-billing-payment.md:318；x01 归属表 08:318）。
- `payment_txn.status`：`created` / `prepaid` / `closed` → `succeeded`（`recordChannelSuccess`，渠道事实）；出站事件 `payment_txn.succeeded`。
- 该笔成功由本次查单首次记下（回调未到）且入账成功时，写一条差异单留痕 `payment_exception.status`：（新建）→ `auto_healed`（`detected_by = query`，不占财务待办；08-billing-payment.md:761；x01 归属表 08:761）；出站事件 `payment_exception.auto_healed`。
- `billing_order.status`：`pending_payment` → `paid`（收款入账 `applyPayment`，守卫：渠道实收 = 应付、付款人与 `attach` 一致；08-billing-payment.md:164）；写 `paid_amount_fen`、`paid_at`、`paid_payment_txn_id`、`applied_at`；取消 `po.expire` 定时器；出站事件 `billing_order.paid`；审计。
- 同事务履约 `billing.fulfill()`（07-billing-ledger.md:436、539-540；d1:893-923）：
  - 套餐（无生效订阅）：`subscription_term`：（新建）→ `active`；`billing_account.sub_status`：`none` / `expired` → `active`；第 0 个月 `grant_schedule.status`：`pending` → `granted`，新建套餐批次；此前已过期的另记 `addon_resume`。
  - 套餐（已有生效订阅）：`subscription_term`：（新建）→ `scheduled`，接在链尾。
  - 升级：当前周期权益快照换成目标版本，补发套餐批次，改写其后 `pending` 的发放计划。
  - 加购：新建加购批次。
  - 出站事件 `billing.order_fulfilled` 与对应的 `billing.subscription.*`（`activated` / `renewal_scheduled` / `upgraded`）、`billing.points.*`（`granted` / `purchased`）。过期后续费恢复加购积分（`addon_resume`）只写账本操作，不另发事件；`billing.subscription.resumed` 只由补偿延长发出（x01 事件目录），付款入账不发。
  - 履约受阻：`billing_order.fulfillment_status = blocked`，付款单仍为 `paid`，开 `fulfillment_blocked` 差异单（08-billing-payment.md:199）；出站事件 `billing_order.fulfillment_blocked`、`payment_exception.opened`；页面显示“已收到付款，正在处理”。
- 实收或付款人不符：`billing_order.status`：`pending_payment` → `cancelled`（`cancel_reason` = `amount_mismatch` / `payer_mismatch`），该笔保留为未入账收款并开差异单（08-billing-payment.md:165）；同事务用 `timers.cancel` 取消该单的 `po.expire` 定时器（不留 `scheduled` 定时器，`timers.I7`，01-kernel-flow.md:382、611）；出站事件 `billing_order.cancelled`、`payment_exception.opened`。
- 入账函数开的差异单（不符、履约受阻）：`detected_by = apply`，`dedupe_key = {kind}:{out_trade_no}`，先按键查、已存在则跳过，列的取法同 h01 第 2.6 节（h01-hooks.md:247-265）；与回调（h01 3.1）走同一段 `applyPayment`。

**说明**：
- 端上 `wx.requestPayment` 成功只切到“确认中”，每 3 秒调一次、至多 60 秒，之后放慢到每 10 秒（d7:720-723）；页面只显示服务端状态。
- 对公付款单调用本接口不查渠道，只返回当前状态（对公到账由财务确认）。
- 路线图原标 `required`，按 A50 改为 `none`（路线图切片已改）。

### 3.11 m.paymentOrder.cancel　取消付款单
`POST /m/payment-orders/{paymentOrderId}/cancel`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `plan.purchase`；店员视图 `none` |
| 幂等 | required（A17；路线图原写的“natural（状态守卫）”不采用）；三段式用例（C51 “先调外部、再开事务”，`x-three-phase`）：微信先查单、再关单，以结果为准；幂等记录随最后的事务写 |
| 乐观锁 | 否：最后的“置已取消”事务里再次校验付款单仍为 `pending_payment`（d2:663） |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | 原型无取消按钮（OPEN_ORDER_EXISTS 的“取消后重新下单”引导、结果页“改用对公转账”需要）；见第 6 节第 6 项 |
| 出处 | 路线图 `m07.payment-order.cancel`；d2:640-673、1462；08-billing-payment.md:166、175 |

**请求**：路径参数 `paymentOrderId`（string(uuid)，必填）；请求体：无。

**响应**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `outcome` | enum(`CancelOutcome`) | `cancelled` 已取消 / `paid` 查单发现已支付并已入账（或已收到付款，正在处理）/ `cancelling` 微信暂不可达，取消处理中（定时器已提前到现在） |
| `paymentOrder` | `PaymentOrderDetail` | 付款单当前状态 |

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | |
| `STATE_NOT_ALLOWED` | 409 | 付款单不是 `pending_payment`（已支付、已取消、已退款）；“已收到付款”的单不报错，返回 `outcome = paid`（d2:668） |
| `TRANSFER_PROOF_PENDING` | 409 | 对公：凭证待财务确认（`pending_confirmation`）期间不可取消（08-billing-payment.md:175） |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | 同键请求仍在处理（可重试） |
| `ACCOUNT_BUSY` | 503 | 查单为已支付、入账等账户锁超时：入账事务整体回滚，收款保持“成功未入账”（已发 `payment_txn.succeeded`，由订阅者 `billing.applyPaymentFallback` 与 `tx.unapplied_scan` 补做），付款单不取消；可用同一个键重试（d2:635-637） |

**副作用**：
- `billing_order.status`：`pending_payment` → `cancelled`（`cancel_reason = user`）。微信守卫：名下尝试都已 `closed`（以关单结果为准，08-billing-payment.md:166）；对公守卫：没有待确认的凭证（08-billing-payment.md:175）；清空 `transfer_state`。写 `status_transition`；出站事件 `billing_order.cancelled`；审计。
- `payment_txn.status`：`created` / `prepaid` → `closed`（渠道事实）。
- 定时器：取消 `po.expire` 或 `po.transfer_ttl`；微信不可达时把 `po.expire` 提前到现在（`outcome = cancelling`）。
- 查单为已支付：`recordChannelSuccess` 后入账（`applyPayment` + `fulfill`，与 3.10、`po.expire` 同一段代码，d2:635、4.6），`billing_order.status`：`pending_payment` → `paid`，副作用与出站事件同 3.10（含留痕、履约受阻与实收不符的分支，不符时同事务取消 `po.expire`，差异单 `detected_by = apply`），返回 `outcome = paid`。本接口因此是“入账入口”之一（x01 第 5.1 节待补登，见 cross_doc）。

**说明**：三段式步骤（d2:644-663）：① 锁付款单，守卫待支付；② 事务外对进行中的尝试“查单 → 关单”；③ 事务内复核付款单仍为待支付且该尝试未成功，置已取消，写幂等记录。用户主动取消与 `po.expire` 到期走同一条路径。

### 3.12 m.paymentOrder.transferProof.create　提交对公转账凭证
`POST /m/payment-orders/{paymentOrderId}/transfer-proofs`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `plan.purchase`；店员视图 `none` |
| 幂等 | required |
| 乐观锁 | 否：该迁移的守卫没有列 `lock_version`；“一张付款单至多一张待确认凭证”由 `uq_transfer_proof_pending` 兜底 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:PlanPick、M:TopUp 的 M10 对公转账弹层“转账凭证 / 重新上传 / 提交凭证” |
| 出处 | 路线图 `m07.transfer-proof.create`；d2:454、710-749、1463；08-billing-payment.md:167-169、403、410；proto-merchant-a.md:694、706 |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `paymentOrderId` | string(uuid) | 是 | 对公付款单 | |
| 请求体 | `fileId` | string(uuid) | 是 | 已入库（`file_object.status = stored`）、未被拦截、分类 `pay_receipt`、本人在本主体上传（主体级文件）；图片不超过 5MB 或 PDF | 回单截图或照片，先经 `m.file.create`（m08，分类 `pay_receipt`、主体范围；老板与已停用门店的老板可传）登记直传 |

**响应**：`data` 为 `PaymentOrderDetail`（2.6），`latestTransferProof` 为本次的凭证。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | |
| `VALIDATION_FAILED` | 400 | `fileId` 格式不合法 |
| `FILE_NOT_USABLE` | 400 | `fileId` 不存在、未入库、已被拦截、分类不是 `pay_receipt` 或不属于本主体：`files.link()` 断言失败的统一出口（m03 定义，`details.reason` 取 `not_stored` / `category_mismatch` / `scope_mismatch` / `blocked`） |
| `STATE_NOT_ALLOWED` | 409 | 不是对公付款单，或不在 `pending_payment`（`awaiting_proof` / `proof_rejected`）、`pending_confirmation`（`proof_submitted`） |
| `PAYMENT_ORDER_EXPIRED` | 409 | 待上传凭证的付款单已过 `expires_at`（d2:454） |
| `TRANSFER_PROOF_LOCKED` | 409 | 付款单在大额复核中（`confirm_review`），不能替换凭证（08-billing-payment.md:169） |

**副作用**：
- 首次上传或驳回后重传：`billing_order.status`：`pending_payment`（`awaiting_proof` / `proof_rejected`）→ `pending_confirmation`（`proof_submitted`）（08-billing-payment.md:167），写 `status_transition`。`po.transfer_ttl` 不取消：到点时处理器见有待确认凭证返回 `skipped`（d2:454“凭证待财务确认期间不自动关闭”；x01 定时器表 `po.transfer_ttl`），凭证被驳回、有效期顺延后由驳回方用新键重新登记；与 a07 员工代传一致。
- 待财务处理期间重传：付款单状态与子状态都不变，旧凭证 `transfer_proof.review_status`：`pending` → `superseded`，只写审计（08-billing-payment.md:168），取消旧凭证的 `sla.breach`。
- 新凭证 `transfer_proof.review_status`：（新建）→ `pending`；`upload_no` 递增，`uploaded_by_user_id` = 当前用户，`uploaded_at` = 现在（也是升级报价有效期判断的“付款人行为时刻”）；算出 `due_at`（参数 `sla.review.transfer_proof`，默认 1 个工作日）与 `sla_snapshot`，登记 `sla.breach` 定时器（主体 `transfer_proof`）。
- 文件引用：`file_ref`（`ref_type = transfer_proof`，角色 `main`）。配置了 OCR 时经 media 发起回单识别，`ocr_result.status`：（新建）→ `pending`，随本事务（06-media.md:1500；x01 归属表 06:1500），`check_result.ocrStatus = pending`（08-billing-payment.md:403）。
- 出站事件 `transfer.proof_submitted`（→ OCR、财务待办）；审计。

**说明**：
- 嵌套创建，资源 `transfer-proofs`（`resources.json`）；对象是付款单的子资源，operationId 为 `m.paymentOrder.transferProof.create`。
- 提交按钮点击时端上顺带请求订阅授权（点位 `transfer_submit`，d6-notify-docs-data.md:860），到账确认、凭证驳回经订阅消息通知。
- 回单识别只做辅助比对、不阻断（d2:754）；识别值不返回商家端。

### 3.13 m.paymentOrder.list　付款单列表
`GET /m/payment-orders`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `invoice.*`；店员视图 `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 不涉及 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Invoices 的“可开票”页签（付款单卡片：类型、单号、金额、标题、时间、支付方式、开票项目、“已申请，开票中”） |
| 出处 | 路线图 `m07.payment-order.list`；d2:1464（草案 `GET /m/billing/invoiceable-orders`）；proto-merchant-b.md:433、438 |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `invoiceState` | string | 否 | `PaymentOrderInvoiceState` 取值，逗号分隔 | 按开票状态筛选（见说明）；“可开票”页签的列表传 `eligible,applying` |
| 查询 | `status` | string | 否 | `billing_order.status` 取值，逗号分隔 | |
| 查询 | `type` | string | 否 | `billing_order.type` 取值，逗号分隔 | |
| 查询 | `no` | string | 否 | | 按付款单号查找 |
| 查询 | `cursor`、`limit` | | 否 | `limit` 1–50，默认 20 | 游标分页 |

**响应**：`{ items: array<PaymentOrderCard>, nextCursor, hasMore }`，按 `createdAt` 倒序（`ix_billing_order_entity_created`）；不返回总数（C42）。

**错误**：无。

**副作用**：无。

**说明**：
- `invoiceState`（`PaymentOrderCard.invoiceState`）按单判定，依次取第一项成立的：
  - `applying`：有 `pending` 的开票申请（原型“已申请，开票中”）；`invoiced`：有 `issued` / `red_pending` 的开票申请（`uq_invoice_request_active` 覆盖的有效申请）。
  - `not_eligible`：开票申请的守卫（08-billing-payment.md:1110）里与付款单有关的部分不满足：不是 `billing_order.status = paid` 且 `billing_order.fulfillment_status = done`，或 `billing_order.refunded_amount_fen > 0`，或该付款单入账收款有在途退款申请（`ix_refund_request_open_billing_order`）。
  - `expired`：配置了参数 `invoice.apply_within_days` 且 `billing_order.paid_at` + 天数已过（按单计算）。
  - `eligible`：以上都不成立。被驳回、已红冲的申请不占位，该单回到 `eligible`，可重新申请。
- 页签口径（与原型一致，Invoices.dc.html:112-121）：“可开票”列表传 `invoiceState=eligible,applying`，已申请的单留在列表里显示“已申请，开票中”；页签数字“可开票 · N”调 `m.paymentOrder.summary?invoiceState=eligible`，不算已申请的单。列表与计数各按自己的查询参数求值，口径一致。
- 主体未认证是主体级条件，不进 `invoiceState`：由 `m.invoiceRequest.create` 拒绝，页面按 `InvoiceContext.invoiceTitle.isVerified` 提示；卡片 `actions` 里是否有 `submit-invoice` 已考虑它。
- 套餐过期后仍可申请开票（d2:1400；proto-merchant-a.md:663）。

### 3.14 m.paymentOrder.summary　付款单计数
`GET /m/payment-orders/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `invoice.*`；店员视图 `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 不涉及 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Invoices 页签“可开票 · N” |
| 出处 | 路线图 `m07.payment-order.summary`；A23；C83；Invoices.dc.html:121 |

**请求**：查询参数同 `m.paymentOrder.list`（不含 `cursor`、`limit`），“可开票 · N”传 `invoiceState=eligible`。

**响应**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `total` | integer | 满足查询条件的付款单数，口径与列表完全相同 |

**错误**：无。

**副作用**：无。

**说明**：字面段 `/summary` 先于 `/{paymentOrderId}` 注册（A8）。

### 3.15 m.invoiceRequest.list　开票记录
`GET /m/invoice-requests`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `invoice.*`；店员视图 `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 不涉及 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Invoices 的“开票记录”页签（类型 · 介质 · 项目、状态、金额、申请单号、付款单号、申请与开具时间、发票号码、进度说明） |
| 出处 | 路线图 `m07.invoice-request.list`；d2:1464；08-billing-payment.md:1029-1070；proto-merchant-b.md:434 |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `status` | string | 否 | `invoice_request.status` 取值，逗号分隔 | |
| 查询 | `paymentOrderId` | string(uuid) | 否 | | 某张付款单的开票申请 |
| 查询 | `no` | string | 否 | | 按申请单号查找 |
| 查询 | `cursor`、`limit` | | 否 | `limit` 1–50，默认 20 | 游标分页 |

**响应**：`{ items: array<InvoiceRequestCard>, nextCursor, hasMore }`，按 `appliedAt` 倒序（`ix_invoice_request_entity_applied`）；不返回总数。

**错误**：无。

**副作用**：无。

**说明**：
- 驳回与红字发票的状态原型未画（proto-merchant-b.md:443）：`rejected` 显示驳回原因，商家可对该付款单重新申请；`red_pending`、`red_issued` 显示红冲进度，红字票据在 `docs` 里。
- 抬头卡（主体名称、税号脱敏）放在 `m.invoiceRequest.summary` 的 `context` 里，不随列表返回（见 3.16 说明）。

### 3.16 m.invoiceRequest.summary　开票记录计数与开票页上下文
`GET /m/invoice-requests/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `invoice.*`；店员视图 `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 不涉及 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Invoices 页签“开票记录 · N”、抬头卡、申请开票弹层的默认值 |
| 出处 | 路线图 `m07.invoice-request.summary`；A23、A25；C40、C83；Invoices.dc.html；proto-merchant-b.md:432、436 |

**请求**：查询参数同 `m.invoiceRequest.list`（不含 `cursor`、`limit`）。

**响应**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `total` | integer | 满足条件的开票申请数（页签数字） |
| `byStatus` | object | 各状态计数：`pending`、`issued`、`rejected`、`red_pending`、`red_issued`（键同 `invoice_request.status`） |
| `context` | `InvoiceContext` | 开票页上下文（2.10） |

**错误**：无。

**副作用**：无。

**说明**：
- 抬头卡在两个页签上方都显示，弹层默认值在“可开票”页签用；页面进入时本来就要调两个 `summary` 取页签数字，所以按 A79（C83）把这两块放在 `context` 里，不另开接口；路线图切片的“列表附抬头”已改。
- 默认值只给脱敏串：手机号用 `phoneSource` 表达来源（A25），端上不能把脱敏号回填后提交。

### 3.17 m.invoiceRequest.create　申请开票
`POST /m/invoice-requests`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `invoice.*`；店员视图 `none` |
| 幂等 | required（状态迁移，A17）；同一付款单的有效申请另由 `uq_invoice_request_active` 保证唯一 |
| 乐观锁 | 否：先锁付款单行，再按守卫现查（08-billing-payment.md:1106） |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Invoices 的“申请开票”弹层 |
| 出处 | 路线图 `m07.invoice-request.create`；d2:1365、1393-1400、1464；08-billing-payment.md:1110；proto-merchant-b.md:436；A25；C40 |

**请求**（请求体）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `paymentOrderId` | string(uuid) | 是 | 属于当前主体 | 按付款单全额开票 |
| `invoiceType` | enum(`invoice_request.invoice_type`) | 是 | `normal` / `special` | |
| `medium` | enum(`invoice_request.medium`) | 是 | `electronic` / `paper`；普通发票只能 `electronic` | |
| `addrTel` | string | 专票必填 | 1–100 字 | 地址与电话 → `invoice_request.addr_tel_enc`、`invoice_request.addr_tel_mask` |
| `bankAccount` | string | 专票必填 | 1–100 字 | 开户行与账号 → `invoice_request.bank_account_enc`、`invoice_request.bank_account_mask` |
| `recvEmail` | string | 电子必填 | 邮箱格式，≤ 100 字 | 接收邮箱 → `invoice_request.recv_email_enc`、`invoice_request.recv_email_mask` |
| `mailTo` | object | 纸质必填 | | 收件信息 → `invoice_request.mail_to_enc`（明文 JSON：收件人、电话、地址）、`invoice_request.mail_to_mask` |
| `mailTo.recipientName` | string | 是 | 1–20 字 | 收件人 |
| `mailTo.phoneSource` | enum(`PhoneSource`) | 是 | `login` / `store_contact` / `input` | 电话来源（A25）：登录手机号 / 当前门店的资质联系人手机号 / 手输 |
| `mailTo.phone` | string | `input` 时必填 | 11 位手机号或座机 | 只在 `input` 时传；其余由服务端解密 `merchant_user.phone_enc` 或 `store_profile.contact_phone_enc` 补值 |
| `mailTo.address` | string | 是 | 5–120 字 | 邮寄地址 |

抬头与税号不接收：申请时从认证主体快照（`entity.name` → `invoice_request.title`；`entity.uscc_enc` → `invoice_request.tax_no_enc`、`entity.uscc_mask` → `invoice_request.tax_no_mask`；d2:1396）。

**响应**：`data` 为 `InvoiceRequestCard`（2.9）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 专票缺地址电话或开户行账号；电子缺邮箱或格式不对；纸质缺收件信息；普通发票选了纸质；`phoneSource = store_contact` 但当前门店没有资质联系人手机号（`fieldErrors.path = mailTo.phoneSource`） |
| `NOT_FOUND` | 404 | 付款单不存在或不属于当前主体 |
| `INVOICE_TITLE_UNVERIFIED` | 409 | 主体认证尚未通过，没有可开票的抬头 |
| `INVOICE_NOT_ELIGIBLE` | 409 | 付款单不满足开票条件：未支付、未履约完成、已有退款、有在途退款申请；`details.reasons` 列出不满足项 |
| `INVOICE_REQUEST_EXISTS` | 409 | 该付款单已有有效开票申请；`details` 带其 `invoiceRequestId`、`requestNo` |
| `INVOICE_APPLY_EXPIRED` | 409 | 配置了参数 `invoice.apply_within_days` 且本单付款已超期（`invoiceState = expired`）；`details.deadline` |

**副作用**：
- 状态迁移：`invoice_request.status`：（新建）→ `pending`（08-billing-payment.md:1110），写 `status_transition`；出站事件 `invoice.requested`（x01 事件目录，载荷 `invoiceRequestId`、`billingOrderId`、`entityId`、`dueAt` 与迁移键；A95）。
- 写入：`biz_sequence` 取号 `KP…`；`amount_fen` = 付款单 `paid_amount_fen`；`item_name` = 参数 `invoice.item_name.{type}` 的此刻值（快照）；`applied_by_user_id`、`applied_at`；`provider = manual`。
- 定时器：配置了 `sla.review.invoice_request` 时算出 `due_at`、`sla_snapshot` 并登记 `sla.breach`（主体 `invoice_request`）；未配置时两列为空、不登记（08-billing-payment.md:1565 第 3 项）。
- 审计（不记录敏感字段明文）。

**说明**：
- 守卫（08-billing-payment.md:1110）：付款单已支付且履约完成；已退金额为 0；无在途退款申请（只算退入账收款的申请，`rule_code ≠ unapplied_receipt`）；无有效开票申请；主体认证已通过；必填项齐全；未超申请时限。事务内先锁付款单行，与发起退款、执行退款串行（d2:1391）。
- 一张付款单一张发票、全额，不合并、不拆分；订购与广告不单独开票（d2:1395；PRD §2.1）。
- 电子发票开具后推送到消息中心，并经通知中心发送至接收邮箱；邮件驱动未配置时只在小程序内下载（`invoice_doc.email_state = skipped`，d2:1399；01-architecture.md:422）。
- 提交按钮点击时端上顺带请求订阅授权（点位 `invoice_apply`，d6-notify-docs-data.md:869）。
- 原型纸质发票的邮寄地址是只读展示，这里改为可编辑、带默认值（proto-merchant-b.md:442）。

### 3.18 m.invoiceRequest.downloadUrls　下载发票
`POST /m/invoice-requests/{invoiceRequestId}/download-urls`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `invoice.*`；店员视图 `none` |
| 幂等 | none（签发短时地址，结果不进幂等记录，避免回放过期地址；A18、A19） |
| 乐观锁 | 不涉及 |
| 限流 / 开关 | `m.sign`（签发类，每用户每小时 600 次；C68、A130）；无开关 |
| 对应画板 | M:Invoices 开票记录的“下载发票” |
| 出处 | 路线图 `m07.invoice-request.file`；d2:1398；A19；C60、C61；d4-identity.md:1736 |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `invoiceRequestId` | string(uuid) | 是 | 属于当前主体 | |
| 请求体 | `docKind` | enum(`invoice_doc.doc_kind`) | 否 | `blue`（缺省）/ `red` | 要哪一张 |

**响应**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | 5 分钟有效的读地址（C61） |
| `expiresAt` | string(date-time) | 地址过期时刻 |
| `fileFormat` | enum | 同数据模型 `invoice_doc.file_format`；OFD 只提供下载，不做在线预览（d2:1398） |
| `fileName` | string | 建议的保存文件名（发票号码 + 扩展名） |

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 开票申请不存在或不属于当前主体 |
| `INVOICE_FILE_UNAVAILABLE` | 409 | 该申请没有这张票据，或票据没有文件（纸质发票） |

**副作用**：每次签发写一条访问留痕（`audit_log.stream = access`，`audit_log.target_type = invoice_doc`，`audit_log.meta` 带 `fileCategory = invoice` 与 `urlTtlSec`；03-staff-authz-audit.md:560、951；d4-identity.md:1736）。无状态迁移。

**说明**：路线图的 `GET …/file` 按 A19 改为本接口（C60 改写表）；草案按申请单号取，按约定改用 uuid。响应带 `Cache-Control: no-store`。

## 4. 枚举

### 4.1 本文用到的枚举

| 名称 | 取值与含义 | 备注 |
| --- | --- | --- |
| `PurchaseMode` | `in_app` 小程序内购买；`offline_contract` 小程序内不售卖、线下签约；`hidden` 不展示购买入口 | d2:1297；接口枚举，不落表 |
| `PurchaseChannel.code` | 同数据模型 `billing_order.channel` | `wechat_jsapi`、`bank_transfer` |
| `PlanQuoteAction` | `subscribe` 开通（含过期后重新开通）；`renew` 续费；`downgrade` 降级续费；`renew_upgrade` 下期换高版本；`upgrade` 立即升级 | d1:853-859；接口枚举 |
| `EffectiveMode` | `immediate` 付款后立即生效；`next_term` 本期结束次日生效 | 接口枚举 |
| `intent`（报价与建单的请求字段） | `upgrade_now`；`renew_next_term` | d1:1650 |
| `SubscriptionStatus` | `none`、`active`、`expired` | 取值同数据模型 `billing_account.sub_status`，但现算 |
| 付款单类型 | 同数据模型 `billing_order.type` | `plan_new`、`plan_renew`、`plan_upgrade`、`topup` |
| 付款单状态 | 同数据模型 `billing_order.status` | `pending_payment`、`pending_confirmation`、`paid`、`cancelled`、`refunded` |
| 对公子状态 | 同数据模型 `billing_order.transfer_state` | `awaiting_proof`、`proof_submitted`、`proof_rejected`、`confirm_review` |
| 履约状态 | 同数据模型 `billing_order.fulfillment_status` | `none`、`done`、`blocked` |
| 取消原因 | 同数据模型 `billing_order.cancel_reason` | |
| 凭证结论 | 同数据模型 `transfer_proof.review_status` | `pending`、`accepted`、`rejected`、`superseded` |
| `CancelOutcome` | `cancelled` 已取消；`paid` 已支付（或已收到付款，正在处理）；`cancelling` 取消处理中 | 接口枚举 |
| 积分类型 | 同数据模型 `point_lot.kind` | `plan`、`addon` |
| 账本操作类型 | 同数据模型 `ledger_operation.op_type` | 17 个 |
| `LedgerTab` | `all` 全部；`gain` 获得；`use` 使用；`expire` 过期 | PRD §6.15；接口枚举 |
| `LedgerCategory` | `gain`、`use`、`expire`、`other`（停用与恢复，只在 `all` 里出现） | 接口枚举，映射见 4.2 |
| 冻结单状态 | 同数据模型 `point_hold.status` | |
| 制作模型、排期 | 同数据模型 `plan_revision.production_model`、`plan_revision.schedule_priority` | |
| 发票类型、介质、状态、驳回方式 | 同数据模型 `invoice_request.invoice_type`、`invoice_request.medium`、`invoice_request.status`、`invoice_request.reject_kind` | |
| 票据种类、文件格式、邮件状态 | 同数据模型 `invoice_doc.doc_kind`、`invoice_doc.file_format`、`invoice_doc.email_state` | |
| `PhoneSource` | `login` 登录手机号；`store_contact` 当前门店资质联系人手机号；`input` 手输 | A25；C40 |
| `TopUpBlockReason`（`Wallet.topUp.blockReason`） | `no_active_plan`、`refund_in_progress`、`not_offered` | 接口枚举 |
| `PaymentOrderInvoiceState` | `eligible` 可申请；`applying` 已申请、开票中；`invoiced` 已开票（含红冲中）；`expired` 超过申请时限；`not_eligible` 不可开票 | 接口枚举（`x-open-enum`），判定见 3.13 |
| `limitReason`（`Wallet.usage.limitReason`） | `plan`、`inactive` | 同 m02 第 2.1 节 |
| `QUOTE_CHANGED.details.kind` | `plan`、`topup`、`points` | 接口枚举，见第 5 节 |
| 开票不满足项 `INVOICE_NOT_ELIGIBLE.details.reasons[]` | `not_paid`、`not_fulfilled`、`refunded`、`refund_in_progress` | 接口枚举 |

### 4.2 账本操作 → 商家端明细分类

按 d1:1410-1421。

| `op_type` | `category` | 说明 |
| --- | --- | --- |
| `grant` | `gain` | 月度发放、升级补发 |
| `purchase` | `gain` | 加购入账 |
| `hold` | `use` | 订购、广告、超次修改的冻结；扣减（`capture`）只更新该行 `holdStatus` |
| `capture` | 不出行 | |
| `release`、`refund` | `gain` | 退回；转为加购积分的部分 `lotKind = addon`，备注“转为加购积分” |
| `expire` | `expire` | 期末清零 |
| `unexpire` | `gain` | 延长补批，恢复已清零积分 |
| `adjust` | 增加为 `gain`，扣减为 `use` | |
| `revoke` | `expire` | 套餐退款作废 |
| `addon_suspend`、`addon_resume`、`refund_suspend`、`refund_resume` | `other` | 只在 `all` 里显示，`deltaPoints = 0` |
| `fulfill`、`extend` | 不出行 | 只做幂等登记 |
| `fix` | 按变动方向 `gain` / `use` | 人工修复 |

### 4.3 付款单的 `actions`

| 动作 | 可执行条件 | 对应接口 |
| --- | --- | --- |
| `wechat-prepay` | `pending_payment`、`wechat_jsapi`、现在 < `expires_at` − 60 秒 | `m.paymentOrder.wechatPrepay` |
| `sync` | `pending_payment`、`wechat_jsapi` | `m.paymentOrder.sync` |
| `cancel` | `pending_payment`；对公另要求 `transfer_state` 为 `awaiting_proof` / `proof_rejected` | `m.paymentOrder.cancel` |
| `submit-proof` | 对公，且（`pending_payment` 未过期）或（`pending_confirmation` 且 `proof_submitted`） | `m.paymentOrder.transferProof.create` |
| `submit-invoice` | `invoiceState = eligible`（3.13），且主体已认证 | `m.invoiceRequest.create` |

### 4.4 计算式模板码（`formula.code`）

付款单的 `billing_order.formula_code` 与报价的 `formula.code` 同一套，键集合登记在契约（08-billing-payment.md:1379）。

| code | `args` | 渲染示例 |
| --- | --- | --- |
| `plan_monthly` | `monthlyFeeFen`、`months` | ¥6,000 × 3 个月 ＝ ¥18,000 |
| `plan_cycle` | `cyclePriceFen`、`months`（周期价不等于月费 × 月数时） | 季付 3 个月 ¥16,800 |
| `plan_upgrade` | `feeDeltaPerMonthFen`、`remainingDays`、`baseDays`、`remainingFullMonths`、`payFen` | 每月差 ¥6,000，按 12/30 天折算 ＝ ¥2,400 |
| `topup` | `points`、`payFen` | 加购积分 1,000 ＝ ¥1,000 |

### 4.5 积分明细的展示文案码（`ledger_operation.title_code`）

07 分组把清单留给接口契约阶段定（07-billing-ledger.md:1497）。商家端与后台流水（a07）共用这张表；`title_args` 只放数字、单号与剧名这类短文本。除只做幂等登记的 `fulfill`、`extend`（`title_code` 可为空，07-billing-ledger.md:928）外，每种 `op_type` 都有码；`capture` 在商家端不单独出行（4.2），后台流水用它的码。

| title_code | 操作 | 标题示例 | `title_args` |
| --- | --- | --- | --- |
| `grant_open` | 新开通或过期后重新开通的第 0 个月发放 | 开通专业版，发放本期套餐积分 | `planName`、`termStartDate`、`termEndDate`、`billingOrderNo` |
| `grant_term` | 续接周期的第 0 个月发放 | 发放本期套餐积分（专业版续费，本期 09-13 至 10-12） | `planName`、`termStartDate`、`termEndDate` |
| `grant_monthly` | 季付、年付其后各月发放 | 发放本月套餐积分 | `planName`、`monthNo` |
| `grant_upgrade` | 升级补发 | 升级旗舰版，补发套餐积分 | `toMonthlyPoints`、`fromMonthlyPoints`、`remainingDays`、`baseDays`、`billingOrderNo` |
| `topup` | 加购入账 | 加购积分 | `billingOrderNo`、`payFen`、`channel` |
| `order_hold` | 订购冻结 | 订购《巷口那家店》《二次开业》 | 取整单的值，同一订购单的每次冻结传相同参数（按 `group_ref` 合并成一行时标题不变，m04 `m.order.create`，m04-mall-order.md:855）：`dramaTitles`（string[]，按 `item_no`）、`count`、`pricePoints`（integer[]，各部标价，与 `dramaTitles` 同序）、`discountBp`、`surchargeBp` |
| `ad_hold` | 广告冻结（一条一行，2.8） | 广告制作 | `adNo`、`unitPoints`、`discountBp` |
| `capture` | 冻结转扣减（开工、广告开始制作、超次修改） | 开始制作，积分已扣减 | `refType`（`point_hold.ref_type`）、`refNo`、`count` |
| `ad_revision_charge` | 超次修改 | 广告超次修改 | `adNo`、`unitPoints`、`discountBp` |
| `release` | 开工前取消退回 | 取消订购，积分退回 | `refNo`、`dramaTitles` |
| `refund` | 开工后退回 | 取消订购，退回积分 / 平台原因退回 | `refNo`、`reasonClass`、`isConversion` |
| `term_expire` | 期末清零 | 上期套餐积分到期清零 | `termStartDate`、`termEndDate` |
| `unexpire` | 延长补批 | 有效期延长，恢复已清零积分 | `days` |
| `adjust` | 手动调整 | 积分调整：制作问题补偿 | `reasonCode`、`note` |
| `revoke` | 套餐退款作废 | 套餐退款，积分作废 | `termStartDate`、`termEndDate` |
| `addon_suspend`、`addon_resume` | 加购积分停用、恢复 | 套餐过期，加购积分停用 / 续费后恢复 | `termEndDate` |
| `refund_suspend`、`refund_resume` | 退款处理中开合 | 套餐退款处理中，积分暂停使用 / 恢复 | — |
| `fix` | 人工修复（脚本经代码评审，07-billing-ledger.md:1384） | 积分修正 | `note`（给商家看的一句说明，不含内部工单号） |

## 5. 错误码

本文新定义的领域错误码。账本段 43000–43099，付款段 44000–44099（A70）。`retryable` 为真的只有 `ACCOUNT_BUSY`（C26）。按 A77，账本段的 `POINTS_INSUFFICIENT`、`SUBSCRIPTION_INACTIVE`、`QUOTE_CHANGED`、`ACCOUNT_BUSY`（以及 `PLAN_REFUND_IN_PROGRESS`）是共用领域码，由本文定义一次，m04、m06、a05、a07 只引用符号。

| 符号 | 数值 | HTTP | 可重试 | 含义 | `details` |
| --- | --- | --- | --- | --- | --- |
| `PLAN_NOT_AVAILABLE` | 43001 | 409 | 否 | 套餐版本未上架、没有生效的价目，或积分包已下架 | — |
| `CYCLE_NOT_AVAILABLE` | 43002 | 400 | 否 | 购买周期未启用 | `{ enabledCycles }` |
| `UPGRADE_NOT_ALLOWED_TODAY` | 43003 | 409 | 否 | 今天不能立即升级（本期最后一天、差价不为正、升级单微信有效期不足 3 分钟） | `{ suggest: 'renew_next_term' }` |
| `SCHEDULED_TERM_LIMIT` | 43004 | 409 | 否 | 预约的未生效周期已达上限 | `{ maxScheduledTerms }` |
| `TOPUP_REQUIRES_ACTIVE_PLAN` | 43005 | 409 | 否 | 套餐未生效，不能加购积分 | — |
| `PLAN_REFUND_IN_PROGRESS` | 43006 | 409 | 否 | 套餐退款处理中，暂不能购买、订购或提交广告（主体级，2.0） | — |
| `QUOTE_CHANGED` | 43007 | 409 | 否 | 价格已变化，请确认新报价 | `QuoteChangedDetails`，按 `kind` 判别的联合类型（见下） |
| `ACCOUNT_BUSY` | 43008 | 503 | 是 | 积分账户正忙，请稍后重试（等账户锁超过 3 秒） | — |
| `POINTS_INSUFFICIENT` | 43009 | 409 | 否 | 可用积分不足（账本在账户锁内判定，`billing.hold` / `charge` 抛出；d1:1724） | `{ requiredPoints, spendablePoints, shortfallPoints }`：本次应冻结或应扣的积分、此刻可用积分（2.7 口径）、缺口 = `requiredPoints − spendablePoints` |
| `SUBSCRIPTION_INACTIVE` | 43010 | 409 | 否 | 套餐未生效（从未开通或已过期），不能订购、提交广告或超次修改（账本在账户锁内判定；d1:1724；07-billing-ledger.md:843） | — |

`QuoteChangedDetails`（C22：一个错误码一种 `details` 类型，用 `kind` 判别）：

| `kind` | 用于 | 其余字段 |
| --- | --- | --- |
| `plan` | 本文 `m.paymentOrder.create`（套餐类）；a07 `admin.paymentOrder.create` | `amountFen`（integer(分)，重算的应付）；`quote`（`PlanQuote`，2.3，含 `downgradeImpact`） |
| `topup` | 本文 `m.paymentOrder.create`（加购）；a07 同上 | `amountFen`；`pointPack`（`{ pointPackId, points, priceFen }`） |
| `points` | 账本冻结、扣减的比对（`expectS`，d1 5.2）：m04 `m.order.create`、m06 `m.ad.create` | `totalChargePoints`（integer(积分)，重算的应冻结合计）；`items`（array<`{ dramaId: string(uuid) \| null, chargePoints: integer(积分) }`>，订购逐部一项；广告一项，`dramaId` 为 null） |

`QuoteChangedDetails` 是 m04、m06 共用的唯一形态（A131；C87 登记归本文），m04 订购用 `points` 分支，不另起 `drama_order`。

付款段：

| 符号 | 数值 | HTTP | 可重试 | 含义 | `details` |
| --- | --- | --- | --- | --- | --- |
| `PURCHASE_NOT_OFFERED` | 44001 | 403 | 否 | 当前不提供在线购买（购买策略 `mode ≠ in_app`） | `{ mode }` |
| `CHANNEL_NOT_ALLOWED` | 44002 | 403 | 否 | 所选支付方式此时不可用 | `{ channels: PurchaseChannel[] }` |
| `PURCHASE_QUALIFICATION_REQUIRED` | 44003 | 409 | 否 | 请先提交资质认证（未提交或已驳回的主体不能购买） | `{ verificationStatus }` |
| `OPEN_ORDER_EXISTS` | 44004 | 409 | 否 | 已有未完成的套餐付款单 | `{ paymentOrderId, orderNo }` |
| `OPEN_ORDER_EXPIRING` | 44005 | 409 | 否 | 同内容的付款单即将超时，请取消后重新下单 | `{ paymentOrderId, orderNo, expiresAt }` |
| `PAYMENT_ORDER_EXPIRED` | 44006 | 409 | 否 | 付款单已超时 | `{ expiresAt }` |
| `PAYMENT_ORDER_CLOSED` | 44007 | 409 | 否 | 付款单已取消，请重新下单 | — |
| `TRANSFER_PROOF_PENDING` | 44008 | 409 | 否 | 转账凭证待财务确认，暂不能取消 | — |
| `TRANSFER_PROOF_LOCKED` | 44009 | 409 | 否 | 财务正在复核到账，暂不能更换凭证 | — |
| `INVOICE_NOT_ELIGIBLE` | 44010 | 409 | 否 | 该付款单暂不能开票 | `{ reasons: string[] }` |
| `INVOICE_REQUEST_EXISTS` | 44011 | 409 | 否 | 该付款单已申请开票 | `{ invoiceRequestId, requestNo }` |
| `INVOICE_TITLE_UNVERIFIED` | 44012 | 409 | 否 | 主体认证通过后才能开票 | — |
| `INVOICE_APPLY_EXPIRED` | 44013 | 409 | 否 | 已超过开票申请期限 | `{ deadline }` |
| `INVOICE_FILE_UNAVAILABLE` | 44014 | 409 | 否 | 该发票暂无可下载的文件 | — |

引用的其他文档的错误码：`AGREEMENT_VERSION_STALE`（m01-account，协议同意 47400 段）；`FILE_NOT_USABLE`（m03-profile-asset，46001）。通用错误码见 C27（`VALIDATION_FAILED`、`NOT_FOUND`、`ROLE_FORBIDDEN`、`STATE_NOT_ALLOWED`、`IDEMPOTENCY_IN_PROGRESS`、`RATE_LIMITED`、`PROVIDER_UNAVAILABLE`、`UPSTREAM_TIMEOUT`）。

草案 d1:1724、d2:497-548 的同名码按 C25 落到本段：`ORDER_CLOSED` 改名 `PAYMENT_ORDER_CLOSED`（避免与订购单混淆）。d1:1724 的 `HOLD_NOT_ACTIVE`、`HOLD_CONFLICT`、`RETURN_EXCEEDS_HOLD`、`ONE_ACCOUNT_PER_TX` 目前没有接口文档引用（调用方先按单据状态守卫，账本里抛出即编程错误，走 `INTERNAL`）；哪份文档需要对外返回，由它提出，本文从 43011 起补定义。

## 6. 待确认

| # | 问题 | 默认做法 | 谁定 |
| --- | --- | --- | --- |
| 1 | 商家能否回看已提交的转账凭证图片 | 不能（原型没有回看入口）；要做时加 `POST /m/transfer-proofs/{transferProofId}/download-urls`，逐次留痕 | 产品 |
| 2 | 商家端是否展示冻结中的积分（proto-merchant-a.md:647）；套餐过期时加购积分的文案用“停用”还是沿用原型“冻结”（d1:1746 C1） | 接口返回 `points.heldPoints` 与 `points.isAddonSuspended`，展示与文案由前端按产品决定（d1:1770 C25） | 产品 |
| 3 | 积分明细里“退回”“调整”归哪一类、一笔订购扣两类积分怎么显示（proto-merchant-a.md:777-778） | 按 d1 第 7.9 节：退回归“获得”，调整按方向；按积分类型拆成两行 | 产品 |
| 4 | 平台对公收款账号在商家端返回明文（A89） | 返回明文（商家须复制转账），`no-store`，不进幂等记录；账号变更走受控配置二人批准、24 小时后生效（08-billing-payment.md:1251） | 法务、财务、安全 |
| 5 | 开票项目名称（会员服务费 / 积分充值 / 信息技术服务费） | 参数 `invoice.item_name.{type}`，申请时快照；初始值待财务、税务定（d2:1552 P13） | 财务、税务 |
| 6 | 商家端取消付款单的入口：原型没有取消按钮 | 接口提供；入口放在 `OPEN_ORDER_EXISTS` 的引导弹层与结果页“改用对公转账”（d2:706），超时自动取消照常 | 产品 |
| 7 | 加购页的协议文案：原型套餐页有“付款即表示同意《会员服务协议》《积分规则》”（PlanPick.dc.html:45），加购页没有（TopUp.dc.html:46-53），但加购付款会记一条《积分规则》的 `by_action` 同意 | 加购页按套餐页补“付款即表示同意《积分规则》”（取 `copy.agreementKeys`），列入页面补稿 | 产品、法务 |
| 8 | 降级后名额超限的系统行为（d1:1003 16-B4；05-risks-and-open-issues.md:218） | 按 d4 第 4.4 节：报价给出须移除数，确认页勾选后才能付款（`acknowledgedDowngradeImpact`）；到期前提醒带数字；新周期照常生效，不自动移除，门店超限时全部门店不能新订购，成员超限时不能新增邀请 | 业务 |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：18 条接口（路线图 `doc = m07-billing` 全部）；公共结构 10 个；错误码 22 个（43001–43008、44001–44014）；`m.paymentOrder.sync` 按 A50 改幂等 `none`；开票页抬头与默认值放进 `m.invoiceRequest.summary`；补积分明细的分类映射、付款单动作、计算式模板码与明细文案码 | A1–A75；C1–C84；数据模型 07、08 |
| 2026-10-03 | 第二轮：① 错误码：按 A77 定义共用码 `POINTS_INSUFFICIENT`（43009，`details` 带缺口）、`SUBSCRIPTION_INACTIVE`（43010）；`QUOTE_CHANGED` 的 `details` 改为按 `kind`（`plan` / `topup` / `points`）判别的联合类型，覆盖 m04、m06 的积分比对；凭证文件不可用改用 m03 的 `FILE_NOT_USABLE`；`m.paymentOrder.wechatPrepay`、`m.paymentOrder.cancel` 补 `ACCOUNT_BUSY`；`m.plan.quote` 改为只读（不拿锁、不 `advance`），删去 `ACCOUNT_BUSY`。② 退款处理中改为主体级口径（任一预约或生效周期被标记），`isRefundPending`、`spendablePoints`、`PLAN_REFUND_IN_PROGRESS`、加购拦截统一。③ `Wallet`：名额改引 m02 2.1（`storeLimit`、`seatsUsed`、`memberLimit`、`limitReason`，未生效取参数默认值）；积分字段按 C32 带 `Points` 后缀，清零时刻定名 `planPointsExpireAt`；新增 `topUp`（加购拦截态，原 `m.pointPack.list` 的 `canPurchase`、`blockReason` 移来）。④ `m.plan.list`、`m.pointPack.list` 按 C42、A78 只回 `{ items }`。⑤ 布尔按 C39 改名（`isPriceShown`、`isPurchasePromptAllowed`、`isEnabled`、`isRecommended`）；微信渠道可用性补“规则未关闭”。⑥ 结果脱敏（A80、C50）：预下单加 `replayed`，`payParams` 重放为 null；创建付款单的 `bankAccount.accountNo` 不进幂等记录。⑦ 预下单按 C51“多事务”写明幂等记录与中间状态；预下单、取消查得已支付即入账，列为入账入口（待 x01 补登）。⑧ 降级付款须带 `acknowledgedDowngradeImpact`（d4 第 4.4 节）；付款单详情加 `channels`；付款单卡片加 `invoiceState`、`activeInvoiceRequest`，“可开票”页签按原型保留“已申请”卡片，查询参数 `invoiceable` 改为 `invoiceState`，申请时限按单判定。⑨ 事件：开票改用 `invoice.requested`，`billing_order.created` 去掉“建议名”，付款入账不再发 `billing.subscription.resumed`；查单补记写 `payment_exception`（`auto_healed`），查得 `CLOSED` 记尝试关闭；凭证上传补 `ocr_result` 迁移，不再取消 `po.transfer_ttl`（按 x01）。⑩ 明细：广告按条出行，原型的合并行列入第 6 节；文案码补 `capture`、`fix`，`ad_hold` 参数改为 `adNo`。⑪ 第 1 节登记口径函数（购买策略、钱包、广告单价、注销守卫计数、付款单描述）；第 6 节删去已由 A50、A78、A79 裁决或交主负责人的项，补广告合并、加购页协议文案；路线图切片按作者建议与复核意见同步 | A76–A126；review/xdoc-m07-billing.md；复核 A、B；review/api-check.md |
| 2026-10-03 | 第三轮：① 2.0 写明 `invoice.*` 是单个组键、不是通配（A128）。② 错误码：`QuoteChangedDetails` 注明为 m04、m06 共用的唯一形态，m04 用 `points` 分支（A131）；修正付款段（44001–44014）误接在 `kind` 表下的排版，补表头。③ 3.10 实收或付款人不符：同事务 `timers.cancel` 取消 `po.expire`（`timers.I7`）；入账函数开的差异单 `detected_by = apply`、`dedupe_key = {kind}:{out_trade_no}`（同 h01 2.6）；3.9、3.11 的“同 3.10”分支随之写明。④ 4.5 `order_hold` 参数写明取整单值，`dramaTitles`、`pricePoints` 为按 `item_no` 同序的数组（m04 请求）。⑤ 3.1 过期态剧名取 `m.orderItem.list?tab=to_launch`。⑥ 3.18 限流改 `m.sign`（A130）。⑦ 第 6 节删去广告合并一项（A146：广告按条出行以契约为准），其余顺延。第二轮已做、本轮核对无误：名额字段（m02）、`POINTS_INSUFFICIENT` / `SUBSCRIPTION_INACTIVE` 定义、预下单“多事务”（A139） | A127–A150；review/r3-in-m07-billing.md |
| 2026-10-03 | 第四轮：按 A151 把单值字典字段改为 `DictRef \| null`：`TransferProofView` 的 `rejectReasonCode` + `rejectReasonLabel` → `rejectReason`，`InvoiceRequestCard.reject` 的 `reasonCode` + `reasonLabel` → `reason`（`order_refunded` 时为 null），`InvoiceDocView.expressCompanyName` → `expressCompany`；2.0 补“字典项”一行，清单补 `externalSchemas` 引用 `DictRef`；积分调整 `reasonCode` 是系统枚举，不改 | A151；C85、C87；review/r4-in-m07-billing.md |
