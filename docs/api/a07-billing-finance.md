# 后台：套餐积分与财务

| 项 | 内容 |
| --- | --- |
| 范围 | 套餐与积分菜单：A:Plans（套餐版本与权益、调整与公告记录、升级与续费试算）、A:PointPacks（积分包）、A:Params（积分规则参数与变更记录；等级模板价的读取在 a04 `admin.priceTierRevision.list`，保存并入本文的变更集）、A:PointAccounts（积分账户与流水、手动调整）；订单菜单：A:Orders 的“付款单”视图、A:Receipts（对公收款确认）、A:Renewals（套餐到期、补偿延长、补发提醒）；财务菜单：A:Payments（收款流水）、A:Refunds 的现金退款部分（订购与广告取消在 a05）、A:CreditAdjust 的详情与决定（列表与计数在 a01 `admin.approval.*`）、A:Invoices（含红字发票）、A:Reconcile（对账与差异）；A:MerchantDetail 的“套餐与积分”页签、“订单 › 付款单”子页签与手动调整弹层；原型没有画板的：受控财务配置、线下开单、线下退款登记、红字发票、“我的待审批”里的补偿延长与积分调整（A16） |
| 接口数 | 85（V1.0 85，V1.1 0） |
| 依据 | 数据模型 07 分组（`plan`、`plan_revision`、`point_pack`、`price_tier_revision`、`billing_param`、`billing_account`、`subscription_term`、`subscription_event`、`grant_schedule`、`point_lot`、`point_hold`、`ledger_operation`、`point_ledger_entry`、`billing_entity_daily`、`point_adjustment_request`、`term_extension_request`）、08 分组（`billing_order`、`payment_txn`、`transfer_proof`、`refund_request`、`refund_txn`、`payment_exception`、`wx_bill_file`、`wx_bill_line`、`recon_day`、`invoice_request`、`invoice_doc`、`finance_config_revision`），另读 03（`approval_request`、`follow_up`、`audit_log`、`staff`）、13（`notification`、`notification_delivery`、`manual_reminder_log`）、14（`site_notice`、`dict_item`、`param_value`）、02、06、09、12 分组；草案 d1 第 4.1、6.8–6.10、7.8–7.9、11.2–11.4 节，d2 第 5、7、8、11、12 节，d4 第 7.1、7.5–7.7 节；接口裁决 A1–A156（重点 A14、A15、A16、A17、A20、A21、A22、A23、A26、A28、A45、A46、A50、A58、A70；第二轮 A76、A77、A78、A80、A84、A89、A90、A93、A94、A95、A102、A107、A124；第三轮 A127、A131、A132、A133、A150；第四轮 A151、A154、A156）；通用约定 C1–C87（重点 C27、C43、C47、C51、C53、C54、C60、C66、C67、C83、C85、C86、C87）；资源登记表 `resources.json`；共用结构引用 a01 第 2.1 节 `AdminPage<T>`、`AdminCursorPage<T>`，第 2.2 节 `StaffBrief`，第 2.10 节 `ApprovalDecisionView`，m07 的 `PlanQuote`、`QuoteChangedDetails`，约定 C85 的 `DictRef` |

本文路径一律省略 `/api/v1`。引用写法：`d2:923` 指 `docs/appendix/design/d2-payment.md` 第 923 行；`08-billing-payment.md:527` 指 `docs/data-model/08-billing-payment.md` 第 527 行；`proto-admin-d.md:113` 指 `docs/appendix/research/proto-admin-d.md`。

## 1. 概览

本文是后台“钱与积分”的全部写入口与查询：价目与参数怎么改（修订行按时间生效，需公告的同事务建公告），积分账户怎么查、怎么手动调整，套餐到期怎么跟进、怎么补偿延长，付款单与收款流水怎么查，对公转账怎么确认到账，现金退款怎么发起、审批、执行，发票怎么开、怎么红冲，每日对账的差异怎么处理，受控财务配置怎么双人变更。

三条主线：

1. **钱的事实只由财务确认或渠道事实写入**：对公到账由财务确认（可选二人复核），微信收款由回调与查单写入（h01、m07），本文只做后台的人工环节；补单、关联、补记都以渠道实时查询或银行流水为准。
2. **资金流出都经两步**：现金退款“客服发起 → 财务审批 → 财务执行”，差异单的原路退款也生成退款申请走同一条链（d2:1127）；积分调整、补偿延长、受控配置走统一审批单，审批人不得是发起人（C67）。
3. **审批的决定走各自的领域资源**（A14）：本文提供 `point-adjustment-requests`、`term-extension-requests`、`refund-requests`、`finance-config-revisions`、`transfer-proofs`（二人复核）上的 `approve` / `reject` / `withdraw`；跨类型的“我的待审批”列表、计数与审批单详情在 a01（`admin.approval.list`、`admin.approval.summary`、`admin.approval.get`）。

全部接口 `x-auth = staff`，限流档位 `admin.global`（C68），没有受功能开关控制的路由（线下开单受受控配置 `controls.adminCreateOrder` 约束，见 3.43）。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `admin.plan.list` | `GET /admin/plans` | 套餐版本与权益矩阵 | staff；模块 `billing` ≥ v | none（查询） |
| `admin.plan.summary` | `GET /admin/plans/summary` | 套餐页 KPI | staff；模块 `billing` ≥ v | none（查询） |
| `admin.plan.create` | `POST /admin/plans` | 新建套餐版本（未上架） | staff；`billing.plan.edit` | required |
| `admin.plan.shelve` | `POST /admin/plans/{planId}/shelve` | 上架 | staff；`billing.plan.edit` | required |
| `admin.plan.delist` | `POST /admin/plans/{planId}/delist` | 下架 | staff；`billing.plan.edit` | required |
| `admin.plan.update` | `PATCH /admin/plans/{planId}` | 改版本名称（3.85） | staff；`billing.plan.edit` | required |
| `admin.plan.planRevision.create` | `POST /admin/plans/{planId}/plan-revisions` | 编辑版本（建价目修订与公告） | staff；`billing.plan.edit` | required |
| `admin.planRevision.list` | `GET /admin/plan-revisions` | 调整与公告记录 | staff；模块 `billing` ≥ v | none（查询） |
| `admin.planRevision.withdraw` | `POST /admin/plan-revisions/{planRevisionId}/withdraw` | 生效前撤销价目修订 | staff；`billing.plan.edit` | required |
| `admin.plan.quote` | `POST /admin/plans/quote` | 升级补差、续费试算 | staff；`assert-in-handler`（模块 `billing` 或 `order` ≥ v） | none（试算） |
| `admin.pointPack.list` | `GET /admin/point-packs` | 积分包列表 | staff；模块 `billing` ≥ v | none（查询） |
| `admin.pointPack.summary` | `GET /admin/point-packs/summary` | 积分包 KPI 与近 6 个月加购 | staff；模块 `billing` ≥ v | none（查询） |
| `admin.pointPack.create` | `POST /admin/point-packs` | 新增积分包（即上架） | staff；`billing.pack.edit` | required |
| `admin.pointPack.update` | `PATCH /admin/point-packs/{pointPackId}` | 编辑积分包 | staff；`billing.pack.edit` | required |
| `admin.pointPack.shelve` | `POST /admin/point-packs/{pointPackId}/shelve` | 上架 | staff；`billing.pack.edit` | required |
| `admin.pointPack.delist` | `POST /admin/point-packs/{pointPackId}/delist` | 下架 | staff；`billing.pack.edit` | required |
| `admin.billingParam.list` | `GET /admin/billing-params` | 积分规则参数（当前、待生效、默认） | staff；模块 `billing` ≥ v | none（查询） |
| `admin.pricingChange.list` | `GET /admin/pricing-changes` | 模板价与参数的变更记录 | staff；模块 `billing` ≥ v | none（查询） |
| `admin.pricingChange.create` | `POST /admin/pricing-changes` | 保存模板价与参数变更集 | staff；`assert-in-handler`（`billing.price.edit` / `billing.param.edit`） | required |
| `admin.billingParam.withdraw` | `POST /admin/billing-params/{billingParamId}/withdraw` | 撤销一条待生效参数 | staff；`billing.param.edit` | required |
| `admin.pointAccount.list` | `GET /admin/point-accounts` | 积分账户列表 | staff；模块 `billing` ≥ v；数据范围 | none（查询） |
| `admin.pointAccount.summary` | `GET /admin/point-accounts/summary` | 积分账户 KPI | staff；模块 `billing` ≥ v；数据范围 | none（查询） |
| `admin.pointAccount.get` | `GET /admin/point-accounts/{pointAccountId}` | 积分账户详情 | staff；模块 `billing` ≥ v；数据范围 | none（查询） |
| `admin.pointAccount.pointLedgerEntry.list` | `GET /admin/point-accounts/{pointAccountId}/point-ledger-entries` | 积分流水 | staff；模块 `billing` ≥ v；数据范围 | none（查询） |
| `admin.pointAccount.adjustmentQuote` | `POST /admin/point-accounts/{pointAccountId}/adjustment-quote` | 调整影响预览 | staff；`billing.adjust.request` | none（试算） |
| `admin.pointAdjustmentRequest.create` | `POST /admin/point-adjustment-requests` | 发起积分调整 | staff；`billing.adjust.request` | required |
| `admin.pointAdjustmentRequest.get` | `GET /admin/point-adjustment-requests/{pointAdjustmentRequestId}` | 调整单详情 | staff；`assert-in-handler`（模块 `billing` 或 `finance` ≥ v）；数据范围 | none（查询） |
| `admin.pointAdjustmentRequest.approve` | `POST /admin/point-adjustment-requests/{pointAdjustmentRequestId}/approve` | 通过并入账 | staff；`billing.adjust.approve` | required |
| `admin.pointAdjustmentRequest.reject` | `POST /admin/point-adjustment-requests/{pointAdjustmentRequestId}/reject` | 驳回 | staff；`billing.adjust.approve` | required |
| `admin.pointAdjustmentRequest.withdraw` | `POST /admin/point-adjustment-requests/{pointAdjustmentRequestId}/withdraw` | 撤回 | staff；`assert-in-handler` | required |
| `admin.subscriptionTerm.list` | `GET /admin/subscription-terms` | 套餐到期跟进 | staff；模块 `order` ≥ v；数据范围 | none（查询） |
| `admin.subscriptionTerm.summary` | `GET /admin/subscription-terms/summary` | 套餐到期 KPI 与页签计数 | staff；模块 `order` ≥ v；数据范围 | none（查询） |
| `admin.subscriptionTerm.get` | `GET /admin/subscription-terms/{subscriptionTermId}` | 到期详情 | staff；模块 `order` ≥ v；数据范围 | none（查询） |
| `admin.subscriptionTerm.extensionQuote` | `POST /admin/subscription-terms/{subscriptionTermId}/extension-quote` | 补偿延长预览 | staff；`billing.extension.request` | none（试算） |
| `admin.subscriptionTerm.remind` | `POST /admin/subscription-terms/{subscriptionTermId}/remind` | 补发续费提醒 | staff；`order.renewal.remind`（增补） | required |
| `admin.termExtensionRequest.create` | `POST /admin/term-extension-requests` | 发起补偿延长 | staff；`billing.extension.request` | required |
| `admin.termExtensionRequest.get` | `GET /admin/term-extension-requests/{termExtensionRequestId}` | 延长单详情 | staff；`assert-in-handler`（模块 `order` 或 `billing` ≥ v）；数据范围 | none（查询） |
| `admin.termExtensionRequest.approve` | `POST /admin/term-extension-requests/{termExtensionRequestId}/approve` | 通过并顺延 | staff；`billing.extension.approve`（仅主管） | required |
| `admin.termExtensionRequest.reject` | `POST /admin/term-extension-requests/{termExtensionRequestId}/reject` | 驳回 | staff；`billing.extension.approve`（仅主管） | required |
| `admin.termExtensionRequest.withdraw` | `POST /admin/term-extension-requests/{termExtensionRequestId}/withdraw` | 撤回 | staff；`assert-in-handler` | required |
| `admin.paymentOrder.list` | `GET /admin/payment-orders` | 付款单列表 | staff；模块 `order` ≥ v；数据范围 | none（查询） |
| `admin.paymentOrder.summary` | `GET /admin/payment-orders/summary` | 付款单状态计数 | staff；模块 `order` ≥ v；数据范围 | none（查询） |
| `admin.paymentOrder.get` | `GET /admin/payment-orders/{paymentOrderId}` | 付款单详情（抽屉） | staff；模块 `order` ≥ v；数据范围 | none（查询） |
| `admin.paymentOrder.create` | `POST /admin/payment-orders` | 线下开单（对公） | staff；`order.payment.create_offline` | required |
| `admin.paymentOrder.transferProof.create` | `POST /admin/payment-orders/{paymentOrderId}/transfer-proofs` | 代传对公凭证 | staff；`finance.receipt.confirm` | required |
| `admin.transferProof.list` | `GET /admin/transfer-proofs` | 对公收款确认队列 | staff；模块 `order` ≥ v | none（查询） |
| `admin.transferProof.summary` | `GET /admin/transfer-proofs/summary` | 队列页签计数 | staff；模块 `order` ≥ v | none（查询） |
| `admin.transferProof.get` | `GET /admin/transfer-proofs/{transferProofId}` | 凭证详情与核对表 | staff；`assert-in-handler`（模块 `order` 或 `finance` ≥ v） | none（查询） |
| `admin.transferProof.confirm` | `POST /admin/transfer-proofs/{transferProofId}/confirm` | 确认到账 | staff；`finance.receipt.confirm` | required |
| `admin.transferProof.reject` | `POST /admin/transfer-proofs/{transferProofId}/reject` | 驳回凭证 | staff；`finance.receipt.reject` | required |
| `admin.transferProof.approveReview` | `POST /admin/transfer-proofs/{transferProofId}/approve-review` | 大额二人复核通过 | staff；`finance.receipt.confirm` | required |
| `admin.transferProof.rejectReview` | `POST /admin/transfer-proofs/{transferProofId}/reject-review` | 大额二人复核退回 | staff；`finance.receipt.confirm` | required |
| `admin.paymentTransaction.list` | `GET /admin/payment-transactions` | 收款流水 | staff；模块 `finance` ≥ v | none（查询） |
| `admin.paymentTransaction.summary` | `GET /admin/payment-transactions/summary` | 收款流水 KPI | staff；模块 `finance` ≥ v | none（查询） |
| `admin.paymentOrder.refundQuote` | `POST /admin/payment-orders/{paymentOrderId}/refund-quote` | 现金退款试算 | staff；`order.refund.request` | none（试算） |
| `admin.paymentOrder.refundRequest.create` | `POST /admin/payment-orders/{paymentOrderId}/refund-requests` | 发起现金退款申请 | staff；`order.refund.request`（规则外另需 `refund.override.request`） | required |
| `admin.refundRequest.list` | `GET /admin/refund-requests` | 现金退款申请列表 | staff；模块 `finance` ≥ v；数据范围 | none（查询） |
| `admin.refundRequest.summary` | `GET /admin/refund-requests/summary` | 页签计数与指标 | staff；模块 `finance` ≥ v；数据范围 | none（查询） |
| `admin.refundRequest.get` | `GET /admin/refund-requests/{refundRequestId}` | 申请详情 | staff；`assert-in-handler`（模块 `finance` 或 `order` ≥ v）；数据范围 | none（查询） |
| `admin.refundRequest.approve` | `POST /admin/refund-requests/{refundRequestId}/approve` | 审批通过 | staff；`finance.refund.approve` | required |
| `admin.refundRequest.reject` | `POST /admin/refund-requests/{refundRequestId}/reject` | 驳回 | staff；`finance.refund.approve` | required |
| `admin.refundRequest.withdraw` | `POST /admin/refund-requests/{refundRequestId}/withdraw` | 撤回 | staff；`assert-in-handler` | required |
| `admin.refundRequest.execute` | `POST /admin/refund-requests/{refundRequestId}/execute` | 执行（微信原路退） | staff；`finance.refund.execute` | required（三段式，多事务） |
| `admin.refundRequest.recordOffline` | `POST /admin/refund-requests/{refundRequestId}/record-offline` | 线下退款登记 | staff；`finance.refund.execute` | required |
| `admin.refundRequest.retry` | `POST /admin/refund-requests/{refundRequestId}/retry` | 同单号重试微信退款 | staff；`finance.refund.execute` | required（三段式） |
| `admin.refundRequest.confirmNotAccepted` | `POST /admin/refund-requests/{refundRequestId}/confirm-not-accepted` | 确认微信未受理 | staff；`finance.refund.execute` | required（三段式） |
| `admin.refundRequest.void` | `POST /admin/refund-requests/{refundRequestId}/void` | 作废已批准未执行的申请 | staff；`finance.refund.approve` | required |
| `admin.invoiceRequest.list` | `GET /admin/invoice-requests` | 开票申请队列 | staff；模块 `finance` ≥ v | none（查询） |
| `admin.invoiceRequest.summary` | `GET /admin/invoice-requests/summary` | 页签计数与 KPI | staff；模块 `finance` ≥ v | none（查询） |
| `admin.invoiceRequest.get` | `GET /admin/invoice-requests/{invoiceRequestId}` | 开票申请详情 | staff；模块 `finance` ≥ v | none（查询） |
| `admin.invoiceRequest.issue` | `POST /admin/invoice-requests/{invoiceRequestId}/issue` | 开具（电子或纸质） | staff；`finance.invoice.issue` | required |
| `admin.invoiceRequest.reject` | `POST /admin/invoice-requests/{invoiceRequestId}/reject` | 驳回开票申请 | staff；`finance.invoice.issue` | required |
| `admin.invoiceRequest.issueRed` | `POST /admin/invoice-requests/{invoiceRequestId}/issue-red` | 回填红字发票 | staff；`finance.invoice.red` | required |
| `admin.invoiceRequest.resend` | `POST /admin/invoice-requests/{invoiceRequestId}/resend` | 重发电子发票邮件 | staff；`finance.invoice.issue` | required |
| `admin.reconciliation.list` | `GET /admin/reconciliations` | 按月对账 | staff；模块 `finance` ≥ v | none（查询） |
| `admin.reconciliation.rerun` | `POST /admin/reconciliations/{reconciliationId}/rerun` | 重新对账 | staff；`finance.recon.resolve` | required |
| `admin.paymentException.list` | `GET /admin/payment-exceptions` | 差异单列表 | staff；模块 `finance` ≥ v | none（查询） |
| `admin.paymentException.get` | `GET /admin/payment-exceptions/{paymentExceptionId}` | 差异单详情 | staff；模块 `finance` ≥ v | none（查询） |
| `admin.paymentException.create` | `POST /admin/payment-exceptions` | 登记异常到账 | staff；`finance.recon.resolve` | required |
| `admin.paymentException.resolve` | `POST /admin/payment-exceptions/{paymentExceptionId}/resolve` | 处理差异 | staff；`finance.recon.resolve`（核销另需 `sys.super_admin`） | required（补单、补记渠道退款为三段式） |
| `admin.financeConfigRevision.list` | `GET /admin/finance-config-revisions` | 受控配置：当前值与历史 | staff；模块 `finance` ≥ v | none（查询） |
| `admin.financeConfigRevision.create` | `POST /admin/finance-config-revisions` | 提议变更 | staff；`finance.config.propose`（增补） | required |
| `admin.financeConfigRevision.approve` | `POST /admin/finance-config-revisions/{financeConfigRevisionId}/approve` | 批准 | staff；`finance.config.approve`（增补） | required |
| `admin.financeConfigRevision.reject` | `POST /admin/finance-config-revisions/{financeConfigRevisionId}/reject` | 驳回 | staff；`finance.config.approve`（增补） | required |
| `admin.financeConfigRevision.withdraw` | `POST /admin/finance-config-revisions/{financeConfigRevisionId}/withdraw` | 撤回 | staff；`assert-in-handler` | required |

路由注册顺序（A8、C12）：`POST /admin/plans/quote`、`GET /admin/plans/summary`、`GET /admin/point-packs/summary`、`GET /admin/point-accounts/summary`、`GET /admin/subscription-terms/summary`、`GET /admin/payment-orders/summary`、`GET /admin/transfer-proofs/summary`、`GET /admin/payment-transactions/summary`、`GET /admin/refund-requests/summary`、`GET /admin/invoice-requests/summary` 先于同层的 `/{xxxId}` 注册。

本文用到的权限点（以 07 主文档的注册表为准，A129；原 d4-identity.md:1141-1207，A13、A45）：`billing.plan.edit`、`billing.pack.edit`、`billing.param.edit`、`billing.price.edit`、`billing.adjust.request`、`billing.adjust.approve`、`billing.extension.request`、`billing.extension.approve`、`order.refund.request`、`order.payment.create_offline`、`finance.refund.approve`、`finance.refund.execute`、`finance.receipt.confirm`、`finance.receipt.reject`、`finance.invoice.issue`、`finance.invoice.red`、`finance.recon.resolve`；增补表新键（见下表）：`finance.config.propose`、`finance.config.approve`、`refund.override.request`、`order.renewal.remind`、`sys.super_admin`（A45）。明文查看（税号、收款账号等）走 a01 的 `admin.piiReveal.create`（`pii.bank.reveal`、`pii.license.view`），本文不重复。导出走 a02，权限点按导出键（`billing.export` 等，A88）。

权限点增补表（A13、A45、A129；进 07 主文档的注册表，取值由汇总人统一；清单的 `permissionSupplements` 同此，C66、C87）：

| 键 | 模块 | 默认授予（超级管理员拥有全部） | 再验证 | 待分配池 | 要求二次确认回显（C54） | 用于 |
| --- | --- | --- | --- | --- | --- | --- |
| `finance.config.propose` | 财务管理 | 财务 | 要 | 否 | 要（`{ configKey, baseRevisionId }`） | `admin.financeConfigRevision.create`（d2:1446） |
| `finance.config.approve` | 财务管理 | 财务 | 要（驳回按 C86 豁免） | 否 | 批准要（`{ configKey, financeConfigRevisionId }`，收款账户另带新账号后 4 位）；驳回、代撤不要 | `admin.financeConfigRevision.approve` / `reject`、代撤 |
| `refund.override.request` | 订单管理 | 仅超级管理员 | 要 | 否 | 要（随 3.55 的 `{ orderNo, amountFen }`） | 规则外套餐退款（d2:1486） |
| `order.renewal.remind` | 订单管理 | 交付经理、客服 | 否 | 否 | 否 | `admin.subscriptionTerm.remind` |
| `sys.super_admin` | 系统设置 | 仅超级管理员 | 否（A129：不另设再验证标记） | 否 | 要（随 3.79 的 `{ exceptionNo, amountFen }`） | 差异核销 `written_off`（A45） |
| 注册表改标（A46） | — | — | `finance.recon.resolve`、`order.payment.create_offline` 改为要再验证 | — | — | 3.43、3.75、3.78、3.79 |

页面与接口的对应：

| 画板 | 本文接口 | 其他文档的接口 |
| --- | --- | --- |
| A:Plans | `admin.plan.list`、`admin.plan.summary`、`admin.plan.planRevision.create`、`admin.planRevision.list`、`admin.planRevision.withdraw`、`admin.plan.quote`、`admin.plan.shelve` / `delist` / `create` / `update`；可选周期开关经 `admin.pricingChange.create`（参数 `enabledCycles`） | a09 `admin.siteNotice.list`（`kind` ∈ (`plan_revision`, `billing_param`) 的公告记录；不需公告的记录如“首个价目、套餐上线”由 `admin.planRevision.list` 给，前端合并） |
| A:PointPacks | `admin.pointPack.*` | — |
| A:Params | `admin.billingParam.list`、`admin.pricingChange.list`、`admin.pricingChange.create`、`admin.billingParam.withdraw` | a04 `admin.priceTierRevision.list`（S / A / B / C 恰好 4 行当前模板价与适用剧目数；V1.0 保存即生效，没有待生效行，A93；“评定依据”是前端文案，不由接口下发）；a04 `admin.dramaPriceRevision.list`（单剧调价，与本文 `pricingChange.list`（`kind = price_tier`）合并为“调价记录”时间线）；a01 `admin.paramValue.list` / `replace`（页面上的“下架提醒”是系统参数 `remind.offline.days`，见 3.16 与第 6 节第 2 项） |
| A:PointAccounts | `admin.pointAccount.*`、`admin.pointAdjustmentRequest.create` | a02 `admin.exportJob.create`（`point_accounts.list`） |
| A:CreditAdjust | `admin.pointAdjustmentRequest.get` / `approve` / `reject` / `withdraw` | a01 `admin.approval.list` / `summary`（`kind = points_adjust`） |
| A:Renewals | `admin.subscriptionTerm.*`、`admin.termExtensionRequest.*`、`admin.plan.quote` | a03 `admin.followUp.list` / `create`（续费跟进）；a02 导出 `subscription_terms.list` |
| A:Orders（付款单） | `admin.paymentOrder.list` / `summary` / `get`、`admin.paymentOrder.refundQuote`、`admin.paymentOrder.refundRequest.create` | a05 `admin.order.*`（订购单视图）；a02 导出 `payment_orders.list` |
| A:Receipts | `admin.transferProof.*`、`admin.paymentOrder.transferProof.create` | a01 `admin.file.downloadUrls`（凭证图）、`admin.file.create`（代传上传） |
| A:Payments | `admin.paymentTransaction.list` / `summary` | a02 导出 `payment_transactions.list` |
| A:Refunds | `admin.refundRequest.*` | a05 `admin.cancelRequest.*`（订购与广告取消，页签取值、默认页签与 `summary` 结构与本文一致，页面并排调用、计数相加）；a01 `admin.auth.stepUp` |
| A:Invoices、红字发票 | `admin.invoiceRequest.*` | a01 `admin.file.create`（发票文件）、`admin.file.downloadUrls`、`admin.piiReveal.create` |
| A:Reconcile | `admin.reconciliation.*`、`admin.paymentException.*` | a02 导出 `reconciliations.detail` |
| A:MerchantDetail | `admin.pointAccount.get`、`admin.pointAccount.pointLedgerEntry.list`、`admin.pointAccount.adjustmentQuote`、`admin.pointAdjustmentRequest.create`、`admin.paymentOrder.list` / `summary`（按门店所属主体 `entityId` 筛选，A29；付款单归属主体，见 3.40） | a03 `admin.store.get` |
| 受控财务配置、线下开单、线下退款登记（原型无） | `admin.financeConfigRevision.*`、`admin.paymentOrder.create`、`admin.refundRequest.recordOffline` | — |
| 我的待审批（原型无，A16） | 补偿延长、积分调整、对公复核、受控配置的详情与决定 | a01 `admin.approval.list` / `summary` / `get` |

## 2. 公共结构

### 2.0 本文通用规则

| 规则 | 内容 | 出处 |
| --- | --- | --- |
| 模块等级 | 查看类不设权限点，用模块等级（`billing`、`order`、`finance`）表达；“模块 X ≥ v”指 `staff_role.module_levels` 里该模块不为 `n`，不足返回 403 `PERMISSION_DENIED`。带权限点的写接口只要求该权限点，不另要求模块编辑等级（交付经理对“订单管理”只有查看，也能发起补偿延长）。要求“模块 X 或 Y ≥ v”的查看接口（3.9、3.26、3.36、3.47、3.58，与 a01 第 2.10 节审批类型表的查看等级一致）不能用 `adminRoute` 的单模块声明表达，路由声明 `permission: assert-in-handler`：处理器判定观察者 `staff_role.module_levels` 里两个模块任一不为 `n`，再套数据范围，都不满足 403 `PERMISSION_DENIED`（范围外 404） | C66；A45；d4-identity.md:1163、1220-1226 |
| 数据范围 | 主体级对象（积分账户、订阅周期、付款单、退款申请、调整单、延长单）按员工的 `DataScope` 过滤：主体下任一门店在范围内（`store.delivery_manager_id` 为本人或本组成员，或员工范围为“全部”）即可见；财务、超级管理员默认“全部”（d2:1497）。全局对象（套餐、积分包、参数、对账、差异单、受控配置、对公凭证队列）不按范围过滤。范围外与不存在不区分，404 `NOT_FOUND` | C45、C58；d4-identity.md:1232-1347 |
| 金额 | 单张单据、单个主体的金额 `integer(分)`；**跨主体的汇总金额**（KPI、列表合计、对账日汇总）一律 `string(bigint)`，字段名仍以 `Fen` 结尾，与 a02 的口径一致；`recon_day` 的 7 个汇总列本来就是 `bigint` | C31、C33；a02-workbench-report.md 2.1；08-billing-payment.md:53 |
| 积分与比例 | 积分 `integer(积分)`，带符号的变动用正负整数；比例 `integer(万分比)`，字段名以 `Bp` 结尾 | C32 |
| 时间 | 时刻 `string(date-time)`（UTC，`Z` 结尾）；日期 `string(date)`（北京时间）；月份 `YYYY-MM`。“今日”“本月”一律按北京时间切分；收款按 `payment_txn.channel_success_at` 落日，退款按 `refund_txn.success_at`，积分按 `point_ledger_entry.biz_date` | C34、C35；a02-workbench-report.md 2.1 |
| 敏感字段 | 税号、地址电话、开户行账号、接收邮箱、收件信息、收款账号、付款账号只返回 `…Mask`；明文走 a01 的 `admin.piiReveal.create`（C40）。平台对公收款账号同样只返回脱敏串（商家端例外见 m07 2.6） | C40；A19 |
| 文件 | 凭证图、回单、发票文件在响应里只出现 `fileId`；地址经 a01 的 `admin.file.downloadUrls` 现签（按文件分类判权、逐次留痕，A57）。上传经 a01 的 `admin.file.create` / `complete`，本文的写接口只接受已入库（`stored`）且未被拦截的 `fileId`，否则 400 `FILE_NOT_USABLE`（m03 定义；`details` 为 `{ fileIds, reason }`，`reason` 是 `x-open-enum`，本文会返回 `not_stored`（未入库）、`blocked`（已被拦截）、`category_mismatch`（分类不符）） | C41、C59、C60；A57；m03 第 5 节 |
| 二次确认 | 资金、积分、有效期相关的写请求带 `confirm`（各接口列出字段），服务端在事务内与库中当前值比对，不一致 409 `CONFIRM_MISMATCH`；界面的强制勾选项随请求提交为 `confirmChecks: string[]`（小写蛇形编码；有强制勾选的接口 1–10 项且必含该接口列出的编码，缺少或含未知值 400 `VALIDATION_FAILED`，与 a05 退款管理页的取消申请一致），审批类写进 `approval_request.confirm_checks`，其余写进审计 `audit_log.meta` | C54；d4-identity.md:1375；d2:878 |
| 再验证 | 以权限点注册表为准，接口不另声明（A13、C66）。本文涉及的标了再验证的键：`finance.refund.approve`、`finance.refund.execute`、`billing.adjust.approve`、`finance.receipt.confirm`；A46 新标的 `finance.recon.resolve`、`order.payment.create_offline`；增补建议的 `finance.config.propose`、`finance.config.approve`、`refund.override.request`。超出 10 分钟窗口返回 403 `STEP_UP_REQUIRED`，前端经 a01 `admin.auth.stepUp` 后用同一幂等键重放。唯一例外是审批的驳回（A127，维持 03-staff-authz-audit.md:806“驳回不要求再验证”）：3.28、3.38、3.51、3.60、3.83 在约定 C86 登记，路由标 `x-step-up: skip`，即使决定权限点标了再验证也不检查，错误表不列 `STEP_UP_REQUIRED`；通过、代撤、执行仍要求再验证。代撤（3.29、3.61、3.84）声明 `assert-in-handler`，处理器取到的决定权限点标了再验证时同样校验（C66）。对公凭证的驳回 3.49 用 `finance.receipt.reject`，本身不要求再验证，不登记 | C66、C67、C86；A46、A127；d4-identity.md:1376 |
| 审批决定时限 | `plan_refund`（3.55、3.79 转退款）提交时同事务写 `approval_request.due_at` 与 `sla_snapshot`（策略 `review.refund_approve`，参数 `sla.review.refund_approve`，1 个工作日，14-config-data.md:294），登记定时器 `sla.breach:approval_request:{approvalRequestId}:decision`；通过、驳回、撤回时取消（x01-events-jobs.md:511，与 a05 取消申请一致）。积分调整、补偿延长、受控配置、对公二人复核 V1.0 不设决定时限（A93）：`due_at` 为空，只按 `approval.escalate_workdays` 标逾期（03-staff-authz-audit.md:832） | A93；x01-events-jobs.md:511 |
| 审批决定的守卫顺序 | 与 a03 第 1.1 节相同，按中间件顺序（C7；d4-identity.md:1360-1364）：路由级的权限点与“仅主管”403 `PERMISSION_DENIED` → 再验证 403 `STEP_UP_REQUIRED`（驳回按 C86 跳过）→ 服务层取对象（范围外 404）→ 审批单不是 `pending` 409 `APPROVAL_NOT_PENDING` → 审批人是发起人 403 `APPROVAL_SELF_FORBIDDEN`（超级管理员也不例外）→ 处理器追加的权限判定 403（补偿延长“发起人所在组的主管”、规则外退款的 `refund.override.request`、差异核销的 `sys.super_admin`、代撤的决定权限点）→ `lockVersion`（只有 `approve` 带，A21；`03-staff-authz-audit.md:805`）409 `VERSION_CONFLICT` → `confirm` 409 `CONFIRM_MISMATCH` → 事务内重算业务前提，变了回滚并 409 `PRECONDITION_CHANGED`，审批单保持 `pending`。审批类错误码由 a03 定义（审批段 48200–48299） | A14；a03 第 1.1 节；03-staff-authz-audit.md:802-808；d4-identity.md:1398-1412 |
| 撤回 | 撤回者是提交人本人；发起人已不是启用状态（`staff.status ≠ active`）时，由该类型决定权限点的持有人（含“仅主管”与数据范围判断）代撤；其余 403 `APPROVAL_WITHDRAW_FORBIDDEN`（a03 定义）。路由声明 `permission: assert-in-handler` | A15、A45；03-staff-authz-audit.md:807、816-822 |
| 状态历史与审计 | `billing_order`、`refund_request`、`payment_exception`、`invoice_request`、`approval_request` 的状态迁移经 `flow.transition()` 写 `status_transition`（`state_field = status`）；子状态（`billing_order.transfer_state`、`billing_order.fulfillment_status`）与没有状态机的表只写 `audit_log`。每个写接口同事务写一条 `ops` 审计，记 `confirm` 与 `confirmChecks`；`audit_log.category` 取 03-staff-authz-audit.md:931 的登记编码：套餐版本、价目修订与积分包 `plan_config`；等级模板价 `price_adjust`；计费参数 `param`；积分调整 `points_adjust`；补偿延长 `term_adjust`；现金退款（含差异单转退款）`refund`；审批单的迁移随所属领域取同一编码。对公收款与线下开单、开票、对账与差异单、受控财务配置没有登记编码，本文暂写 `payment`、`invoice`、`recon`、`finance_config`，按 A107 进 07 主文档的待回写清单（主负责人定名后本文同步） | 08-billing-payment.md:57；03-staff-authz-audit.md:640、931；d2:1497；A107 |
| 三段式与结果脱敏 | 3.62（多事务）、3.64、3.65、3.79（`restore`、`record_channel_refund` 时先外调）是三段式用例，路由标 `x-three-phase`（C51、C75、A124），各接口写明外调与事务的先后、可续做的步骤。本文 `required` 路由的结果都不含激活码、令牌、签名地址、支付调起参数或明文个人信息（收款账号、付款账号只回脱敏串），不标 `x-redact-on-replay`（C50、A80） | C51；C75；A80；A84；A124 |
| 加锁顺序 | 审批单 → 退款申请 → 付款单 → 收款交易 / 凭证 → 退款交易 → 开票申请 → 差异单 → `billing_account`（只在账本函数内部、永远最后）。等账户锁超过 3 秒返回 503 `ACCOUNT_BUSY`（m07 定义，可用同一幂等键重试） | d2:1138-1146；07-billing-ledger.md:398 |
| 购买引导 | 续费提醒、到期说明是否带“去续费”与价格，由该主体的购买入口模式决定（`notification.copy_mode`）；后台页面照常显示价格 | d2:1326-1334；13-notify-docs.md:311 |

### 2.1 引用结构

员工一律用 a01 第 2.2 节的 `StaffBrief`（`{ staffId, staffNo, name, roleKey, isLead, status }`，后台全仓共用，C87）；本文初稿的 `StaffRef` 并入它，下文凡“`StaffBrief`”均指该结构。

字典项出接口用 `DictRef = { code, name }`（约定 C85 的通用结构，A150）：响应里的单值字典字段（驳回原因、申请原因、补偿原因、付款行）返回 `DictRef`（可空的写 `DictRef | null`），字段名不带 `Code` 后缀，名称按当前字典取、停用后仍返回；请求里提交编码，字段名带 `Code` 后缀（`reasonCode`、`payerBankCode`、`expressCompanyCode`，多选为 `reasonCodes`）（C85、A151）。系统枚举（`point_adjustment_request.reason_code`、`refund_request.rule_code`）与渠道原值（`refund_txn.fail_code`）不是字典，保持原样。

分页响应一律引用 a01 第 2.1 节的公共结构（C43、C87，A132）：页码分页 `AdminPage<T>`（`{ items, page, pageSize, total }`）、只增表的游标分页 `AdminCursorPage<T>`（`{ items, nextCursor, hasMore, totalApprox }`，3.23）；本文不再定义各列表自己的分页结构（清单里原有的 12 个 `…Page` 删去）。与 m07 同名不同构的结构，后台一侧加 `Admin` 前缀（A132、A150）：`AdminPaymentOrderListQuery`（3.40）、`AdminPaymentOrderSummary`（3.41）、`AdminInvoiceRequestListQuery`（3.67）、`AdminInvoiceRequestSummary`（3.68）。

`EntityRef`（经营主体，列表与详情共用）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `entityId` | string(uuid) | 是 | | `entity.id` |
| `name` | string | 是 | 主体全称 | `entity.name` |
| `primaryStoreId` | string(uuid) \| null | 是 | 主门店 | `store.id`（`store.is_primary = true`） |
| `primaryStoreName` | string \| null | 是 | 列表首列显示的门店名，如“XX 火锅（2 家门店）” | `store.name` |
| `storeCount` | integer | 是 | 启用中的门店数 | `store`（`store.entity_id` = 本主体、`store.lifecycle = active`）计数 |
| `verificationStatus` | enum | 是 | 同数据模型 `entity.verification_status` | `entity.verification_status` |
| `managerStaff` | `StaffBrief` \| null | 是 | 主门店的交付经理 | `store.delivery_manager_id` → `staff.name` |

`StoreRef`：`{ storeId, name }`，来源 `store.id`、`store.name`。

### 2.2 审批：`ApprovalInfo` 与决定请求体

领域详情里内嵌的审批单信息（一对一的 `approval_request`）。`ApprovalInfo` = a01 第 2.10 节的 `ApprovalDecisionView`（全仓共用：`approvalId`、`kind`、`status`、`roundNo`、`submittedAt`、`dueAt`、`badges`、`requester`、`decidedBy`、`isDecidedBySystem`、`decidedAt`、`decisionNote`、`reasons: [{ code, name }]`、`lockVersion`、`actions`，员工字段为 `StaffBrief`，来源同 a01）加下列本文用到的三个字段。初稿的 `approvalRequestId`、`reasonCodes` + `reasonLabels` 改为 a01 的 `approvalId`、`reasons`（读接口一律返回带名称的 `reasons`，决定请求体仍提交 `reasonCodes`）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `requestNo` | string \| null | 是 | 单号 `TZ…` / `YQ…` / `TK…`；受控配置与对公复核为 null | `approval_request.request_no` |
| `requesterRoleName` | string \| null | 是 | 发起人岗位显示名（“交付主管”“客服”；A:CreditAdjust 行内） | `staff.staff_role_key` → `staff_role.name`；主管加“主管”后缀取 `staff.is_lead` |
| `confirmChecks` | array<string> | 是 | 决定时勾选的核对项 | `approval_request.confirm_checks` |

决定请求体（各领域资源的 `approve` / `reject` / `withdraw` 共用，各接口另列 `confirm` 的字段与必含的核对项）：

| 结构 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `ApproveBody` | `lockVersion` | integer | 是 | | 审批单的 `lockVersion`（C53：审批单 `approve` 的守卫列了 `lock_version`） |
| | `confirm` | object | 是 | 见各接口 | 单号与关键数值回显（C54） |
| | `confirmChecks` | array<string> | 是 | 1–10 项，不重复，必含该接口列出的编码 | 界面强制勾选项 → `approval_request.confirm_checks` |
| `RejectBody` | `reasonCodes` | array<string> | 否 | 0–1 项（原型都是单选，与 a05 一致）；字典 `reject_reason` 对应场景的启用编码 | → `approval_request.reason_codes`（员工发起的审批原因可选，`03-staff-authz-audit.md:806`）；该场景尚未播种时不传 |
| | `note` | string | 是 | 1–200 字 | → `approval_request.decision_note` |
| `WithdrawBody` | `note` | string | 否 | 0–200 字 | → `approval_request.decision_note` |

驳回与撤回不带 `lockVersion`（`03-staff-authz-audit.md:806-807` 的守卫没有列锁版本，A21）；并发靠审批单行锁加 `status = pending` 条件。

### 2.3 套餐：`PlanAdminColumn`、`PlanRevisionView`

`PlanRevisionView`（价目修订）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `planRevisionId` | string(uuid) | 是 | | `plan_revision.id` |
| `planId` | string(uuid) | 是 | | `plan_revision.plan_id` |
| `revisionNo` | integer | 是 | 第几次修订 | `plan_revision.revision_no` |
| `monthlyFeeFen` | integer(分) | 是 | 月费 | `plan_revision.monthly_fee_fen` |
| `monthlyPoints` | integer(积分) | 是 | 每月套餐积分 | `plan_revision.monthly_points` |
| `discountBp` | integer | 是 | 订剧与广告折扣，10000 为原价 | `plan_revision.discount_bp` |
| `productionModel` | enum | 是 | 同数据模型 `plan_revision.production_model` | `plan_revision.production_model` |
| `maxStores` | integer | 是 | 可管理门店数 | `plan_revision.max_stores` |
| `maxMembers` | integer \| null | 是 | 成员上限，null = 不限（原型输入 0） | `plan_revision.max_members` |
| `schedulePriority` | enum | 是 | 同数据模型 `plan_revision.schedule_priority` | `plan_revision.schedule_priority` |
| `hasMonthlyReport` | boolean | 是 | | `plan_revision.has_monthly_report` |
| `cyclePrices` | array<object> | 是 | `[{ months, priceFen }]`，按月数升序 | `plan_revision.cycle_prices`：库里是以月数为键的对象 `{ "1": 600000, "3": 1680000 }`（`ck_plan_revision_cycle_prices` 要求 `jsonb_typeof = object`，07-billing-ledger.md:137、1429）；读时按键转成数组，写时（3.6）由数组转回对象 |
| `hasFirstCyclePromo` | boolean | 是 | 已开通商家调整后的首个周期沿用上一版价目 | `plan_revision.legacy_promo` 非空 |
| `effectiveAt` | string(date-time) | 是 | 生效时刻 | `plan_revision.effective_at` |
| `status` | enum(`PlanRevisionStatus`) | 是 | `pending` 待生效 / `effective` 当前生效 / `superseded` 已被更新的修订取代 / `cancelled` 已撤销 | 计算：`cancelled_at` 非空 → `cancelled`；`effective_at > now` → `pending`；该套餐 `effective_at ≤ now` 且未撤销的最新一行 → `effective`；其余 `superseded`（07-billing-ledger.md:122） |
| `cancelledAt` | string(date-time) \| null | 是 | | `plan_revision.cancelled_at` |
| `notice` | object \| null | 是 | 公告：`{ siteNoticeId, title, summary, summaryNoPrice, status, announcedAt, leadDays }`；首个修订豁免公告为 null | `plan_revision.site_notice_id` → `site_notice.title`、`site_notice.summary`、`site_notice.summary_no_price`、`site_notice.status`、`site_notice.announced_at`、`site_notice.lead_days` |
| `createdBy` | `StaffBrief` \| null | 是 | 播种行为 null | `plan_revision.created_by_staff_id` |
| `createdAt` | string(date-time) | 是 | | `plan_revision.created_at` |
| `actions` | array<string> | 是 | `withdraw`（`pending` 且持 `billing.plan.edit`） | 计算（C16） |

`PlanAdminColumn`（权益矩阵的一列）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `planId` | string(uuid) | 是 | | `plan.id` |
| `code` | string | 是 | `basic` / `pro` / `flagship`，可新增 | `plan.code` |
| `name` | string | 是 | | `plan.name` |
| `rank` | integer | 是 | 升降级比较 | `plan.rank` |
| `scope` | enum | 是 | 同数据模型 `plan.scope`（V1.0 只有 `public`） | `plan.scope` |
| `isListed` | boolean | 是 | 已上架 | `plan.is_listed` |
| `columnStatus` | enum(`PlanColumnStatus`) | 是 | 列头状态：`pending_change` 调整待生效 / `listed` 已上架 / `delisted` 已下架 / `draft` 未上架且没有生效价目 | 计算：有 `pending` 修订 → `pending_change`；否则按 `is_listed` 与有无 `effective` 修订 |
| `current` | `PlanRevisionView` \| null | 是 | 当前生效价目 | 见上 |
| `pending` | `PlanRevisionView` \| null | 是 | 待生效价目（至多一条，billing.I15） | 见上 |
| `activeEntityCount` | integer | 是 | 套餐生效主体数 | `subscription_term`（`status = active`、`ends_at > now`、`plan_id` = 本版本）计数 |
| `newThisMonthCount` | integer | 是 | 本月新开通 | 与 a02 `newCount` 同一指标函数，按版本过滤：`subscription_event`（`type = activated`、所属周期 `origin = new`、`biz_date` 在本月）且所属周期 `subscription_term.plan_id` = 本版本，按主体去重计数 |
| `renewedThisMonthCount` | integer | 是 | 本月续费 | 与 a02 `renewCount` 同一指标函数（a02-workbench-report.md:309），按版本过滤：`subscription_event`（`type = renewal_scheduled`，或 `type = activated` 且所属周期 `origin = resume`）、`biz_date` 在本月，且所属周期 `subscription_term.plan_id` = 本版本，按主体去重计数。`resumed` 是延长审批复活到期周期（x01-events-jobs.md:282），不是续费，不计入 |
| `lockVersion` | integer | 是 | `admin.plan.update` 带回 | `plan.lock_version` |
| `actions` | array<string> | 是 | `create-plan-revision`（编辑价目，3.6）、`update`（改名，3.85）、`shelve`、`delist`；持 `billing.plan.edit` 且状态允许 | 计算（C16；动作名见第 4.4 节） |

### 2.4 积分包：`PointPackRow`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `pointPackId` | string(uuid) | 是 | | `point_pack.id` |
| `points` | integer(积分) | 是 | 积分数 | `point_pack.points` |
| `priceFen` | integer(分) | 是 | 价格；“单价（元/积分）”由前端按 `priceFen ÷ points` 显示 | `point_pack.price_fen` |
| `isListed` | boolean | 是 | | `point_pack.is_listed` |
| `position` | integer | 是 | 展示顺序 | `point_pack.position` |
| `soldThisMonthCount` | integer | 是 | 本月售出笔数 | `billing_order`（`type = topup`、`status` ∈ (`paid`, `refunded`)、`paid_at` 在本月、`content_snapshot.packId` = 本包）计数 |
| `soldThisMonthFen` | string(bigint) | 是 | 本月金额（跨主体汇总） | 同上求和 `billing_order.paid_amount_fen` |
| `lockVersion` | integer | 是 | | `point_pack.lock_version` |
| `updatedAt` | string(date-time) | 是 | | `point_pack.updated_at` |
| `actions` | array<string> | 是 | `update`、`shelve`、`delist` | 计算 |

### 2.5 参数：`BillingParamView`

12 个键各一行（07-billing-ledger.md:1441-1454）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `key` | enum(`BillingParamKey`) | 是 | 同数据模型 `billing_param.key` 的 12 个取值 | `billing_param.key` |
| `needsNotice` | boolean | 是 | 是否需提前公告 | 代码常量 `NOTICE_REQUIRED_KEYS` |
| `schema` | object | 是 | 前端校验用的范围：`{ type: 'integer' \| 'integer_list' \| 'object', min?, max?, subKeys? }` | 契约里每个键的 Zod schema（07-billing-ledger.md:1456） |
| `defaultValue` | any(JSON) | 是 | 产品默认值，“恢复默认值”由前端回填，再点保存才生效（proto-admin-c.md:234） | 代码常量 |
| `current` | object | 是 | 此刻生效的值：`{ billingParamId, value, effectiveAt, changeId, createdBy: StaffBrief \| null }` | `paramsAt(now)`：该键 `billing_param.effective_at ≤ now` 且 `billing_param.cancelled_at` 为空的最新一行 |
| `pending` | object \| null | 是 | 待生效：`{ billingParamId, value, effectiveAt, changeId, siteNoticeId, createdBy }`；至多一条（billing.I15） | 该键 `billing_param.effective_at > now` 且未撤销的行 |
| `actions` | array<string> | 是 | `withdraw`（有待生效行且持 `billing.param.edit`） | 计算 |

`value` 的形态按键（同数据模型 `billing_param.value`）：数值键为 integer；`renewalReminderDays`、`enabledCycles` 为 integer 数组；`cancelDeductionBp` 为 `{ planConfirm, adAndSample, samplePending, postSample, adInProduction }`（各为万分比整数或 null）；`expiredTermRefund` 为 `{ merchant, platform, qualification }`（各为 `addon` / `forfeit`）。

### 2.6 变更集：`PricingChangeRecord`

一次保存（`POST /admin/pricing-changes`）是一条记录。同一次保存写入的 `price_tier_revision.batch_id` 与 `billing_param.change_id` 取同一个应用生成的 uuid（A94；两列都是“不指向任何表”的批次标识，07-billing-ledger.md:262、353），列表按它聚合；历史上单独保存的批次照常各成一条。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `changeSetId` | string(uuid) | 是 | 变更集标识 | `billing_param.change_id` / `price_tier_revision.batch_id` |
| `createdAt` | string(date-time) | 是 | 保存时间 | 该集合内最早的 `created_at` |
| `createdBy` | `StaffBrief` \| null | 是 | 操作人；播种为 null | `billing_param.created_by_staff_id` / `price_tier_revision.created_by_staff_id` |
| `note` | string \| null | 是 | 变更说明 | 含参数时取该集合 `billing_param.note`；只改模板价的集合取本次审计 `audit_log.meta.note`（`target_type = price_tier_revision`、`meta.changeSetId` = 本集合；`price_tier_revision` 没有说明列） |
| `tierItems` | array<object> | 是 | 模板价：`{ priceTierRevisionId, tier, previousPoints, points, effectiveAt }`；`previousPoints` 为该档上一条修订的值，没有为 null | `price_tier_revision.id`、`price_tier_revision.tier`、`price_tier_revision.points`、`price_tier_revision.effective_at` |
| `paramItems` | array<object> | 是 | 参数：`{ billingParamId, key, previousValue, value, effectiveAt, status }`；`previousValue` = 该键在本行 `effective_at` 前一刻的取值（读时现算）；`status`：`pending` / `effective` / `superseded` / `cancelled`（同 `PlanRevisionStatus` 的规则） | `billing_param.id`、`billing_param.key`、`billing_param.value`、`billing_param.effective_at`、`billing_param.cancelled_at` |
| `notice` | object \| null | 是 | 该集合的公告 `{ siteNoticeId, title, status, effectiveAt }`；没有需公告的键为 null | `billing_param.site_notice_id` → `site_notice` |
| `summaryText` | string | 是 | 原型“时间 · 操作人 · 内容”里的内容，如“广告每条积分 50 → 60，11-01 起生效” | 服务端按上面两组渲染 |

### 2.7 积分账户：`PointAccountRow`、`PointAccountDetail`、`AdminLedgerRow`

`PointAccountRow`（`pointAccountId` 取值等于主体 id，`billing_account` 的主键即 `entity_id`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `pointAccountId` | string(uuid) | 是 | | `billing_account.entity_id` |
| `entity` | `EntityRef` | 是 | | 见 2.1 |
| `subscription` | object | 是 | `{ status, plan: { planId, name } \| null, months, startDate, endDate, endsAt, upgradedFrom }` | 生效中取当前周期 `subscription_term`；已过期取最近结束的周期；`status` 现算（`subscription_term.status = active` 且 `ends_at > now` → `active`，否则有过周期 → `expired`，否则 `none`，不读 `billing_account.sub_status` 缓存）；`upgradedFrom`：本期最近一次 `subscription_event`（`type = upgraded`）的 `{ planName, at }`，“09-30 由基础版升级” |
| `planAvailablePoints` | integer(积分) | 是 | 套餐积分 | `billing_account.plan_available_qty` |
| `planPointsExpireAt` | string(date-time) \| null | 是 | 本期套餐积分清零时刻（“10-12 24:00 清零”）；非生效中为 null（字段名同 m07 `Wallet.points.planPointsExpireAt`） | 当前周期 `subscription_term.ends_at` |
| `addonAvailablePoints` | integer(积分) | 是 | 加购积分（含停用的） | `billing_account.addon_available_qty` |
| `isAddonSuspended` | boolean | 是 | 套餐过期，加购积分停用（原型写“已冻结”） | 计算：`subscription.status ≠ active` 且 `addonAvailablePoints > 0` |
| `heldPoints` | integer(积分) | 是 | 冻结中（订购、广告占用） | `billing_account.held_total_qty` |
| `spendablePoints` | integer(积分) | 是 | 可用积分 = 生效中且不在退款处理中 ? 套餐 + 加购 : 0（与 m07 `billing.getWalletView` 同一函数） | `billing_account.plan_available_qty`、`billing_account.addon_available_qty`；闸门同 `isRefundPending`（主体级） |
| `isRefundPending` | boolean | 是 | 套餐退款处理中；主体级，预约周期被标记也算（同 m07 第 2.0 节“退款处理中”） | 本主体任一 `subscription_term.status` 为 `scheduled` / `active` 的周期 `subscription_term.refund_request_id` 非空 |
| `hasPendingAdjustment` | boolean | 是 | 有在审的积分调整（按钮变“调整审批中”） | `approval_request`（`kind = points_adjust`、`status = pending`、`entity_id` = 本主体）存在 |

`PointAccountDetail` 含 `PointAccountRow` 的全部字段，另有：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `currentTerm` | object \| null | 是 | `{ subscriptionTermId, termNo, planName, months, startDate, endDate, endsAt, extendedDays, benefits: { discountBp, monthlyPoints, productionModel, maxStores, maxMembers } }` | `subscription_term.id`、`term_no`、`months`、`start_date`、`end_date`、`ends_at`、`extended_days` 与权益快照列 |
| `scheduledTerms` | array<object> | 是 | 已付款未生效的周期 `{ subscriptionTermId, planName, months, startDate, endDate }` | `subscription_term`（`status = scheduled`） |
| `planGrantedThisTerm` | integer(积分) | 是 | 本期已发放的套餐积分 | 当前周期套餐批次 `point_lot.original_qty` 之和 |
| `lastExpired` | object \| null | 是 | 最近一次期末清零 `{ points, at }` | `billing_account.last_expired_qty`、`billing_account.last_expired_at` |
| `notices` | object | 是 | 备注条：`{ pendingRefund: { refundRequestId, requestNo, status } \| null, pendingAdjustment: { pointAdjustmentRequestId, requestNo, direction, lotKind, adjustPoints } \| null, pendingExtension: { termExtensionRequestId, requestNo, days } \| null, pendingCancels: [{ cancelRequestId, requestNo, kind, targetNo, refundPoints, status }], heldAwaitingQualification: [{ pointHoldId, groupRef, qty, store: StoreRef }] }`。`pendingCancels`：“售后处理中：订购 LYX… 退回 2,430 积分，待财务审批（退款单 TK…）”；`heldAwaitingQualification`：“资质审核中：订购 … 1,200 积分已冻结”（PointAccounts.dc.html:190、206） | `pendingRefund`：本主体 `scheduled` / `active` 周期上挂的 `subscription_term.refund_request_id`（与 `isRefundPending` 同口径；有多张时取最早发起的一张）→ `refund_request.status`、`approval_request.request_no`；`pendingAdjustment`、`pendingExtension`：在审的 `point_adjustment_request`、`term_extension_request`（经 `approval_request.status = pending`）；`pendingCancels`：本主体在途的取消申请（a05 的表）`cancel_request`（`entity_id` = 本主体、`closed_at` 为空）的 `id`、`kind`、`total_refund_points`、`status`，单号取 `approval_request.request_no`，`targetNo` 取 `drama_order.order_no` 或 `ad.ad_no`（整店取消为 null）；`heldAwaitingQualification`：`point_hold`（`entity_id` = 本主体、`status = held`、`purpose = order_item`）且所属门店 `store.qualification_status = pending` 的 `id`、`group_ref`、`qty`、`store_id` |
| `actions` | array<string> | 是 | `create-point-adjustment-request`（持 `billing.adjust.request`、套餐生效中、没有在审调整） | 计算 |

`AdminLedgerRow`（后台流水行；存储是“每批次一行”，展示是“每次账本操作 × 积分类型一行”，d1:1406；后台与商家端的区别是“扣减”单独成行）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `rowKey` | string | 是 | 行标识 = 操作 id + 积分类型 | `ledger_operation.id` |
| `ledgerOperationId` | string(uuid) | 是 | | `ledger_operation.id` |
| `opType` | enum | 是 | 同数据模型 `ledger_operation.op_type` | `ledger_operation.op_type` |
| `category` | enum(`AdminLedgerCategory`) | 是 | 后台类型：`grant` 发放 / `purchase` 加购 / `hold` 冻结 / `capture` 扣减 / `return` 退回 / `expire` 清零 / `adjust` 调整 / `gate` 停用与恢复 | 按第 4.2 节映射 |
| `lotKind` | enum \| null | 是 | `plan` / `addon`；扣减与闸门行为 null | 取自哪一列的净变动 |
| `deltaPoints` | integer(积分) | 是 | 对“可用”的带符号变动；扣减与闸门行为 0 | `ledger_operation.plan_delta_qty` 或 `ledger_operation.addon_delta_qty` |
| `qty` | integer(积分) | 是 | 本行涉及的数量（扣减行即“由冻结转出”的数量，不带符号） | 扣减行：该操作 `point_ledger_entry`（`held → consumed`）的 `qty` 之和；其余 = `abs(deltaPoints)` |
| `occurredAt` | string(date-time) | 是 | 业务生效时刻 | `ledger_operation.occurred_at` |
| `bizDate` | string(date) | 是 | | `ledger_operation.biz_date` |
| `title` | string | 是 | 事项标题 | 按 `ledger_operation.title_code`、`ledger_operation.title_args` 渲染，文案码与参数按 m07 第 4.5 节的现行表（含 `capture`、`fix`；`ad_hold` 的参数为 `adNo`），后台不另建文案表 |
| `formula` | string \| null | 是 | 算式或支付信息，如“(6,600 − 3,000) × 20 ÷ 30 ＝ ＋2,400” | 同上 |
| `refNo` | string \| null | 是 | 关联单号（`LYX…`、`GG…`、`FK…`、`TZ…`、`TK…`、`YQ…`） | `point_hold.group_ref`；付款类取 `billing_order.order_no`；审批类取 `approval_request.request_no`（按 `ledger_operation.ref_type`、`ledger_operation.ref_id`） |
| `store` | `StoreRef` \| null | 是 | 门店级操作的门店 | `ledger_operation.store_id` → `store.name` |
| `spendableAfterPoints` | integer(积分) | 是 | 操作后的可用余额 | `ledger_operation.spendable_after_qty` |
| `heldAfterPoints` | integer(积分) | 是 | 操作后的冻结合计 | `ledger_operation.held_after_qty` |
| `actor` | object | 是 | 操作人 `{ type, name }`：员工取 `staff.name`，商家取 `merchant_user.display_name`，系统为“系统” | `ledger_operation.actor_type`、`ledger_operation.actor_id` |

### 2.8 积分调整：`PointAdjustmentRequestDetail`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `pointAdjustmentRequestId` | string(uuid) | 是 | | `point_adjustment_request.id` |
| `requestNo` | string | 是 | `TZ…` | `approval_request.request_no` |
| `entity` | `EntityRef` | 是 | 被调整的主体 | `point_adjustment_request.entity_id` |
| `direction` | enum | 是 | 同数据模型 `point_adjustment_request.direction` | `point_adjustment_request.direction` |
| `lotKind` | enum | 是 | 同数据模型 `point_adjustment_request.lot_kind` | `point_adjustment_request.lot_kind` |
| `adjustPoints` | integer(积分) | 是 | 数量（正数，方向看 `direction`） | `point_adjustment_request.adjust_points` |
| `signedPoints` | integer(积分) | 是 | 带符号（“＋270”“−1,000”） | 计算 |
| `reasonCode` | enum | 是 | 同数据模型 `point_adjustment_request.reason_code` | `point_adjustment_request.reason_code` |
| `note` | string | 是 | 说明（商家在积分明细里可见） | `point_adjustment_request.note` |
| `pointHold` | object \| null | 是 | 关联的订购或广告 `{ pointHoldId, purpose, groupRef, qty, status }`（“订购单 LYX…（应扣 2,700 积分）”） | `point_adjustment_request.point_hold_id` → `point_hold.purpose`、`point_hold.group_ref`、`point_hold.qty`、`point_hold.status` |
| `termExtensionRequest` | object \| null | 是 | 来源延长单 `{ termExtensionRequestId, requestNo }` | `point_adjustment_request.term_extension_request_id` |
| `spendableBeforePoints` | integer(积分) | 是 | 发起时的可用积分（快照，只供展示） | `point_adjustment_request.spendable_before_points` |
| `spendableAfterPreviewPoints` | integer(积分) | 是 | 发起时预览的调整后可用（“3,810 → 4,080”） | 计算：`spendableBeforePoints` ± `adjustPoints` |
| `currentSpendablePoints` | integer(积分) | 是 | 此刻可用（审批人核对用；入账时重新校验） | 同 `PointAccountRow.spendablePoints` |
| `applied` | object \| null | 是 | 入账结果 `{ ledgerOperationId, appliedAt, spendableAfterPoints }`；未入账为 null | `point_adjustment_request.ledger_operation_id`、`point_adjustment_request.applied_at`、`ledger_operation.spendable_after_qty` |
| `relatedServiceTickets` | array<object> | 是 | 关联客服工单 `{ serviceTicketId, ticketNo }`（调整依据之一，CreditAdjust 的核对项“关联广告任务、订购单或客服工单”） | `service_ticket_ref`（`ref_type = approval_request`、`ref_id` = 审批单，07-billing-ledger.md:1189）→ `service_ticket.ticket_no` |
| `approval` | `ApprovalInfo` | 是 | | `point_adjustment_request.approval_request_id` |
| `actions` | array<string> | 是 | `approve`、`reject`（审批单 `pending`、观察者持 `billing.adjust.approve` 且不是发起人）；`withdraw`（见 2.0 撤回规则） | 计算 |

### 2.9 订阅周期：`SubscriptionTermRow`、`SubscriptionTermDetail`

`ReminderNode`（续费与清零提醒的一个节点）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `node` | string | 是 | `T-7`、`T-3`、`T-1`、`T-0`（按参数 `renewalReminderDays` 加到期当天）、`M`（人工补发） | 参数 `billing_param`（`key = renewalReminderDays`）；`notification.node` |
| `dueDate` | string(date) | 是 | 计划日期 = 止日 − N 天；`M` 为补发当天 | 计算：`subscription_term.end_date` |
| `state` | enum(`ReminderState`) | 是 | `sent` 已发送 / `pending` 待发送 / `skipped` 未发（周期已续费、退款或节点早于开通） | `notification`（`notify_scene_key = m.plan_expiring`、`biz_type = subscription_term`、`biz_id` = 本周期、`node` = 本节点）存在 → `sent`；`dueDate` 未到 → `pending`；其余 `skipped` |
| `channels` | array<object> | 是 | `[{ channel, status, sentAt }]`：订阅消息、短信的投递结果 | `notification_delivery.channel`、`notification_delivery.status`、`notification_delivery.sent_at` |

`SubscriptionTermRow`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `subscriptionTermId` | string(uuid) | 是 | | `subscription_term.id` |
| `entity` | `EntityRef` | 是 | | `subscription_term.entity_id` |
| `plan` | object | 是 | `{ planId, name }` | `subscription_term.plan_id` → `plan.name` |
| `months` | integer | 是 | 月付 / 季付 / 年付 | `subscription_term.months` |
| `startDate`、`endDate` | string(date) | 是 | 本行周期的起止（含补偿延长）；`renewed` 页签的行是被续的上一周期（见 3.30），`endDate` 即页面的“原至” | `subscription_term.start_date`、`subscription_term.end_date` |
| `status` | enum | 是 | 同数据模型 `subscription_term.status` | `subscription_term.status` |
| `remainingDays` | integer \| null | 是 | `expiring` 页签：止日 − 今日（0 = 今天到期） | 计算 |
| `expiredDays` | integer \| null | 是 | `expired` 页签：已过期天数 | 计算：今日 − 止日 |
| `reminders` | array<`ReminderNode`> | 是 | 提醒进度（7 / 3 / 1 天三个节点的已发、待发） | 见上 |
| `points` | object | 是 | `{ planAvailablePoints, lastExpiredPoints, addonAvailablePoints, isAddonSuspended }`（“套餐积分 820 将清零”“套餐积分已清零、加购 N 已冻结”） | `billing_account` 同名缓存列、`billing_account.last_expired_qty` |
| `renewal` | object \| null | 是 | `renewed` 页签：续上本行的新周期 `{ subscriptionTermId, paymentOrderId, orderNo, planName, months, amountFen, paidAt, newStartDate, newEndDate, renewalTiming }`；其余页签为 null | 新周期（同主体 `term_no` = 本行 + 1）的 `subscription_term.id`、`start_date`、`end_date`、`plan_id` → `plan.name`；其来源付款单 `subscription_term.source_billing_order_id` → `billing_order.order_no`、`billing_order.paid_amount_fen`、`billing_order.paid_at`；`renewalTiming`（`RenewalTiming`）：新周期 `origin = resume` → `after_expiry`（过期后续费）；否则 `paid_at` 早于本行 `end_date` 前 7 天以上 → `early`（提前续费），其余 → `before_due`（到期前续费）（Renewals.dc.html:273） |
| `intent` | enum(`RenewalIntent`) | 是 | 续费意向：`none` 待跟进 / `considering` 考虑中 / `confirmed` 已确认续费 / `declined` 暂不续费 / `renewed` 已续费 / `extension_pending` 延长审批中 | 在审延长单 → `extension_pending`；已有后续周期 → `renewed`；否则取该周期最新一条 `follow_up.intent`（`follow_up.subject_type = subscription_term`，03-staff-authz-audit.md:492），没有为 `none` |
| `manager` | `StaffBrief` \| null | 是 | 交付经理（主门店） | `store.delivery_manager_id` |
| `remindedToday` | boolean | 是 | 今天已人工补发（“今日已补发”） | `manual_reminder_log`（`subject_type = subscription_term`、`scene = renewal`、`biz_date` = 今日）存在 |
| `actions` | array<string> | 是 | `remind`（持 `order.renewal.remind`、今日未补发、周期可提醒）、`create-term-extension-request`（持 `billing.extension.request`、`expiring` 页签的生效周期、没有在审延长单）。“记录跟进”“续费试算”是前端按模块查看等级显示的入口（a03 `admin.followUp.create`、3.9），不放进 `actions` | 计算 |

`SubscriptionTermDetail` 含行的全部字段，另有：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `endsAt` | string(date-time) | 是 | 到期时刻（止日次日 00:00） | `subscription_term.ends_at` |
| `benefits` | object | 是 | 权益快照 `{ monthlyPoints, discountBp, productionModel, maxStores, maxMembers, schedulePriority, hasMonthlyReport }` | `subscription_term` 同名列 |
| `pointsForecast` | object | 是 | “套餐积分 820 将于 10-01 24:00 清零；加购 N 将停用”：`{ planPointsToExpire, expiresAt, addonWillSuspend }` | `billing_account.plan_available_qty`、`subscription_term.ends_at`、`billing_account.addon_available_qty` |
| `orderItems` | object | 是 | 进行中的短剧（“成片交付中 1 部、待上线 1 部（10-02 上线）、上线中 N 部，不受到期影响”，Renewals.dc.html:229-230、324）：`{ producingCount, toLaunchCount, liveCount, nextLaunchDate }`；`nextLaunchDate` 为待上线短剧最早的约定上线日，没有为 null | `order_item`（`order_item.entity_id` = 本主体）按 `order_item.phase` ∈ (`producing`, `to_launch`, `live`) 计数；`nextLaunchDate` = `phase = to_launch` 的最小 `order_item.agreed_launch_date` |
| `nextTerm` | object \| null | 是 | 已续费时的新周期 `{ subscriptionTermId, planName, months, startDate, endDate, paymentOrderId, orderNo, amountFen, paidAt }` | 链上的下一个 `subscription_term` 与其来源付款单 |
| `extensions` | array<object> | 是 | 作用于本周期的延长 `{ termExtensionRequestId, requestNo, days, appliedMode, appliedAt }` | `term_extension_request`（`applied_subscription_term_id` = 本周期） |
| `pendingExtension` | object \| null | 是 | 在审延长单 `{ termExtensionRequestId, requestNo, days, requester }` | `term_extension_request` + `approval_request.status = pending` |
| `latestFollowUp` | object \| null | 是 | 最新跟进 `{ followUpId, intent, channel, content, createdAt, owner: StaffBrief }`；完整跟进记录调 a03 `admin.followUp.list`（`subjectType = subscription_term`） | `follow_up` |

### 2.10 延长单：`TermExtensionRequestDetail`、`ExtensionQuote`

`ExtensionQuote`（预览；在审时详情里按“此刻”重算一次，供审批人看到真实作用）：

| 字段 | 类型 | 必有 | 说明 | 来源（计算规则，d1:1010-1040） |
| --- | --- | --- | --- | --- |
| `mode` | enum | 是 | `extend` 未到期顺延 / `revive` 到期后补批（周期复活）/ `not_applicable` 不可执行 | 主体有生效周期 → `extend`；没有生效周期且最近结束的周期为 `ended`、延长单发起时刻早于其原 `ends_at` → `revive`；其余 `not_applicable` |
| `targetSubscriptionTermId` | string(uuid) \| null | 是 | 实际会延长的周期 | 同上 |
| `isTargetDifferent` | boolean | 是 | 发起后原周期已续接，延长作用于新周期（原周期已清零的积分不恢复，需要补的另提积分调整） | 计算 |
| `days` | integer | 是 | 延长天数 | 请求 |
| `prevEndDate`、`newEndDate` | string(date) \| null | 是 | 前后止日；`revive` 时新止日 = max(原止日, 今日 − 1) + `days` | `subscription_term.end_date` |
| `newEndsAt` | string(date-time) \| null | 是 | 新到期时刻，套餐积分清零时间同步顺延 | 计算 |
| `restorePoints` | integer(积分) | 是 | `revive` 时冲回的已清零积分（最近一次期末清零的数量），其余 0 | 最近一次 `ledger_operation`（`op_type = expire`、`ref_id` = 该周期）的套餐变动 |
| `shiftedTerms` | array<object> | 是 | 已排队的预约周期整体后移 `{ subscriptionTermId, startDate, endDate }`（新起止） | `subscription_term`（`status = scheduled`）重算 |
| `blockReasons` | array<string> | 是 | 不可执行的原因：`no_term`、`term_refunded`、`refund_in_progress`、`pending_exists` | 计算 |

`TermExtensionRequestDetail`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `termExtensionRequestId` | string(uuid) | 是 | | `term_extension_request.id` |
| `requestNo` | string | 是 | `YQ…` | `approval_request.request_no` |
| `entity` | `EntityRef` | 是 | | `term_extension_request.entity_id` |
| `subscriptionTerm` | object | 是 | 发起时的周期 `{ subscriptionTermId, planName, startDate, endDate }` | `term_extension_request.subscription_term_id` |
| `days` | integer | 是 | | `term_extension_request.days` |
| `reason` | `DictRef` | 是 | 补偿原因 `{ code, name }`（字典 `extend_reason`：交付延误补偿 / 平台故障影响使用 / 服务问题补偿 / 其他；C85） | `term_extension_request.reason_code`，名称取当前 `dict_item.name`（停用后仍返回） |
| `note` | string | 是 | | `term_extension_request.note` |
| `preview` | `ExtensionQuote` \| null | 是 | 审批单 `pending` 时按此刻重算；已决为 null | 同 3.33 |
| `applied` | object \| null | 是 | 执行结果 `{ appliedSubscriptionTermId, appliedMode, prevEndDate, newEndDate, appliedAt, ledgerOperationId }` | `term_extension_request.applied_subscription_term_id`、`applied_mode`、`prev_end_date`、`new_end_date`、`applied_at`、`ledger_operation_id` |
| `relatedAdjustments` | array<object> | 是 | 由本单带出的补发积分调整 `{ pointAdjustmentRequestId, requestNo, status }` | `point_adjustment_request`（`term_extension_request_id` = 本单） |
| `approval` | `ApprovalInfo` | 是 | | `term_extension_request.approval_request_id` |
| `actions` | array<string> | 是 | `approve`、`reject`（观察者是发起人所在组的主管或超级管理员，且不是发起人）；`withdraw` | 计算 |

### 2.11 付款单：`PaymentOrderAdminRow`、`PaymentOrderAdminDetail`

`PaymentOrderAdminRow`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `paymentOrderId` | string(uuid) | 是 | | `billing_order.id` |
| `orderNo` | string | 是 | `FK…` | `billing_order.order_no` |
| `createdAt` | string(date-time) | 是 | | `billing_order.created_at` |
| `entity` | `EntityRef` | 是 | 商家与付款主体 | `billing_order.entity_id` |
| `store` | `StoreRef` \| null | 是 | 下单门店（仅展示） | `billing_order.store_id` |
| `type` | enum | 是 | 同数据模型 `billing_order.type` | `billing_order.type` |
| `title` | string | 是 | 内容，如“专业版 · 3 个月”“升级旗舰版（本期剩余 12 天）”“加购 1,000 积分” | 同 m07 `PaymentOrderCard.title` 的渲染规则（`billing_order.content_snapshot`） |
| `contentNote` | string \| null | 是 | 内容的补充说明，如“本期结束后生效 · 新周期 10-13 至 11-12”“重复付款，多排一个周期” | `billing_order.fulfillment_result`（`effectiveAt`、`queuedBehindActive`）、`billing_order.fulfillment_note` |
| `amountFen` | integer(分) | 是 | 应付 | `billing_order.amount_fen` |
| `paidAmountFen` | integer(分) | 是 | 实收 | `billing_order.paid_amount_fen` |
| `refundedAmountFen` | integer(分) | 是 | 已退 | `billing_order.refunded_amount_fen` |
| `channel` | enum | 是 | 同数据模型 `billing_order.channel` | `billing_order.channel` |
| `status` | enum | 是 | 同数据模型 `billing_order.status`（严格 5 种） | `billing_order.status` |
| `transferState` | enum \| null | 是 | 对公子状态 | `billing_order.transfer_state` |
| `fulfillmentStatus` | enum | 是 | 同数据模型 `billing_order.fulfillment_status` | `billing_order.fulfillment_status` |
| `statusNote` | string \| null | 是 | 状态下的子说明：“待财务确认”“附言缺付款单号”“凭证被驳回”“30 分钟未支付，系统自动取消”“履约受阻”“对账差异待处理” | `billing_order.transfer_state`、`billing_order.cancel_reason`、`billing_order.fulfillment_status`、`billing_order.has_open_exception`；待确认收款时另看当前待处理凭证的 `transfer_proof.check_result.items`：`remark_order_no` 为 `fail` / `warn` → “附言缺付款单号”（Orders.dc.html:157；08-billing-payment.md:1403） |
| `hasOpenException` | boolean | 是 | | `billing_order.has_open_exception` |
| `source` | enum | 是 | 同数据模型 `billing_order.source`（`weapp` / `admin`） | `billing_order.source` |
| `pendingTransferProofId` | string(uuid) \| null | 是 | 当前待处理的对公凭证（`confirm` 动作的路径参数） | `transfer_proof`（`billing_order_id` = 本单、`review_status = pending`）的 `id` |
| `actions` | array<string> | 是 | `confirm`（待确认收款、有 `pendingTransferProofId`、持 `finance.receipt.confirm`；前端跳 A:Receipts 核对后调 3.48）、`create-refund-request`（见 3.54 的可发起条件，持 `order.refund.request`）、`submit-proof`（对公且待支付未过期或待确认 `proof_submitted`，持 `finance.receipt.confirm`；与 m07 第 4.3 节同名，3.44） | 计算（动作名见第 4.4 节） |

`PaymentTxnView`（付款单详情里的支付记录，收款流水行的子集）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `paymentTransactionId` | string(uuid) | 是 | | `payment_txn.id` |
| `attemptNo` | integer | 是 | 第几次尝试 | `payment_txn.attempt_no` |
| `channel` | enum | 是 | | `payment_txn.channel` |
| `status` | enum | 是 | 同数据模型 `payment_txn.status` | `payment_txn.status` |
| `outTradeNo` | string | 是 | 商户单号 | `payment_txn.out_trade_no` |
| `channelTxnNo` | string \| null | 是 | 微信交易单号（28 位）或规范化银行流水号 | `payment_txn.channel_txn_no` |
| `channelAmountFen` | integer(分) \| null | 是 | 渠道实收 | `payment_txn.channel_amount_fen` |
| `feeFen` | integer(分) \| null | 是 | 手续费（对账回填） | `payment_txn.fee_fen` |
| `channelSuccessAt` | string(date-time) \| null | 是 | 收款时间（对公为确认到账时间） | `payment_txn.channel_success_at` |
| `isApplied` | boolean | 是 | 已入账到本单 | `payment_txn.applied_at` 非空 |
| `refundedFen` | integer(分) | 是 | 已退 | `payment_txn.refunded_fen` |
| `reconState` | enum | 是 | 同数据模型 `payment_txn.recon_state` | `payment_txn.recon_state` |
| `payerName` | string \| null | 是 | 对公付款户名（公司名，非个人信息） | `payment_txn.channel_payer_ref`（仅 `bank_transfer`） |
| `confirmedBy`、`reviewedBy` | `StaffBrief` \| null | 是 | 对公：确认人、复核人 | `payment_txn.confirmed_by_staff_id`、`payment_txn.reviewed_by_staff_id` |

`PaymentOrderAdminDetail` 含行的全部字段，另有：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `formula` | object \| null | 是 | 计算式 `{ code, args, text }`；灾备重建的付款单为 null | `billing_order.formula_code`、`billing_order.formula_args`（模板码同 m07 第 4.4 节） |
| `content` | object | 是 | 购买内容，结构同 m07 `PaymentOrderContentView` | `billing_order.content_snapshot` |
| `effectNote` | string \| null | 是 | 生效说明：“付款后立即生效”“本期结束后生效 · 新周期 …”“开通时间以确认到账时间为准” | `billing_order.fulfillment_result.effectiveAt`、`queuedBehindActive`；未支付的对公单取固定说明 |
| `expiresAt` | string(date-time) | 是 | 待支付截止 | `billing_order.expires_at` |
| `paidAt`、`cancelledAt`、`refundedAt`、`fulfilledAt` | string(date-time) \| null | 是 | | `billing_order.paid_at`、`billing_order.cancelled_at`、`billing_order.refunded_at`、`billing_order.fulfilled_at` |
| `cancelReason` | enum \| null | 是 | 同数据模型 `billing_order.cancel_reason` | `billing_order.cancel_reason` |
| `fulfillment` | object \| null | 是 | 在 m07 第 2.6 节同名字段 `{ effectiveAt, isQueuedBehindActive, term: { planName, startDate, endDate } \| null, points }` 的基础上扩展 `status`（`done` / `blocked`）、`termId`、`lotIds`、`reasonCode`（`blocked` 时有值；`done` 时为 null）；`blocked` 时 m07 的四个字段按已算出的部分给、算不出的为 null。`fulfillment_status = none` 时整体为 null | `billing_order.fulfillment_status`、`billing_order.fulfillment_result`（`FulfillResult`，08-billing-payment.md:1383）；`term` 取 `fulfillment_result.termId` 指向的 `subscription_term` 与 `plan.name`，`points` 取快照的 `monthlyPoints` / `topupPoints` / `points`（同 m07） |
| `placedBy` | object \| null | 是 | 下单老板 `{ merchantUserId, displayName, phoneMask }` | `billing_order.placed_by_user_id` → `merchant_user.display_name`、`merchant_user.phone_mask` |
| `createdBy` | `StaffBrief` \| null | 是 | 代建员工 | `billing_order.created_by_staff_id` |
| `contractNo` | string \| null | 是 | 线下合同号 | `billing_order.contract_no` |
| `clientPlatform`、`clientVersion` | string \| null | 是 | 下单端 | `billing_order.client_platform`、`billing_order.client_version` |
| `bankAccount` | object \| null | 是 | 对公：创建时展示给商家的收款账户 `{ financeConfigRevisionId, accountName, bankName, accountNoMask }` | `billing_order.bank_account_finance_config_revision_id` → `finance_config_revision.payload`、`finance_config_revision.account_no_mask` |
| `paymentTxns` | array<`PaymentTxnView`> | 是 | 支付记录 | `payment_txn`（`billing_order_id` = 本单） |
| `transferProofs` | array<object> | 是 | 历次凭证 `{ transferProofId, uploadNo, reviewStatus, uploadedAt, reviewedAt, uploadedBy }` | `transfer_proof` |
| `refundRequests` | array<object> | 是 | 退款申请 `{ refundRequestId, requestNo, ruleCode, amountFen, status, closeReason, createdAt }` | `refund_request`（`billing_order_id` = 本单）、`approval_request.request_no` |
| `invoice` | object | 是 | 发票状态 `{ state, latest: { invoiceRequestId, requestNo, status, invoiceType, medium } \| null }`；`state`：`not_eligible`（未支付或未履约，“支付后可申请 / 确认到账后可申请”）/ `not_requested` / `requested` / `issued` / `red_pending` / `red_issued` / `rejected` | `invoice_request`（本单最新一张） |
| `openExceptions` | array<object> | 是 | 未决差异单 `{ paymentExceptionId, exceptionNo, kind, status }` | `payment_exception`（`status` ∈ (`open`, `resolving`)） |
| `logs` | array<object> | 是 | 操作日志时间线 `{ at, actor, action, note }` | `status_transition`（`machine = billing_order`）与 `audit_log`（`target_type = billing_order`）按时间合并 |
| `lockVersion` | integer | 是 | | `billing_order.lock_version` |

### 2.12 对公凭证：`TransferProofQueueItem`、`TransferProofDetail`

`TransferProofQueueItem`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `transferProofId` | string(uuid) | 是 | | `transfer_proof.id` |
| `uploadNo` | integer | 是 | | `transfer_proof.upload_no` |
| `paymentOrderId`、`orderNo` | string | 是 | | `transfer_proof.billing_order_id` → `billing_order.order_no` |
| `orderType` | enum | 是 | | `billing_order.type` |
| `entity` | `EntityRef` | 是 | | `transfer_proof.entity_id` |
| `amountFen` | integer(分) | 是 | 应收 | `billing_order.amount_fen` |
| `uploadedAt` | string(date-time) | 是 | | `transfer_proof.uploaded_at` |
| `uploadedBy` | object | 是 | `{ type: merchant \| staff, name }` | `transfer_proof.uploaded_by_user_id` / `transfer_proof.uploaded_by_staff_id` |
| `dueAt` | string(date-time) \| null | 是 | 应处理截止（上传后 1 个工作日） | `transfer_proof.due_at` |
| `isOverdue` | boolean | 是 | | 计算 |
| `hints` | array<enum(`ProofHint`)> | 是 | 提示标签：`uploaded_today`、`uploaded_earlier`（“昨日上传，请优先处理”）、`remark_missing_order_no`、`payer_name_mismatch`、`amount_mismatch`、`upgrade_quote_expiring`、`in_review` | `transfer_proof.check_result`（各项 `result`）、`transfer_proof.first_confirm`、`billing_order.content_snapshot.validUntil` |
| `reviewStatus` | enum | 是 | 同数据模型 `transfer_proof.review_status` | `transfer_proof.review_status` |
| `reviewedAt` | string(date-time) \| null | 是 | | `transfer_proof.reviewed_at` |
| `reviewedBy` | `StaffBrief` \| null | 是 | | `transfer_proof.reviewed_by_staff_id` |

`TransferProofDetail` 含队列项的全部字段，另有：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `order` | object | 是 | `{ title, formulaText, createdAt, expiresAt, status, transferState, createdBy: StaffBrief \| null }`（“旗舰版 · 3 个月（12,000 × 3）”） | `billing_order` |
| `bizHints` | array<object> | 是 | 业务提示 `{ code, text }`：`plan_starts_on_confirm`（“确认到账后开通旗舰版…开通时间以确认到账时间为准”）、`qualification_in_review`（“商家资质审核中；确认到账后基础版即生效”）、`renewal_queued`（续费在本期结束后生效）、`upgrade_quote_valid_until` | `billing_order.type`、`billing_order.content_snapshot`、`entity.verification_status`、当前周期 |
| `fileId` | string(uuid) | 是 | 回单文件；图片经 a01 `admin.file.downloadUrls` 签发 | `transfer_proof.file_id` |
| `fileMime` | string | 是 | | `file_object.mime` |
| `ocr` | object | 是 | `{ status, recognized: { payerName, payerAccountMask, payeeName, amountFen, remark, tradedAt } \| null, warnings }`；未配置识别时 `status = unavailable` | `transfer_proof.ocr_result_id` → `ocr_result.status`、解密 `ocr_result.fields_enc`（账号只给脱敏串）、`ocr_result.warnings` |
| `checks` | array<object> | 是 | 凭证核对表 `{ key, result, proofValue, orderValue }`：`payer_name`（户名一致）、`amount`、`remark_order_no`（附言含付款单号）、`trade_time`（转账时间晚于创建） | `transfer_proof.check_result.items`；`orderValue` 取 `entity.name`、`billing_order.amount_fen`、`billing_order.order_no`、`billing_order.created_at` |
| `firstConfirm` | object \| null | 是 | 二人复核中：第一人确认的内容 `{ bankSerialRaw, payerBank: DictRef \| null, receivedAmountFen, confirmedBy: StaffBrief, confirmedAt }`（`payerBank` 为字典 `bank`，C85） | `transfer_proof.first_confirm`；确认人与时间取复核审批单的 `requester_staff_id`、`submitted_at` |
| `review` | `ApprovalInfo` \| null | 是 | 复核审批单 | `transfer_proof.review_approval_request_id` |
| `rejectReason` | `DictRef` \| null | 是 | 驳回原因 `{ code, name }`（字典 `reject_reason` 场景 `transfer`；C85） | `transfer_proof.reject_reason_code` → `dict_item.name` |
| `rejectNote` | string \| null | 是 | 驳回说明 | `transfer_proof.reject_note` |
| `otherUploads` | array<object> | 是 | 同一付款单的其他上传 `{ transferProofId, uploadNo, reviewStatus, uploadedAt }` | `transfer_proof` |
| `secondReviewThresholdFen` | integer(分) \| null | 是 | 当前二人复核阈值；null = 未启用 | 受控配置 `controls` 当前生效版本的 `receiptSecondReviewFen` |
| `lockVersion` | integer | 是 | | `transfer_proof.lock_version` |
| `actions` | array<string> | 是 | `confirm`、`reject`（`pending` 且不在复核中）；`approve-review`、`reject-review`（复核中，观察者不是第一确认人） | 计算 |

### 2.13 收款流水：`PaymentTransactionRow`

只列成功的收款（`payment_txn.status = succeeded`），含孤儿到账。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `paymentTransactionId` | string(uuid) | 是 | | `payment_txn.id` |
| `channelSuccessAt` | string(date-time) | 是 | 收款时间（对公为财务确认到账时间） | `payment_txn.channel_success_at` |
| `channelTxnNo` | string | 是 | 交易单号或银行流水号（带复制按钮） | `payment_txn.channel_txn_no` |
| `channel` | enum | 是 | | `payment_txn.channel` |
| `paymentOrder` | object \| null | 是 | `{ paymentOrderId, orderNo, type }`；孤儿到账为 null | `payment_txn.billing_order_id` → `billing_order` |
| `entity` | `EntityRef` \| null | 是 | 孤儿到账为 null | `payment_txn.entity_id` |
| `channelAmountFen` | integer(分) | 是 | 实收 | `payment_txn.channel_amount_fen` |
| `feeFen` | integer(分) \| null | 是 | | `payment_txn.fee_fen` |
| `refundedFen` | integer(分) | 是 | 已退；大于 0 时显示“已退款”标签（退款不冲减收款记录） | `payment_txn.refunded_fen` |
| `isApplied` | boolean | 是 | 已入账 | `payment_txn.applied_at` 非空 |
| `reconState` | enum | 是 | 同数据模型 `payment_txn.recon_state`；对公收款：财务确认的为 `matched`，人工登记的孤儿到账（3.78）为 `diff`，差异处理后为 `resolved` | `payment_txn.recon_state` |
| `payerName` | string \| null | 是 | 对公付款户名 | `payment_txn.channel_payer_ref` |

### 2.14 现金退款：`CashRefundQuote`、`RefundRequestRow`、`RefundRequestDetail`、`RefundTxnView`

`CashRefundQuote`（发起前试算，也是申请详情里 `breakdown` 的来源）：

| 字段 | 类型 | 必有 | 说明 | 来源（计算规则） |
| --- | --- | --- | --- | --- |
| `supported` | boolean | 是 | 属于 V1.0 支持的现金退款组合 | d2:1018-1031；M98、M111：开通、续费且履约完成的付款单；已被 `override` 作废周期之后的升级补差付款单（只退现金）。加购、单独的升级补差、未履约、部分金额都不支持 |
| `unsupportedReason` | enum \| null | 是 | `topup_not_refundable`、`upgrade_refund_source_first`、`not_fulfilled`、`not_paid`、`already_refunded`、`open_request_exists` | 计算 |
| `rules` | array<object> | 是 | 三条套餐规则逐条结论 `{ rule, eligible, reasons }`；`reasons` 取 `outside_window`、`points_used`、`term_upgraded`、`qualification_not_dead`、`term_not_refundable` | `billing.previewPlanRefund`（d1:1070-1074）；`qualification_failed` 另看 `profile.isQualificationDead`（08-billing-payment.md:575） |
| `suggestedRule` | enum \| null | 是 | 按 `window` → `qualification_failed` 的次序取第一条成立的；`override` 只在请求显式指定且观察者持 `refund.override.request` 时给出 | 计算 |
| `refundableFen` | integer(分) | 是 | 可退金额（V1.0 全额 = 该笔收款实收 − 已退） | `payment_txn.channel_amount_fen` − `payment_txn.refunded_fen` |
| `paymentTxn` | `PaymentTxnView` | 是 | 被退的收款（付款单的入账交易） | `billing_order.paid_payment_txn_id` |
| `term` | object \| null | 是 | 被退周期 `{ subscriptionTermId, planName, status, startsAt, endsAt, upgraded }`（“本期 09-10 至 10-09”） | `billing_order.fulfillment_result.termId` → `subscription_term` |
| `windowDeadline` | string(date-time) \| null | 是 | 窗口截止 = 周期 `starts_at` + `planRefundWindowHours`；预约周期为 null | 计算 |
| `withinWindow`、`unused` | boolean | 是 | 窗口内、未使用积分（含冻结） | `previewPlanRefund` |
| `sideEffects` | object | 是 | `{ revokePoints, cancelSchedules, addonWillSuspend, nextTermWillStartNow }`（预览给客服看的后果：名下加购积分 N 退款后停用、不退现金） | `previewPlanRefund.sideEffects` |
| `routePreview` | enum | 是 | 预计的执行路由：`wechat_original` / `offline` | 微信收款且 `channel_success_at` + 365 天 − 参数 `refund.original_route_safety_hours` > 现在 → `wechat_original`，否则 `offline`（d2:917） |
| `invoice` | object | 是 | `{ latestStatus, needsRedInvoice }`：最新开票申请为 `issued` / `red_pending` 时执行前须回填红字发票 | `invoice_request.status` |
| `openRequest` | object \| null | 是 | 该笔收款已有的在途申请 `{ refundRequestId, requestNo, status }` | `refund_request`（`payment_txn_id` 相同、`closed_at` 为空） |

`RefundTxnView`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `refundTxnId` | string(uuid) | 是 | | `refund_txn.id` |
| `outRefundNo` | string | 是 | 商户退款单号；重试沿用 | `refund_txn.out_refund_no` |
| `channel`、`origin`、`status` | enum | 是 | 同数据模型 `refund_txn.channel`、`refund_txn.origin`、`refund_txn.status` | 同名列 |
| `amountFen` | integer(分) | 是 | | `refund_txn.amount_fen` |
| `channelRefundNo` | string \| null | 是 | 微信退款单号或规范化退款流水号 | `refund_txn.channel_refund_no` |
| `submitCount`、`lastSubmitAt` | integer、string(date-time) \| null | 是 | | `refund_txn.submit_count`、`refund_txn.last_submit_at` |
| `isRetryHalted` | boolean | 是 | 已停止自动重试 | `refund_txn.is_retry_halted` |
| `failCode`、`failMessage` | string \| null | 是 | | `refund_txn.fail_code`、`refund_txn.fail_message` |
| `successAt` | string(date-time) \| null | 是 | | `refund_txn.success_at` |
| `userReceivedAccount` | string \| null | 是 | 微信返回的入账账户描述 | `refund_txn.user_received_account` |
| `isLateSuccess` | boolean | 是 | | `refund_txn.is_late_success` |
| `offline` | object \| null | 是 | 线下登记 `{ transferDate, payeeName, payeeBank, payeeAccountMask, receiptFileId, note, registeredBy: StaffBrief }` | `refund_txn.transfer_date`、`payee_name`、`payee_bank`、`payee_account_mask`、`receipt_file_id`、`note`、`registered_by_staff_id` |

`RefundRequestRow`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `refundRequestId` | string(uuid) | 是 | | `refund_request.id` |
| `requestNo` | string | 是 | `TK…` | `approval_request.request_no` |
| `source` | enum | 是 | 同数据模型 `refund_request.source` | `refund_request.source` |
| `entity` | `EntityRef` \| null | 是 | 孤儿收款为 null | `refund_request.entity_id` |
| `paymentOrder` | object \| null | 是 | `{ paymentOrderId, orderNo, type, title }` | `refund_request.billing_order_id` |
| `amountFen` | integer(分) | 是 | 申请退款金额 | `refund_request.amount_fen` |
| `ruleCode` | enum | 是 | 同数据模型 `refund_request.rule_code` | `refund_request.rule_code` |
| `ruleText` | string | 是 | 规则文案快照 | `refund_request.rule_text` |
| `status` | enum | 是 | 同数据模型 `refund_request.status` | `refund_request.status` |
| `closeReason` | enum \| null | 是 | 同数据模型 `refund_request.close_reason` | `refund_request.close_reason` |
| `execRoute` | enum \| null | 是 | | `refund_request.exec_route` |
| `execDueAt` | string(date-time) \| null | 是 | 执行时限 | `refund_request.exec_due_at` |
| `isExecOverdue` | boolean | 是 | | 计算 |
| `hasExecError` | boolean | 是 | 执行失败待处理（队列标“需处理”） | `refund_request.exec_error` 非空且状态为 `pending_execution` 或 `executing` |
| `requester` | `StaffBrief` \| null | 是 | | `approval_request.requester_staff_id` |
| `createdAt` | string(date-time) | 是 | 申请时刻 | `refund_request.created_at` |
| `decidedAt`、`doneAt`、`closedAt` | string(date-time) \| null | 是 | | `approval_request.decided_at`、`refund_request.done_at`、`refund_request.closed_at` |

`RefundRequestDetail` 含行的全部字段，另有：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `reason` | `DictRef` \| null | 是 | 申请原因 `{ code, name }`（字典 `refund_reason`；C85）；差异转入为 null | `refund_request.reason_code` → `dict_item.name` |
| `note` | string \| null | 是 | 申请说明 | `refund_request.note` |
| `isOverride` | boolean | 是 | 规则外退款 | `refund_request.is_override` |
| `baseAmountFen`、`deductAmountFen` | integer(分) | 是 | 基数、扣除（V1.0 恒为 0） | `refund_request.base_amount_fen`、`refund_request.deduct_amount_fen` |
| `paymentTxn` | `PaymentTxnView` | 是 | 被退的收款 | `refund_request.payment_txn_id` |
| `breakdown` | object | 是 | 核算快照：套餐规则 `{ termId, termStartsAt, termEndsAt, termStatus, windowDeadline, withinWindow, unused, upgraded, addonAvailable, sideEffects }`；差异转入 `{ paymentExceptionId, exceptionNo, exceptionKind, unappliedFen, blockReasonCode }` | `refund_request.breakdown_snapshot`（08-billing-payment.md:1429-1453） |
| `stageNote` | string | 是 | 所处阶段：“开通 3 天，未使用积分”“本期已生效 16 天”“重复付款的未入账收款” | 按 `breakdown` 与申请时刻渲染 |
| `recheckLog` | object \| null | 是 | 审批、执行时的复核结果 `{ approve?, execute? }` | `refund_request.recheck_log` |
| `invoice` | object | 是 | `{ latest: { invoiceRequestId, requestNo, status } \| null, needsRedInvoice }`（“已开票的付款须先开具红字发票，再执行退款”） | `invoice_request`（本付款单最新一张） |
| `entitlementRevokedAt` | string(date-time) \| null | 是 | 权益已回收的时刻（非空后不可作废） | `refund_request.entitlement_revoked_at` |
| `executedBy`、`executedAt` | `StaffBrief`、string(date-time) \| null | 是 | 最近一次执行 | `refund_request.executed_by_staff_id`、`refund_request.executed_at` |
| `voidedBy`、`closeNote` | `StaffBrief`、string \| null | 是 | 作废人与说明 | `refund_request.voided_by_staff_id`、`refund_request.close_note` |
| `execError` | object \| null | 是 | 最近一次执行失败 `{ at, refundTxnId, code, message }` | `refund_request.exec_error` |
| `refundTxns` | array<`RefundTxnView`> | 是 | 历次退款交易 | `refund_txn`（`refund_request_id` = 本单） |
| `allowedRoutes` | array<enum> | 是 | 此刻可走的执行路由（`wechat_original`、`offline`） | 计算：见 3.62、3.63 的守卫 |
| `canRetry`、`canConfirmNotAccepted` | boolean | 是 | 是否满足重试、确认未受理的条件 | 见 3.64、3.65 |
| `paymentException` | object \| null | 是 | 差异转入的来源 `{ paymentExceptionId, exceptionNo, kind }` | `payment_exception`（`refund_request_id` = 本单） |
| `relatedServiceTickets` | array<object> | 是 | 关联客服工单 `{ serviceTicketId, ticketNo }` | `service_ticket_ref`（`ref_type = approval_request`、`ref_id` = 审批单）→ `service_ticket.ticket_no` |
| `approval` | `ApprovalInfo` | 是 | | `refund_request.approval_request_id` |
| `logs` | array<object> | 是 | 处理记录时间线 `{ at, actor, action, note }` | `status_transition`（`machine` ∈ (`refund_request`, `approval_request`)）与 `audit_log` 合并 |
| `actions` | array<string> | 是 | `approve`、`reject`、`withdraw`、`execute`、`record-offline`、`retry`、`confirm-not-accepted`、`void` | 计算 |

### 2.15 发票：`InvoiceRequestAdminRow`、`InvoiceRequestAdminDetail`

`InvoiceRequestAdminRow`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `invoiceRequestId` | string(uuid) | 是 | | `invoice_request.id` |
| `requestNo` | string | 是 | `KP…` | `invoice_request.request_no` |
| `entity` | `EntityRef` | 是 | | `invoice_request.entity_id` |
| `paymentOrder` | object | 是 | `{ paymentOrderId, orderNo, type, title }` | `invoice_request.billing_order_id` |
| `amountFen` | integer(分) | 是 | 开票金额 = 付款单实付 | `invoice_request.amount_fen` |
| `invoiceType`、`medium` | enum | 是 | 同数据模型 `invoice_request.invoice_type`、`invoice_request.medium` | 同名列 |
| `needsMail` | boolean | 是 | 纸质发票（“需邮寄”） | `invoice_request.medium = paper` |
| `status` | enum | 是 | 同数据模型 `invoice_request.status`；纸质 `issued` 显示“已寄出” | `invoice_request.status` |
| `appliedAt` | string(date-time) | 是 | | `invoice_request.applied_at` |
| `dueAt` | string(date-time) \| null | 是 | 处理时限（未配置为 null） | `invoice_request.due_at` |
| `isHeldByRefund` | boolean | 是 | 退款处理中，暂停开具 | `invoice_request.held_by_refund_request_id` 非空 |
| `resultNote` | string \| null | 是 | 处理结果：发票号码、快递与运单号、驳回原因 | `invoice_doc`、`invoice_request.reject_reason_code`、`invoice_request.reject_kind` |

`InvoiceRequestAdminDetail` 含行的全部字段，另有：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `title` | string | 是 | 抬头（认证主体） | `invoice_request.title` |
| `taxNoMask` | string | 是 | 税号脱敏串 | `invoice_request.tax_no_mask` |
| `addrTelMask`、`bankAccountMask` | string \| null | 是 | 专票：地址电话、开户行账号（脱敏） | `invoice_request.addr_tel_mask`、`invoice_request.bank_account_mask` |
| `recvEmailMask` | string \| null | 是 | 电子：接收邮箱 | `invoice_request.recv_email_mask` |
| `mailToMask` | string \| null | 是 | 纸质：收件信息 | `invoice_request.mail_to_mask` |
| `itemName` | string | 是 | 开票项目快照 | `invoice_request.item_name` |
| `orderPaidAt`、`orderChannel` | string(date-time)、enum | 是 | 付款时间与方式 | `billing_order.paid_at`、`billing_order.channel` |
| `prechecks` | array<object> | 是 | 开票前自动核对 `{ key, passed }`：`order_paid_not_refunded`、`no_refund_in_flight`、`title_from_verified_license`、`not_invoiced_before`、`special_fields_filled`（专票） | 服务端现算（d2:1366；proto-admin-d.md:219） |
| `heldByRefund` | object \| null | 是 | `{ refundRequestId, requestNo }` | `invoice_request.held_by_refund_request_id` |
| `docs` | array<object> | 是 | 票据：m07 `InvoiceDocView` 的字段，另加 `invoiceDocId`、`fileId`、`issuedBy: StaffBrief`、`emailSentAt`、`redReason` | `invoice_doc.id`、`file_id`、`issued_by_staff_id`、`email_sent_at`、`red_reason` 等 |
| `reject` | object \| null | 是 | `{ kind, reason: DictRef \| null, note, rejectedBy: StaffBrief \| null, rejectedAt }`（`reason` 为字典 `reject_reason` 场景 `invoice` 的 `{ code, name }`，C85；系统自动驳回时为 null） | `invoice_request.reject_kind`、`reject_reason_code`、`reject_note`、`rejected_by_staff_id`、`rejected_at` |
| `lockVersion` | integer | 是 | | `invoice_request.lock_version` |
| `actions` | array<string> | 是 | `issue`、`reject`（`pending`）；`issue-red`（`red_pending`）；`resend`（蓝字票据邮件 `failed`） | 计算 |

### 2.16 对账：`ReconMonth`、`ReconDayRow`

`ReconDayRow`（一天一行，微信与对公两条 `recon_day` 合并展示）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `billDate` | string(date) | 是 | 账单日 | `recon_day.bill_date` |
| `reconciliationId` | string(uuid) \| null | 是 | 微信渠道那一行（“重新对账”的对象）；当天尚未建行为 null | `recon_day.id`（`channel = wechat_jsapi`） |
| `platformPay` | object | 是 | 平台微信收款 `{ count, amountFen }` | `recon_day.platform_pay_count`、`recon_day.platform_pay_fen`（string(bigint)） |
| `billPay` | object \| null | 是 | 微信账单收款；账单未到为 null（“次日生成 / 账单未下载”） | `recon_day.bill_pay_count`、`recon_day.bill_pay_fen` |
| `bank` | object \| null | 是 | 对公到账（仅展示） | `recon_day.bank_count`、`recon_day.bank_fen`（`channel = bank_transfer` 的行） |
| `refund` | object \| null | 是 | 退款 `{ platformCount, platformFen, billCount, billFen }`（账单按受理日、平台按成功日，仅展示） | `recon_day.platform_refund_count`、`platform_refund_fen`、`bill_refund_count`、`bill_refund_fen` |
| `feeFen` | string(bigint) | 是 | 手续费合计 | `recon_day.fee_fen` |
| `diff` | object \| null | 是 | `{ count, amountFen, resolutions: [{ resolution, amountFen }] }`（“补单 ¥1,000.00”“原路退款 ¥1,000.00”） | `recon_day.diff_count`、`recon_day.diff_fen`；`payment_exception`（`bill_date` = 当日）的 `resolution`、`amount_fen` |
| `status` | enum | 是 | 同数据模型 `recon_day.status`（`wait` / `ok` / `diff` / `fixed`） | `recon_day.status`（微信行） |
| `billFileStatus` | enum \| null | 是 | 同数据模型 `wx_bill_file.status` | `wx_bill_file.status` |
| `runCount`、`lastRunAt` | integer、string(date-time) \| null | 是 | | `recon_day.run_count`、`recon_day.last_run_at` |
| `actions` | array<string> | 是 | `resolve`（有待处理差异，前端跳差异单）、`rerun`（账单已解析，持 `finance.recon.resolve`）。行内“导出”是前端入口（a02 `admin.exportJob.create`，`reconciliations.detail`），不放进 `actions` | 计算 |

`ReconMonth`（`admin.reconciliation.list` 的响应；A78 的有界小集合：当月日行放在 `items`，不带分页字段，月度概览等作为并列的上下文字段，C43）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `items` | array<`ReconDayRow`> | 是 | 当月每天一行，日期倒序；不分页（至多 31 行，前端按 8 行一页） | 见上 |
| `month` | string | 是 | `YYYY-MM` | 请求 |
| `overview.platform` | object | 是 | 平台收款 `{ count, amountFen, wechatCount, bankCount }` | 当月 `recon_day` 平台侧与对公列之和 |
| `overview.wechatBill` | object | 是 | `{ count, amountFen, downloadedThrough }`：账单已下载解析到哪一天 | `recon_day.bill_pay_count`、`recon_day.bill_pay_fen` 之和；`wx_bill_file`（`status` ∈ (`parsed`, `empty`)）的最大 `bill_date` |
| `overview.refund` | object | 是 | `{ count, amountFen, isBillMatched }` | 当月 `refund_txn`（`status = succeeded`，按 `success_at`）；`isBillMatched` = 当月退款交易都已 `recon_state` ∈ (`matched`, `resolved`) |
| `overview.diff` | object | 是 | `{ openCount, openAmountFen, resolvingCount, earliestOpenBillDate }`：`openCount` 为待处理（与工作台 ⑰ `recon_diff` 同一计数函数，2.19），`resolvingCount` 为已转退款、等退款完成 | `payment_exception`（`bill_date` 在当月）：`status = open` 计数与 `amount_fen` 之和；`status = resolving` 计数；未决（`open`、`resolving`）中最早的 `bill_date` |
| `dayStatusCounts` | object | 是 | `{ ok, diff, fixed, wait }`（“已对平 28 天，有差异 1 天，待对账 1 天”） | 计算 |
| `openExceptions` | array<`PaymentExceptionRow`> | 是 | 告警区：当月未决差异（`open`、`resolving`，至多 20 条） | 见 2.17 |
| `prevMonthAllOk` | boolean | 是 | 上月是否全部对平（“8 月已全部对平”） | 上月 `recon_day.status` 都是 `ok` 或 `fixed` |

### 2.17 差异单：`PaymentExceptionRow`、`PaymentExceptionDetail`

`PaymentExceptionRow`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `paymentExceptionId` | string(uuid) | 是 | | `payment_exception.id` |
| `exceptionNo` | string | 是 | `CY…` | `payment_exception.exception_no` |
| `kind` | enum | 是 | 同数据模型 `payment_exception.kind`（14 种） | `payment_exception.kind` |
| `detectedBy` | enum | 是 | 同数据模型 `payment_exception.detected_by` | `payment_exception.detected_by` |
| `billDate` | string(date) | 是 | | `payment_exception.bill_date` |
| `entity` | `EntityRef` \| null | 是 | | `payment_exception.entity_id` |
| `paymentOrder` | object \| null | 是 | `{ paymentOrderId, orderNo, type, title }` | `payment_exception.billing_order_id` |
| `channelTxnNo` | string \| null | 是 | 微信交易单号或银行流水号 | `payment_exception.payment_txn_id` → `payment_txn.channel_txn_no` |
| `amountFen` | integer(分) | 是 | 差异金额 | `payment_exception.amount_fen` |
| `causeText` | string \| null | 是 | 系统判断的原因（“支付回调晚于取消”） | `payment_exception.cause_text` |
| `status` | enum | 是 | 同数据模型 `payment_exception.status` | `payment_exception.status` |
| `resolution` | enum | 是 | 同数据模型 `payment_exception.resolution` | `payment_exception.resolution` |
| `createdAt`、`resolvedAt` | string(date-time) \| null | 是 | | `payment_exception.created_at`、`payment_exception.resolved_at` |
| `isOverdue` | boolean | 是 | 未决超过 1 个工作日（升级告警） | 计算（08-billing-payment.md:790） |

`PaymentExceptionDetail` 含行的全部字段，另有：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `billFact`、`platformFact` | object \| null | 是 | 两侧事实 `{ outTradeNo, transactionId, outRefundNo, refundId, amountFen, state, occurredAt, text }`（“09-29 17:31:52 支付成功”） | `payment_exception.bill_fact`、`payment_exception.platform_fact` |
| `paymentTxn` | `PaymentTxnView` \| null | 是 | | `payment_exception.payment_txn_id` |
| `refundTxn` | `RefundTxnView` \| null | 是 | | `payment_exception.refund_txn_id` |
| `wxBillLine` | object \| null | 是 | `{ wxBillLineId, lineNo, lineKind, tradedAt, outTradeNo, outRefundNo, orderAmountFen, refundAmountFen, matchState }` | `payment_exception.wx_bill_line_id` → `wx_bill_line` 同名列 |
| `allowedResolutions` | array<enum> | 是 | 按类型与当前状态可选的处理方式（第 4.3 节矩阵）；`written_off` 只对超级管理员出现 | 计算（08-billing-payment.md:770-782） |
| `linkCandidates` | array<object> | 是 | `bank_unmatched`：可关联的付款单 `{ paymentOrderId, orderNo, entity, amountFen, status, createdAt }`（对公、待支付或待确认且不在复核、金额相等） | `billing_order` |
| `hints` | array<object> | 是 | `{ code, text }`：如补单前提示“该主体在取消后已有新的已支付付款单 FK…”（d2:1103） | 计算 |
| `resolutionNote` | string \| null | 是 | 处理说明 | `payment_exception.resolution_note` |
| `resolvedBy` | `StaffBrief` \| null | 是 | | `payment_exception.resolved_by_staff_id` |
| `refundRequest` | object \| null | 是 | 转退款生成的申请 `{ refundRequestId, requestNo, status }` | `payment_exception.refund_request_id` |
| `lockVersion` | integer | 是 | | `payment_exception.lock_version` |
| `actions` | array<string> | 是 | `resolve` | 计算 |

### 2.18 受控财务配置：`FinanceConfigRevisionView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `financeConfigRevisionId` | string(uuid) | 是 | | `finance_config_revision.id` |
| `configKey` | enum | 是 | 同数据模型 `finance_config_revision.config_key`（`bank_account` / `purchase_policy` / `controls`） | `finance_config_revision.config_key` |
| `payload` | object | 是 | 按键：`bank_account` 为 `{ accountName, bankName, accountNoMask }`（账号明文经 a01 `admin.piiReveal.create`，`pii.bank.reveal`）；`purchase_policy` 为 `{ rules: [...] }`；`controls` 为 `{ adminCreateOrder, wechatSingleLimitFen, wechatDailyLimitFen, receiptSecondReviewFen, shippingReport }` | `finance_config_revision.payload`、`finance_config_revision.account_no_mask`（08-billing-payment.md:1491-1497） |
| `changeNote` | string | 是 | 变更说明 | `finance_config_revision.change_note` |
| `effectiveAt` | string(date-time) \| null | 是 | 生效时间；未批准为 null | `finance_config_revision.effective_at` |
| `state` | enum(`FinanceConfigState`) | 是 | `pending` 待批准 / `scheduled` 已批准待生效（收款账户批准后 24 小时）/ `effective` 当前生效 / `superseded` 已被取代 / `rejected` / `withdrawn` | 审批单状态与 `effective_at` 现算 |
| `createdAt` | string(date-time) | 是 | 提议时刻 | `finance_config_revision.created_at` |
| `approval` | `ApprovalInfo` | 是 | 提议人、批准人与结论 | `finance_config_revision.approval_request_id` |
| `actions` | array<string> | 是 | `approve`、`reject`、`withdraw` | 计算 |

### 2.19 给 a02 的计数函数与导出参数

工作台卡片、菜单角标与本文队列的 `summary` 共用同一个带范围的查询构造函数（“工作台上的数 = 点进去看到的数”，a02 第 2.3 节）。本文登记下列计数函数：

| a02 来源键 | 本文接口里的同一计数 | 条件 |
| --- | --- | --- |
| ② `receipt_confirm` | `admin.transferProof.summary` 的 `pending`、`pendingAmountFen` | `transfer_proof.review_status = pending`（含二人复核中的） |
| ⑦ `plan_expiring` | `admin.subscriptionTerm.summary` 的 `expiring` | 3.30 `expiring` 页签口径 |
| 今日数据 `active_plans` | `admin.plan.summary` 的 `activeEntityCount`；副指标取 `admin.subscriptionTerm.summary` 的 `expiring`、`expired` | 3.2、3.30 口径 |
| ⑩ `refund_approval`（现金部分） | `admin.refundRequest.summary` 的 `tabs.pending_approval + tabs.pending_execution`；副指标现金合计同口径求和 `refund_request.amount_fen` | 3.56 口径（`pending_execution` 页签含 `executing`） |
| ⑬ `points_adjust_approval`、⑭ `term_extend_approval` | a01 `admin.approval.summary`（`kind = points_adjust` / `subscription_extend`）同一函数；本文不另给 | `approval_request.status = pending` |
| ⑯ `invoice_issue` | `admin.invoiceRequest.summary` 的 `pending + red_pending`、对应金额 | `invoice_request.status` ∈ (`pending`, `red_pending`) |
| ⑰ `recon_diff` | `admin.paymentException.list` 的 `tab = open` 计数；`ReconMonth.overview.diff.openCount`（当月）；`admin.paymentTransaction.summary` 的 `openDiff` | `payment_exception.status = open`（已转退款的 `resolving` 计入 ⑩） |
| 月报 `newCount`、`renewCount` | `admin.plan.summary` / `PlanAdminColumn` 的 `newThisMonthCount`、`renewedThisMonthCount` | a02 的指标函数（2.3） |

导出（a02 `admin.exportJob.create`）的 `params`：`payment_orders.list`、`payment_transactions.list`、`point_accounts.list`、`subscription_terms.list` 与对应列表（3.40、3.52、3.20、3.30）的查询参数同构，去掉 `page`、`pageSize`（C46），schema 即 `AdminPaymentOrderListQuery`、`PaymentTransactionListQuery`、`PointAccountListQuery`、`SubscriptionTermListQuery`；`reconciliations.detail` 的 `ReconExportParams`（`granularity`、`month`、`date`、`contents`）与 Sheet（付款单明细、收款明细、退款明细、对账差异）按 a02 第 2.14 节，本文确认，各 Sheet 的行来源为 `billing_order`、`payment_txn`、`refund_txn`、`payment_exception`（按账单日落日，同 2.0 的时间规则）。计费月结（`billing_month_close`，M10）V1.0 不建，历史月按 A106 现算；建表后本文再补月结结果的读取函数与月结事件（届时先在 x01 登记事件名）。

## 3. 接口

各接口的“限流与开关”一律是 `admin.global`、无功能开关，下文不再逐条写；“错误”一栏只列领域码与有特殊含义的通用码（C28），`VALIDATION_FAILED`（400）、`PERMISSION_DENIED`（403）、`NOT_FOUND`（404）、`IDEMPOTENCY_KEY_REQUIRED`（400）、`BUSY`（503）按约定不重复。

### 3.1 admin.plan.list　套餐版本与权益矩阵
`GET /admin/plans`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.plan.list`（路线图 `a07.plans.list`） |
| 鉴权 | `staff`；模块 `billing` ≥ v；数据范围 `global` |
| 回显 | 无 |
| 幂等 | none（纯查询，A18） |
| 乐观锁 | 无 |
| 对应画板 | A:Plans（版本与权益矩阵、列头状态与“编辑”、可选周期）；A:Renewals（续费试算的版本下拉） |

**请求**：查询参数 `includeDelisted`（boolean，默认 `true`；A:Renewals 的试算下拉传 `false`）。没有分页：套餐版本是个位数，一次返回全部（A78 的有界小集合，C43 已登记）。

**响应**：`{ items: PlanAdminColumn[], enabledCycles: { current: integer[], pending: { billingParamId, value: integer[], effectiveAt } | null } }`（`enabledCycles` 是页面需要的并列上下文，C43 允许）。`items` 按 `rank` 升序；`enabledCycles` 取参数 `enabledCycles` 的当前与待生效值（`billing_param`，`key = enabledCycles`），“购买周期”开关据此渲染，保存走 `admin.pricingChange.create`（A28；07-billing-ledger.md:574 的口径）。

**错误**：无。

**副作用**：无（GET 不写库，A19）。

**说明**：“购买周期与计费规则”下的文案（应付金额、积分发放、升级、降级、退款、到期规则）是前端静态文案，不由接口下发；其中的数字（窗口小时数、可选周期）取 `admin.billingParam.list`。

### 3.2 admin.plan.summary　套餐页 KPI
`GET /admin/plans/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.plan.summary` |
| 鉴权 | `staff`；模块 `billing` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Plans 页头 4 张 KPI 卡 |

**请求**：无。

**响应**：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `activeEntityCount` | integer | 是 | 套餐生效家数 | `subscription_term`（`status = active`、`ends_at > now`）的主体数；与 a02 今日数据 `active_plans` 同一计数函数 |
| `mrrFen` | string(bigint) | 是 | 月度经常性收入 | 生效周期 `subscription_term.monthly_equiv_fen` 之和（实时口径；月末快照见 a02 `admin.report.overview.get`） |
| `newThisMonthCount` | integer | 是 | 本月新开通 | 与 a02 `newCount` 同一指标函数：`subscription_event`（`type = activated`、所属周期 `origin = new`、`biz_date` 在本月）按主体去重 |
| `renewedThisMonthCount` | integer | 是 | 本月续费 | 与 a02 `renewCount` 同一指标函数：`subscription_event`（`type = renewal_scheduled`，或 `type = activated` 且所属周期 `origin = resume`）、`biz_date` 在本月，按主体去重；延长复活的 `resumed` 不计入 |
| `asOf` | string(date-time) | 是 | 计算时刻 | 计算 |

**错误**：无。**副作用**：无。

**说明**：页面没有页签，本接口是页面 KPI，不是页签计数；按 C83 仍用 `summary` 段。缓存 60 秒（与 a02 报表同规则）。

### 3.3 admin.plan.create　新建套餐版本
`POST /admin/plans`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.plan.create`（路线图 `a07.plans.create`） |
| 鉴权 | `staff`；`billing.plan.edit`；数据范围 `global` |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 无（新建） |
| 对应画板 | A:Plans（原型没有“新增版本”入口，proto-admin-c.md:159；PRD:765 要求） |

**请求体**：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `code` | string | 是 | `^[a-z][a-z0-9_]{1,23}$`，全局唯一，创建后不改 | → `plan.code` |
| `name` | string | 是 | 1–20 字 | → `plan.name` |
| `rank` | integer | 是 | 1–99，全局唯一；越大越高级 | → `plan.rank` |

**响应**：`PlanAdminColumn`（`isListed = false`、`current = null`、`columnStatus = draft`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PLAN_CODE_TAKEN` | 409 | 版本码已存在（`uq_plan_code`） |
| `PLAN_RANK_TAKEN` | 409 | rank 已被占用（`uq_plan_rank`） |

**副作用**：插入 `plan`（`scope = public`、`is_listed = false`）；审计 `billing.plan.create`（`category = plan_config`）。无状态迁移、无出站事件、无定时器。

**说明**：新版本先用 3.6 建首个价目修订（首个修订豁免公告，可立即生效），再上架（3.4）。`plan.scope = entity`（大客户专属）V1.0 只声明不写入，请求不接受该字段。

### 3.4 admin.plan.shelve　套餐上架
`POST /admin/plans/{planId}/shelve`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.plan.shelve`（路线图 `a07.plans.list-on-shelf`；A9 上架用 `shelve`） |
| 鉴权 | `staff`；`billing.plan.edit` |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 不带：`plan` 没有状态机表，上下架按“行锁 + `is_listed` 当前值”守卫（A21），`plan.lock_version` 递增 |
| 对应画板 | A:Plans（原型无上下架入口，PRD:765） |

**请求**：路径 `planId`（uuid）。请求体无。

**响应**：`PlanAdminColumn`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 已上架 |
| `PLAN_REVISION_MISSING` | 409 | 没有已生效的价目修订，或当前价目缺少启用周期（参数 `enabledCycles`）的价格；`details.missingCycles` |

**副作用**：`plan.is_listed`: `false → true`，`plan.lock_version + 1`；审计 `billing.plan.shelve`（`category = plan_config`）。无出站事件（商家端报价与列表按时读取）。

**说明**：上架后可新购与续费；商家端 `m.plan.list` 只列上架且有生效价目的版本。

### 3.5 admin.plan.delist　套餐下架
`POST /admin/plans/{planId}/delist`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.plan.delist` |
| 鉴权 | `staff`；`billing.plan.edit` |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 不带（同 3.4） |
| 对应画板 | A:Plans |

**请求**：路径 `planId`。请求体无。

**响应**：`PlanAdminColumn`。

**错误**：`STATE_NOT_ALLOWED`（409，已下架）。

**副作用**：`plan.is_listed`: `true → false`，`plan.lock_version + 1`；审计 `billing.plan.delist`（`category = plan_config`）。

**说明**：下架后不可新购与续费（报价返回 m07 的 `PLAN_NOT_AVAILABLE`），已有周期与已创建未支付的付款单不受影响（快照履约，07-billing-ledger.md:100）。下架最后一个上架版本不拦，界面二次确认。

### 3.6 admin.plan.planRevision.create　编辑版本（新建价目修订）
`POST /admin/plans/{planId}/plan-revisions`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.plan.planRevision.create`（路线图 `a07.plan-revisions.create`；A5 嵌套集合沿用 `plan-revisions`） |
| 鉴权 | `staff`；`billing.plan.edit` |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 不带：修订行只增，并发由 `plan` 行 `FOR UPDATE` 串行化（07-billing-ledger.md:91） |
| 对应画板 | A:Plans 编辑弹窗（“提交并排期公告”） |

**请求**：路径 `planId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `monthlyFeeFen` | integer(分) | 是 | > 0 | → `plan_revision.monthly_fee_fen` |
| `monthlyPoints` | integer(积分) | 是 | > 0 | → `plan_revision.monthly_points` |
| `discountBp` | integer | 是 | 5000–10000，100 的整数倍（原型 5–10 折、最多 1 位小数） | → `plan_revision.discount_bp` |
| `maxStores` | integer | 是 | ≥ 1 | → `plan_revision.max_stores` |
| `maxMembers` | integer \| null | 是 | null = 不限（原型输入 0），否则 ≥ 1 | → `plan_revision.max_members` |
| `productionModel` | enum | 是 | 同数据模型 `plan_revision.production_model` | → 同名列 |
| `schedulePriority` | enum | 是 | 同数据模型 `plan_revision.schedule_priority` | → 同名列 |
| `hasMonthlyReport` | boolean | 是 | | → `plan_revision.has_monthly_report` |
| `cyclePrices` | array<object> | 否 | `[{ months, priceFen }]`，`months` 不重复；缺省 = 月费 × 月数；须覆盖参数 `enabledCycles` 当前值与待生效值里的每个周期 | 转成以月数为键的对象 `{ "<months>": priceFen }` → `plan_revision.cycle_prices`（季付、年付优惠只改这里；2.3） |
| `effectiveDate` | string(date) \| null | 是 | 当日 00:00（北京时间）生效；非首个修订须 ≥ 今天 + `noticeDays`（默认 30）；null 只允许用于该套餐的首个修订（立即生效） | → `plan_revision.effective_at`（编辑弹窗的生效日期） |
| `firstCyclePromo` | boolean | 是 | | true → `plan_revision.legacy_promo = { type: previous_revision }` |
| `notice` | object \| null | 否 | `{ title?: 1–40 字, summary?: 1–200 字, summaryNoPrice?: 1–200 字（不含价格数字）, isBarEnabled?: boolean }`；首个修订传了也忽略 | 覆盖服务端生成的公告文案（见说明）→ `site_notice.title`、`summary`、`summary_no_price`、`bar_enabled`（字段名同 a09 `SiteNoticeItem.isBarEnabled`，C39） |

**响应**：`PlanRevisionView`（新行，`status = pending`，首个修订立即生效时为 `effective`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `REVISION_PENDING_EXISTS` | 409 | 该套餐已有待生效且未撤销的修订（billing.I15）；`details` 带那条修订 |
| `NOTICE_PERIOD_REQUIRED` | 400 | 生效日早于今天 + `noticeDays`；`details.earliestEffectiveDate` |
| `PLAN_TIER_ORDER_INVALID` | 409 | 与相邻 rank 的版本在该生效时刻的价目比较，rank 越高各周期总价与每月积分没有越高（d1:970）；`details` 带冲突的版本与字段 |
| `CHANGESET_EMPTY` | 400 | 与当前价目完全相同（原型“无变化不能提交”） |

**副作用**（一个事务，07-billing-ledger.md:175-180）：

- 先生成修订 id，调 `notices.announce`（`kind = plan_revision`，`ref_id` = 修订 id，`effective_at` 同修订）：`site_notice`：（新建）→ `announced`（14-config-data.md:528），出站事件 `site_notice.announced`（通知模块给全部状态正常主体的老板发站内消息，首页公告条）。首个修订不公告。
- 插入 `plan_revision`（`revision_no` 递增，`site_notice_id`、`announced_at` 插入时写好，`created_by_staff_id` = 本人）。
- 生效时间晚于当前时刻时发 `billing.plan_revision_scheduled`。
- 审计 `billing.plan_revision.create`（`category = plan_config`，`after` 为全部字段）。
- 不登记定时器：价目按时间取值，到点不需要任务切换（07-billing-ledger.md:1580）。

**说明**：

- 公告文案由服务端按本次与当前价目的差异生成（原型“保存后生成调整公告”，Plans.dc.html:77、188；编辑弹窗没有公告标题与摘要的输入）：`title` =“〈版本名〉价格与权益调整”；`summary` 逐项列出变化（“月费 ¥6,000 → ¥6,600；每月积分 3,000 → 3,300；11-01 起对新开通与续费生效”）；`summaryNoPrice` 只列不含价格数字的变化与生效日（给购买入口受限的主体，13-notify-docs.md:311）；`isBarEnabled` 默认 true。请求的 `notice` 只覆盖传了的字段。这样 a09 的 `notices.announce` 要求的 `title`、`summary`、`summary_no_price` 总是齐全。
- 生效前的付款单按创建时的快照履约；生效后的报价自动取新价目。`firstCyclePromo` 的效果是“调价生效后的第一次开通或续费按上一版价目计一个周期”（d1:1045-1055），优惠幅度待业务确认（07-billing-ledger.md:1634）。

### 3.7 admin.planRevision.list　调整与公告记录
`GET /admin/plan-revisions`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.planRevision.list` |
| 鉴权 | `staff`；模块 `billing` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Plans“调整与公告记录” |

**请求**：查询参数 `planId`（uuid，可选）、`status`（`PlanRevisionStatus`，可多值）、`page`、`pageSize`（C43）。排序固定 `-createdAt`。

**响应**：`AdminPage<PlanRevisionListItem>`（a01 2.1）；`PlanRevisionListItem` = `PlanRevisionView` 加 `plan: { planId, name }`。

**错误**：无。**副作用**：无。

### 3.8 admin.planRevision.withdraw　生效前撤销价目修订
`POST /admin/plan-revisions/{planRevisionId}/withdraw`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.planRevision.withdraw`（草案 `DELETE …/revisions/{id}`；撤销只写 `cancelled_at`，A7 改 POST，A9 用 `withdraw`） |
| 鉴权 | `staff`；`billing.plan.edit` |
| 回显 | 要求 `confirm`：`{ planRevisionId, effectiveAt }` |
| 幂等 | required |
| 乐观锁 | 不带（修订行只允许写一次 `cancelled_at`，由触发器保证） |
| 对应画板 | A:Plans（原型未画） |

**请求**：路径 `planRevisionId`。请求体：`note`（string，0–200 字，写审计）、`confirm`。

**响应**：`PlanRevisionView`（`status = cancelled`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `REVISION_ALREADY_EFFECTIVE` | 409 | 已生效或已撤销（`ck_plan_revision_cancel_before_effective`） |
| `CONFIRM_MISMATCH` | 409 | 回显的生效时间与库中不一致 |

**副作用**：`plan_revision.cancelled_at` 写入；同事务 `notices.withdraw`：`site_notice`：`announced → withdrawn`（14-config-data.md:529），出站事件 `site_notice.withdrawn`（发“调整已取消”的站内消息，公告条消失）；审计 `billing.plan_revision.withdraw`（`category = plan_config`）。无定时器要取消。

**说明**：要改内容只能撤销后重建，重建重新校验公告期（d1:1045）。

### 3.9 admin.plan.quote　升级补差与续费试算
`POST /admin/plans/quote`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.plan.quote`（路线图 `a07.quotes.upgrade` 与 `a07.quotes.renewal` 合一，A20、C13） |
| 鉴权 | `staff`；`permission: assert-in-handler`：模块 `billing` 或 `order` 任一 ≥ v（2.0 模块等级），都不满足 403 `PERMISSION_DENIED`；带 `pointAccountId` 时另按数据范围（范围外 404） |
| 回显 | 无 |
| 幂等 | none（试算，A18、A20），不写库、不缓存 |
| 乐观锁 | 无 |
| 对应画板 | A:Plans“升级补差试算”；A:Renewals 详情“续费试算” |

**请求体**：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `kind` | enum | 是 | `upgrade` / `renewal` | |
| `planId` | string(uuid) | 是 | | 目标版本 |
| `pointAccountId` | string(uuid) | 否 | | 带上时按该主体的真实周期报价（与商家端 `m.plan.quote` 同一实现 `billing.quotePlanPurchase`，d1:849-864）；不带时为通用试算 |
| `months` | integer | `renewal` 必填 | 参数 `enabledCycles` 之一 | 续费周期 |
| `intent` | enum | 否 | `upgrade_now` / `renew_next_term`（同 m07） | 带 `pointAccountId` 时有效 |
| `fromPlanId` | string(uuid) | 通用 `upgrade` 必填 | rank 低于目标 | 当前版本（A:Plans 的下拉） |
| `remainingDays` | integer | 通用 `upgrade` 必填 | 1–30 | 本月剩余天数（A:Plans 的输入） |

**响应**：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `scope` | enum | 是 | `entity`（带主体）/ `generic` | 请求 |
| `quote` | object \| null | 是 | `scope = entity` 时为 m07 的 `PlanQuote`（动作、应付、算式、新周期、每月积分、升降级说明） | `billing.quotePlanPurchase` |
| `generic` | object \| null | 是 | `scope = generic` 时：升级 `{ feeDeltaPerMonthFen, monthlyDeltaPoints, remainingDays, baseDays, proratedFen, topupPoints, formulaText }`（补差 = 差价 × 天数 ÷ `prorationBaseDays`，积分同理；字段名与 m07 `PlanQuote.upgrade` 一致，付款单快照里的键名 `pointsDeltaPerMonth` 按 C32 改名）；续费 `{ cyclePriceFen, monthlyPoints, months, formulaText }` | 两个版本的当前价目（`plan_revision`）与参数 `prorationBaseDays` |

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PLAN_NOT_AVAILABLE` | 409 | 目标版本未上架或没有生效价目（m07） |
| `CYCLE_NOT_AVAILABLE` | 400 | 周期未启用（m07） |
| `UPGRADE_NOT_ALLOWED_TODAY` | 409 | 带主体时今天不能立即升级（m07；`details.suggest`） |
| `SCHEDULED_TERM_LIMIT` | 409 | 带主体时预约周期已达上限（m07） |
| `PLAN_REFUND_IN_PROGRESS` | 409 | 带主体时该主体套餐退款处理中（m07） |

**副作用**：无。

**说明**：通用升级试算只能升到更高 rank（原型 `Plans.txt:113-117`）；结果只是试算，不生成付款单。后台代客下单用 3.43。

### 3.10 admin.pointPack.list　积分包列表
`GET /admin/point-packs`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointPack.list` |
| 鉴权 | `staff`；模块 `billing` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:PointPacks 积分包表（含合计行，由前端求和） |

**请求**：查询参数 `isListed`（boolean，可选）。不分页（积分包是个位数，A78 的有界小集合，C43 已登记）。排序：`position`、`points`。

**响应**：`{ items: PointPackRow[] }`。

**错误**：无。**副作用**：无。

### 3.11 admin.pointPack.summary　积分包 KPI 与近 6 个月加购
`GET /admin/point-packs/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointPack.summary`（合并原型推断的 `/summary` 与 `/monthly-stats`） |
| 鉴权 | `staff`；模块 `billing` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:PointPacks 页头 KPI 与柱状图 |

**请求**：无。

**响应**：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `month` | string | 是 | 本月 `YYYY-MM` | 计算 |
| `topupCount` | integer | 是 | 本月加购笔数 | `billing_order`（`type = topup`、`status` ∈ (`paid`, `refunded`)、`paid_at` 在本月）计数 |
| `topupFen` | string(bigint) | 是 | 本月加购金额 | 同上 `billing_order.paid_amount_fen` 之和 |
| `topupEntityCount` | integer | 是 | 加购商家数 | 同上按 `billing_order.entity_id` 去重 |
| `topupRateBp` | integer \| null | 是 | 加购率 = 加购主体数 ÷ 本月付费主体数（口径待业务确认，proto-admin-c.md:201） | 分母：本月有已支付付款单的主体数；为 0 时 null |
| `monthly` | array<object> | 是 | 近 6 个月（含本月）`{ month, points, isCurrent }`，单位“积分”（加购积分按“积分（＝元）”展示由前端处理） | `point_ledger_entry`（`from_bucket = external`、`to_bucket = available`、批次 `point_lot.source_type = purchase`）按 `biz_date` 所在月求和 |

**错误**：无。**副作用**：无。

### 3.12 admin.pointPack.create　新增积分包
`POST /admin/point-packs`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointPack.create` |
| 鉴权 | `staff`；`billing.pack.edit` |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 无（新建） |
| 对应画板 | A:PointPacks 新增弹窗 |

**请求体**：`points`（integer，≥ 100）、`priceFen`（integer，> 0；后台输入元，最多 2 位小数，前端换算成分）、`position`（integer，可选，默认排在最后）。

**响应**：`PointPackRow`（`isListed = true`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `POINT_PACK_DUPLICATE` | 409 | 上架中已有相同积分数（`uq_point_pack_points_listed`） |

**副作用**：插入 `point_pack`（`is_listed = true`，新增即上架，商家端立即展示）；审计 `billing.point_pack.create`（`category = plan_config`）。

### 3.13 admin.pointPack.update　编辑积分包
`PATCH /admin/point-packs/{pointPackId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointPack.update`（d1 的 PATCH 没写 id，补上） |
| 鉴权 | `staff`；`billing.pack.edit` |
| 回显 | 无 |
| 幂等 | required（带 `lockVersion` 的 PATCH，A17） |
| 乐观锁 | 带 `lockVersion`（内容编辑，A21） |
| 对应画板 | A:PointPacks 编辑弹窗 |

**请求**：路径 `pointPackId`。请求体：`lockVersion`（integer，必填）；`points`、`priceFen`、`position`（可选，不传不改，C38）。

**响应**：`PointPackRow`。

**错误**：`VERSION_CONFLICT`（409）；`POINT_PACK_DUPLICATE`（409，改后积分数与其他上架包重复）。

**副作用**：更新 `point_pack`，`lock_version + 1`；审计 `billing.point_pack.update`（`category = plan_config`，`before` / `after`）。

**说明**：保存后对之后的购买生效；已创建未支付的付款单按原价（付款单快照，d1:241）。

### 3.14 admin.pointPack.shelve　上架积分包
`POST /admin/point-packs/{pointPackId}/shelve`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointPack.shelve`（路线图 `a07.point-packs.list-on-shelf`，A9） |
| 鉴权 | `staff`；`billing.pack.edit` |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 不带（行锁 + `is_listed` 守卫） |
| 对应画板 | A:PointPacks 行内按钮 |

**请求**：路径 `pointPackId`。请求体无。

**响应**：`PointPackRow`。

**错误**：`STATE_NOT_ALLOWED`（409，已上架）；`POINT_PACK_DUPLICATE`（409）。

**副作用**：`point_pack.is_listed`: `false → true`；审计（`category = plan_config`）。

### 3.15 admin.pointPack.delist　下架积分包
`POST /admin/point-packs/{pointPackId}/delist`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointPack.delist` |
| 鉴权 | `staff`；`billing.pack.edit` |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 不带 |
| 对应画板 | A:PointPacks 行内按钮 |

**请求**：路径 `pointPackId`。请求体无。

**响应**：`PointPackRow`。

**错误**：`STATE_NOT_ALLOWED`（409，已下架）。

**副作用**：`point_pack.is_listed`: `true → false`；审计（`category = plan_config`）。已创建未支付的加购付款单照常可付（按快照履约）。

### 3.16 admin.billingParam.list　积分规则参数
`GET /admin/billing-params`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.billingParam.list` |
| 鉴权 | `staff`；模块 `billing` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无（参数按修订行追加，不用锁版本） |
| 对应画板 | A:Params（取消扣除比例、广告每条积分、免费修改次数、顶级模型加扣、最短可订授权期、提醒节点）；A:Plans（可选周期） |

**请求**：无。

**响应**：`{ items: BillingParamView[], noticeDays: integer, earliestNoticedEffectiveDate: string(date) }`。`items` 固定 12 行；`earliestNoticedEffectiveDate` = 今天 + 当前 `noticeDays`，需公告的键在表单上的最早可选日。

**错误**：无。**副作用**：无。

**说明**：

- 等级模板价（S / A / B / C 恰好 4 行当前值）与“适用剧目数、按模板定价剧目数”由 a04 的 `admin.priceTierRevision.list` 提供（A93：保存即生效，没有待生效行与页签；同次保存的 `batchId` 即本文变更集的 `changeSetId`，A94）。“评定依据”是前端静态文案，没有对应的列，不由接口下发。
- “下架提醒（使用期结束前）”是系统参数 `remind.offline.days`，不在本文的变更集里：读调 a01 `admin.paramValue.list`（`keys = remind.offline.days`），保存调 a01 `admin.paramValue.replace`（`items[].expectedRev` 取读到的 `latestRev`；该接口要求 `sys.param.edit`，默认仅超级管理员），与本页的“保存”分两次提交，见第 6 节第 2 项。

### 3.17 admin.pricingChange.list　模板价与参数的变更记录
`GET /admin/pricing-changes`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pricingChange.list`（A28；取代 `a07.billing-param-changes.list`） |
| 鉴权 | `staff`；模块 `billing` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Params“变更记录” |

**请求**：查询参数 `kind`（`price_tier` / `billing_param`，可选：只看含该类条目的变更集；A:Pricing 的“调价记录”时间线用 `kind = price_tier` 取模板价条目，与 a04 `admin.dramaPriceRevision.list` 合并显示）、`key`（`BillingParamKey`，可选）、`createdFrom` / `createdTo`（date）、`page`、`pageSize`。排序 `-createdAt`。

**响应**：`AdminPage<PricingChangeRecord>`（a01 2.1）。

**错误**：无。**副作用**：无。

### 3.18 admin.pricingChange.create　保存模板价与参数变更集
`POST /admin/pricing-changes`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pricingChange.create`（A28；取代 `a07.billing-params.save` 的 `PUT /admin/billing-params` 与 a04 `a04.price-tier-revisions.create` 两次调用） |
| 鉴权 | `staff`；`permission: assert-in-handler`（A45）：含 `tiers` 需 `billing.price.edit`，含 `params` 需 `billing.param.edit`，两者都有需两者都有；不足 403 `PERMISSION_DENIED` |
| 回显 | 无（变更集本身就是确认后的整页内容） |
| 幂等 | required |
| 乐观锁 | 不带 `lockVersion`：修订行只增；保存事务先取事务级咨询锁串行化（07-billing-ledger.md:345），“每个键至多一条待生效”由守卫保证 |
| 对应画板 | A:Params 整页“保存”；A:Plans 可选周期开关（`enabledCycles`） |

**请求体**：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `tiers` | object \| null | 否 | `{ S, A, B, C }`，各 100–20000 的整数，S ≥ A ≥ B ≥ C | 等级模板价；V1.0 保存即生效（A93，与原型一致；定时生效以后再做） → `price_tier_revision`（只为有变化的档插行，`effective_at` = 账本时钟当前时刻） |
| `params` | array<object> \| null | 否 | `[{ key, value, effectiveDate? }]`，同一个键至多出现一次 | → `billing_param` |
| `params[].key` | enum(`BillingParamKey`) | 是 | | |
| `params[].value` | any(JSON) | 是 | 按键的 schema 校验（2.5）；`cancelDeductionBp` 的前四档非空的随阶段不递减 | 完整值，不是增量 |
| `params[].effectiveDate` | string(date) \| null | 否 | 需公告的键：≥ 今天 + `noticeDays`，且同一变更集内需公告的键取同一天；**不传时取最早可选日**（今天 + `noticeDays`，即 `BillingParamList.earliestNoticedEffectiveDate`）。不需公告的键：不传或 null = 立即生效 | 当日 00:00（北京时间）→ `billing_param.effective_at` |
| `notice` | object \| null | 否 | `{ title?: 1–40 字, summary?: 1–200 字, summaryNoPrice?: 1–200 字, isBarEnabled?: boolean }`；不含需公告的键时忽略 | 覆盖服务端生成的公告文案（规则同 3.6：按变化的键与值、生效日生成）→ `site_notice` |
| `note` | string | 否 | 0–200 字 | → 含参数时写 `billing_param.note`；同时写本次审计的 `audit_log.meta.note`（只改模板价时变更记录从这里取，2.6） |

**响应**：`PricingChangeRecord`（本次的变更集）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `CHANGESET_EMPTY` | 400 | 所有条目都与当前值相同（服务端只为值有变化的键与档插行，d1:286） |
| `PARAM_PENDING_EXISTS` | 409 | 某个键已有待生效行；`details.items: [{ key, billingParamId, effectiveAt }]`（要改先撤销，3.19） |
| `NOTICE_PERIOD_REQUIRED` | 400 | 需公告的键生效日早于今天 + `noticeDays`；`details.earliestEffectiveDate`、`details.keys` |
| `VALIDATION_FAILED` | 400 | 值超出范围；模板价不满足 S ≥ A ≥ B ≥ C；扣除比例不单调；需公告的键生效日不一致；`enabledCycles` 为空，或某个上架版本的当前或待生效价目缺少新启用周期的价格（`fieldErrors` 指到 `params.N.value`） |

**副作用**（一个事务）：

- 应用生成变更集 id，同时用作 `billing_param.change_id` 与 `price_tier_revision.batch_id`（2.6）。
- 含需公告的键：先 `notices.announce`（`kind = billing_param`，`ref_id` = 变更集 id，`effective_at` = 该组生效时刻）：`site_notice`：（新建）→ `announced`，出站事件 `site_notice.announced`；再插需公告的各行，写好同一个 `site_notice_id`（07-billing-ledger.md:380-384）。
- 插入 `billing_param` 各行（`created_by_staff_id` = 本人）；生效时间晚于当前时刻的每行发 `billing.param_change_scheduled`（负载带 `changeId`）。
- 插入 `price_tier_revision` 各行；按模板定价、热度等级为变化档的剧，价格随即变化，逐部发 `pricing.drama_price_changed`（聚合取 `drama`，`cause = tier_template`；07-billing-ledger.md:1600）。x01 §3.7 与现契约已登记 `tier_template` 及本接口发出方，沿该正式口径发出，不新增事件名。
- 审计：每个参数键一条（`category = param`、`target_type = billing_param`、`target_key` = 键），模板价一条（`category = price_adjust`、`target_type = price_tier_revision`），`before` / `after` 记旧值与新值，`meta` 带 `changeSetId` 与 `note`。
- 无状态迁移（修订行不是状态机），无定时器（参数按时间取值）。

**说明**：

- 已冻结或已扣减的积分按冻结时的快照处理，参数变化只影响之后的订购与广告（07-billing-ledger.md:1469-1493）。
- 原型是“保存即生效、无生效时间”（proto-admin-c.md:245），本接口按 d1 落为“需公告的键必须预约在公告期之后”：A:Params 没有生效日输入、A:Plans 的可选周期开关点了即生效（Plans.dc.html:134），所以 `effectiveDate` 与 `notice` 都可以不传，由服务端取最早可选日并生成公告；页面要在保存前提示“将于 X 起生效，并发布调整公告”（第 6 节第 3 项）。提醒节点、最短可订授权期、最多预约周期数等不需公告的键可立即生效。`enabledCycles` 是需公告的键（07-billing-ledger.md:1452），可选周期开关同样按此预约并公告。
- “恢复默认值”由前端用 `BillingParamView.defaultValue` 回填表单，仍经本接口保存。

### 3.19 admin.billingParam.withdraw　撤销一条待生效参数
`POST /admin/billing-params/{billingParamId}/withdraw`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.billingParam.withdraw`（d1 `DELETE …/params/pending/{id}`；A7 改 POST） |
| 鉴权 | `staff`；`billing.param.edit` |
| 回显 | 要求 `confirm`：`{ key, effectiveAt }` |
| 幂等 | required |
| 乐观锁 | 不带（只允许写一次 `cancelled_at`，触发器保证） |
| 对应画板 | A:Params（原型未画；在“待生效”标签旁给“撤销”） |

**请求**：路径 `billingParamId`。请求体：`note`（0–200 字）、`confirm`。

**响应**：`BillingParamView`（该键）。

**错误**：`REVISION_ALREADY_EFFECTIVE`（409，已生效或已撤销）；`CONFIRM_MISMATCH`（409）。

**副作用**：`billing_param.cancelled_at` 写入；若该变更集里需公告的键已全部撤销，同事务 `notices.withdraw`：`site_notice`：`announced → withdrawn`，出站事件 `site_notice.withdrawn`；只撤销一部分时公告保留（07-billing-ledger.md:384）；审计（`category = param`）。

### 3.20 admin.pointAccount.list　积分账户列表
`GET /admin/point-accounts`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointAccount.list` |
| 鉴权 | `staff`；模块 `billing` ≥ v；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:PointAccounts 账户表（左） |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `q` | string | 否 | 主体名或门店名，模糊匹配 |
| `planId` | string(uuid) | 否 | 当前周期的版本 |
| `subStatus` | enum | 否 | `none` / `active` / `expired`（“已过期”筛选） |
| `flag` | enum | 否 | `has_held` 有冻结积分 / `expiring_7d` 7 天内清零 / `refund_pending` 退款处理中（主体级，同 `PointAccountRow.isRefundPending`） |
| `page`、`pageSize` | integer | 否 | C43；原型每页 10 个 |
| `sort` | string | 否 | `-spendablePoints`、`planPointsExpireAt`、`-updatedAt`（默认） |

**响应**：`AdminPage<PointAccountRow>`（a01 2.1）。

**错误**：无。**副作用**：无。

**说明**：导出走 a02 `admin.exportJob.create`（`exportKey = point_accounts.list`，`params` 与本接口查询参数同构，C46）。`subStatus` 筛选按周期起止现算，不读 `billing_account.sub_status` 缓存（07-billing-ledger.md:403）；缓存列只用于索引预筛。

### 3.21 admin.pointAccount.summary　积分账户 KPI
`GET /admin/point-accounts/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointAccount.summary` |
| 鉴权 | `staff`；模块 `billing` ≥ v；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:PointAccounts 页头 KPI 与分页条“共 213 个积分账户 · 套餐生效 186 个” |

**请求**：查询参数与 3.20 相同（除分页、排序外，C83）。

**响应**：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `accountCount` | integer | 是 | 积分账户数 | 符合筛选的 `billing_account` 计数 |
| `activeAccountCount` | integer | 是 | 其中套餐生效 | 现算 |
| `balancePoints` | integer(积分) | 是 | 积分余额（含冻结、含停用的加购） | `billing_account.plan_available_qty` + `addon_available_qty` + `held_total_qty` 之和 |
| `heldPoints` | integer(积分) | 是 | 其中冻结 | `billing_account.held_total_qty` 之和 |
| `grantedThisMonthPoints` | integer(积分) | 是 | 本月发放（月度发放 + 升级补发） | `point_ledger_entry`（`from_bucket = external`、`to_bucket = available`、批次 `point_lot.source_type` ∈ (`grant_monthly`, `grant_upgrade`)、`biz_date` 在本月）之和；与 a02 `admin.report.points.get` 的 `grantedPoints` 同口径 |
| `consumedThisMonthPoints` | integer(积分) | 是 | 本月消耗 | `point_ledger_entry`（`held → consumed`、`biz_date` 在本月）之和；同 a02 `consumedPoints` |

**错误**：无。**副作用**：无。

### 3.22 admin.pointAccount.get　积分账户详情
`GET /admin/point-accounts/{pointAccountId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointAccount.get`（A4：`{entityId}` 改 `{pointAccountId}`，取值等于主体 id） |
| 鉴权 | `staff`；模块 `billing` ≥ v；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:PointAccounts 详情（右）；A:MerchantDetail“套餐与积分”页签与 KPI“可用积分 2,920（套餐 1,920 · 加购 1,000，或调整审批中：＋270 套餐积分）” |

**请求**：路径 `pointAccountId`。

**响应**：`PointAccountDetail`。

**错误**：无（不存在或范围外 404）。**副作用**：无。

### 3.23 admin.pointAccount.pointLedgerEntry.list　积分流水
`GET /admin/point-accounts/{pointAccountId}/point-ledger-entries`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointAccount.pointLedgerEntry.list`（d1 `/accounts/{entityId}/ledger`；A5 嵌套集合沿用 `point-ledger-entries`） |
| 鉴权 | `staff`；模块 `billing` ≥ v；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:PointAccounts 流水表与分段按钮；A:MerchantDetail“套餐与积分”页签的积分流水 |

**请求**：路径 `pointAccountId`。查询参数：`tab`（`all` 全部 / `gain` 获得 / `use` 使用 / `expire` 清零，默认 `all`，原 `group=`，C45）、`lotKind`（可选）、`storeId`（可选，门店级操作）、`occurredFrom` / `occurredTo`（date，可选）、`cursor`、`limit`（默认 20，上限 100）。排序固定时间倒序（`ledger_operation.occurred_at` 降序，同刻按 `seq`）。

**响应**：`AdminCursorPage<AdminLedgerRow>`（a01 2.1）：游标分页并返回封顶 10,000 的近似总数（A22；`point_ledger_entry`、`ledger_operation` 是只增表，C43 的归类）。

**错误**：无。**副作用**：无。

**说明**：页签与类型的映射见第 4.2 节（d1:1406-1421）：获得 = 发放、加购、退回、增加类调整；使用 = 冻结、扣减、扣减类调整；清零 = 期末清零、套餐退款作废；停用与恢复只在“全部”里出现。

### 3.24 admin.pointAccount.adjustmentQuote　调整影响预览
`POST /admin/point-accounts/{pointAccountId}/adjustment-quote`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointAccount.adjustmentQuote`（d1 `POST /billing/adjustments/preview`；A20） |
| 鉴权 | `staff`；`billing.adjust.request`；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（试算） |
| 乐观锁 | 无 |
| 对应画板 | A:PointAccounts 与 A:MerchantDetail 手动调整弹窗的“可用 a → b” |

**请求**：路径 `pointAccountId`。请求体：`direction`（`increase` / `decrease`）、`lotKind`（`plan` / `addon`）、`adjustPoints`（integer > 0）、`reasonCode`（同数据模型 `point_adjustment_request.reason_code`）、`pointHoldId`（`platform_refund` 必填）。

**响应**：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `spendableBeforePoints` | integer(积分) | 是 | 此刻可用 | 同 `PointAccountRow.spendablePoints` |
| `spendableAfterPoints` | integer(积分) | 是 | 调整后可用 | 计算 |
| `lotAvailableBefore`、`lotAvailableAfter` | integer(积分) | 是 | 所选类型的可用（扣减不得小于 0） | `billing_account.plan_available_qty` / `addon_available_qty` |
| `planPointsExpireAt` | string(date-time) \| null | 是 | 增加套餐积分时并入本期、随本期清零的时刻 | 当前周期 `subscription_term.ends_at` |
| `pointHold` | object \| null | 是 | `platform_refund`：`{ pointHoldId, groupRef, qty, returnablePoints, status }` | `point_hold.qty` − `returned_qty` − `forfeited_qty` |
| `isAllowed` | boolean | 是 | 是否可提交 | 计算 |
| `blockReasons` | array<string> | 是 | `account_inactive`（套餐已过期，续费后再处理）、`insufficient`、`hold_invalid`、`pending_exists`（已有在审调整） | 计算（d1:1385-1403；proto-admin-c.md:327） |

**错误**：无（不可提交的原因放在 `blockReasons`）。**副作用**：无。

### 3.25 admin.pointAdjustmentRequest.create　发起积分调整
`POST /admin/point-adjustment-requests`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointAdjustmentRequest.create`（路线图 `a07.point-adjustments.create`；A14 资源名按表） |
| 鉴权 | `staff`；`billing.adjust.request`（客服、交付经理）；对象主体在数据范围内 |
| 回显 | 要求 `confirm`：`{ spendableBeforePoints }`（操作人在预览里看到的“可用 a”），与此刻可用不一致 409 `CONFIRM_MISMATCH` |
| 幂等 | required；`Idempotency-Key` 同时写入 `approval_request.idempotency_key` |
| 乐观锁 | 无（新建） |
| 对应画板 | A:PointAccounts、A:MerchantDetail 手动调整弹窗（“提交财务审批”） |

**请求体**：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `pointAccountId` | string(uuid) | 是 | | 主体 → `point_adjustment_request.entity_id` |
| `storeId` | string(uuid) | 否 | 属于该主体 | 从商家详情发起时的门店上下文 → `approval_request.store_id` |
| `direction` | enum | 是 | `increase` / `decrease` | → `point_adjustment_request.direction` |
| `lotKind` | enum | 是 | `plan` / `addon` | → `point_adjustment_request.lot_kind` |
| `adjustPoints` | integer(积分) | 是 | > 0 | → `point_adjustment_request.adjust_points` |
| `reasonCode` | enum | 是 | 同数据模型 `point_adjustment_request.reason_code`；`platform_refund` 只能是增加 | → `point_adjustment_request.reason_code` |
| `note` | string | 是 | 5–200 字（商家在积分明细里可见） | → `point_adjustment_request.note` |
| `pointHoldId` | string(uuid) | `platform_refund` 必填 | 属于该主体，状态为 `captured` / `refunded_partial` | → `point_adjustment_request.point_hold_id`；其余原因选填（展示关联的订购或广告） |
| `termExtensionRequestId` | string(uuid) | 否 | 只能是增加；该延长单已通过 | → `point_adjustment_request.term_extension_request_id` |
| `serviceTicketId` | string(uuid) | 否 | 同主体的客服工单 | 调整依据之一；写 `service_ticket_ref`（`ref_type = approval_request`、`ref_id` = 审批单，12 分组；07-billing-ledger.md:1189），与 3.55 相同 |
| `confirm` | object | 是 | 见上 | |

**响应**：`PointAdjustmentRequestDetail`（审批单 `pending`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `APPROVAL_ALREADY_PENDING` | 409 | 该主体已有在审的积分调整（`dedupe_key = points_adjust:{entityId}`，`uq_approval_request_dedupe_key_pending`；a03 定义）；`details` 带在审单号 |
| `ADJUST_ACCOUNT_INACTIVE` | 409 | 套餐未生效的账户不能调整（`platform_refund` 除外，d1:1394） |
| `ADJUST_EXCEEDS_AVAILABLE` | 409 | 扣减数量超过该类型此刻的可用；`details.availablePoints` |
| `ADJUST_HOLD_INVALID` | 409 | 冻结单不属于该主体、尚未扣减（应走取消流程）或已无可退；`details.holdStatus`、`details.returnablePoints` |
| `CONFIRM_MISMATCH` | 409 | 预览后可用积分已变化，请刷新预览 |

**副作用**（一个事务）：

- `approval_request.status`：（新建）→ `pending`（`submit`，03-staff-authz-audit.md:804）：`kind = points_adjust`、`category = approval`、`subject_type = billing_account`、`subject_id` = 主体 id、`entity_id`、`store_id`（可空）、`request_no = TZ…`、`dedupe_key = points_adjust:{entityId}`、`round_no = 1`、`submit_actor_type = staff`、`submit_client = admin`、`requester_staff_id`、`requester_staff_group_id`（快照）；`summary_snapshot` 由 billing 注册的处理器生成（07-billing-ledger.md:1571-1576）。
- 插入 `point_adjustment_request`（`spendable_before_points` = 此刻可用）。提交不动账。积分调整 V1.0 不设决定时限（A93），`due_at` 为空。
- 带 `serviceTicketId` 时插入 `service_ticket_ref`（工单不属于该主体时 400 `VALIDATION_FAILED`，`fieldErrors` 指 `serviceTicketId`）。
- 出站事件 `approval.submitted`（通知持 `billing.adjust.approve` 的财务，工作台 ⑬ 计数）；审计（`category = points_adjust`）。

**说明**：同一主体同时只允许一张在审，商家详情的按钮随之变“调整审批中”（`PointAccountRow.hasPendingAdjustment`）。增加的套餐积分并入当前周期、随本期清零；加购积分长期有效。

### 3.26 admin.pointAdjustmentRequest.get　积分调整单详情
`GET /admin/point-adjustment-requests/{pointAdjustmentRequestId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointAdjustmentRequest.get`（A14、A16：领域详情） |
| 鉴权 | `staff`；`permission: assert-in-handler`：模块 `billing` 或 `finance` 任一 ≥ v（2.0 模块等级；与 a01 审批类型表 `points_adjust` 的查看等级一致），都不满足 403 `PERMISSION_DENIED`；数据范围 `entity`（财务为全部；发起人总能看到自己发起的） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:CreditAdjust（行展开与通过、驳回弹层的回显）；A:PointAccounts 备注条“待审批调整”的详情；“我的待审批”详情 |

**请求**：路径 `pointAdjustmentRequestId`。

**响应**：`PointAdjustmentRequestDetail`。

**错误**：无。**副作用**：无。

**说明**：A:CreditAdjust 的列表、页签计数与 KPI 由 a01 提供（a01 第 2.10 节、3.36、3.37 已承接）：

- 列表调 `admin.approval.list`（`kind = points_adjust`、`tab = all`）；四个页签“待审批 / 已通过 / 已驳回 / 全部”依次加 `status = pending`、`approved`、`rejected` 与不传 `status`。
- 页签计数取 `admin.approval.summary` 里 `kind = points_adjust` 那一项的 `byStatus.pending`、`byStatus.approved`、`byStatus.rejected` 与 `all`；KPI 取同一项的 `approvedThisMonth`、`rejectedThisMonth` 与响应的 `pointsAdjustMonth`（`increasePoints`、`decreasePoints`）。
- 行内字段（发起人岗位、可用积分 a → b、关联订单或广告单号）取审批单的 `summary_snapshot.lines`（本模块注册的处理器在提交时生成）；点开行、通过、驳回、撤回用本文 3.26–3.29。

### 3.27 admin.pointAdjustmentRequest.approve　通过积分调整（同事务入账）
`POST /admin/point-adjustment-requests/{pointAdjustmentRequestId}/approve`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointAdjustmentRequest.approve`（A14；原 `a01.approvals.approve` 的 `kind = points_adjust`） |
| 鉴权 | `staff`；`billing.adjust.approve`（财务；注册表标了再验证）；对象在数据范围内；审批人不得是发起人 |
| 回显 | 要求 `confirm`：`{ requestNo, direction, adjustPoints }` |
| 幂等 | required |
| 乐观锁 | 带审批单 `lockVersion`（`03-staff-authz-audit.md:805`，C53） |
| 对应画板 | A:CreditAdjust 通过弹层（强制勾选“已核对调整依据”） |

**请求**：路径 `pointAdjustmentRequestId`。请求体 `ApproveBody`（2.2），`confirmChecks` 必含 `basis_checked`（“已核对调整依据”）。

**响应**：`PointAdjustmentRequestDetail`（审批单 `approved`，`applied` 有值）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `APPROVAL_NOT_PENDING` | 409 | 已决或已撤回（a03） |
| `APPROVAL_SELF_FORBIDDEN` | 403 | 审批人就是发起人（a03） |
| `STEP_UP_REQUIRED` | 403 | 再验证超出窗口 |
| `VERSION_CONFLICT` | 409 | 审批单 `lockVersion` 不符 |
| `CONFIRM_MISMATCH` | 409 | 单号或数量回显不一致 |
| `PRECONDITION_CHANGED` | 409 | 入账前提已变，整个事务回滚、审批单保持待审（d1:1385-1403）：`details.reason` ∈ `account_inactive`（套餐已过期）、`insufficient`（扣减后会小于 0）、`hold_not_captured`、`hold_exhausted` |
| `ACCOUNT_BUSY` | 503 | 等账户锁超过 3 秒（m07），可用同一键重试 |

**副作用**（一个事务；加锁：审批单 → 调整单 → `billing_account`）：

- `approval_request.status`：`pending → approved`（`approve`，03-staff-authz-audit.md:805），写 `decided_by_staff_id`、`decided_at`、`confirm_checks`，`lock_version + 1`。
- 处理器 `onApproved` 调 `billing.applyAdjustment`（幂等键 `adjust:{TZ 单号}`，07-billing-ledger.md:1187）：
  - 增加（非 `platform_refund`）：插 `point_lot`（`source_type = adjust`、`source_id` = 审批单 id、`cost_basis_fen = 0`；套餐积分 `subscription_term_id` = 当前周期、`expires_at` = 周期 `ends_at`）与 `external → available` 流水；
  - 扣减：按扣减顺序从所选类型的批次 `available → adjusted_out`；
  - `platform_refund`：对冻结单调 `refund`（原批次 `consumed → available`，原周期已结束的按快照转加购，`point_hold.status`：`captured` / `refunded_partial` → `refunded_partial` / `refunded_full`，07-billing-ledger.md:846），`ledger_operation.op_type = refund`；
  - 插 `ledger_operation`（`ref_type = approval_request`）与 `point_ledger_entry`，更新 `billing_account` 缓存；回写 `point_adjustment_request.ledger_operation_id`、`applied_at`。
- 出站事件 `approval.approved`、`billing.points.adjusted`（通知商家：订阅消息与站内消息）；审计（`category = points_adjust`）。

### 3.28 admin.pointAdjustmentRequest.reject　驳回积分调整
`POST /admin/point-adjustment-requests/{pointAdjustmentRequestId}/reject`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointAdjustmentRequest.reject`（A14） |
| 鉴权 | `staff`；`billing.adjust.approve`；审批人不得是发起人；驳回不要求再验证（见回显栏） |
| 回显 | 无；路由标 `x-step-up: skip`（C86 登记，A127：驳回不要求再验证，维持 03-staff-authz-audit.md:806） |
| 幂等 | required |
| 乐观锁 | 不带（驳回的守卫没有列锁版本，A21） |
| 对应画板 | A:CreditAdjust 驳回弹层（原因单选 + 说明必填 ≤200 字） |

**请求**：路径 `pointAdjustmentRequestId`。请求体 `RejectBody`：`reasonCodes`（0–1 项，字典 `reject_reason` 场景 `point_adjust`：依据不足、数额有误、不符合调整规则、其他，14-config-data.md:129）、`note`。

**响应**：`PointAdjustmentRequestDetail`（审批单 `rejected`）。

**错误**：`APPROVAL_NOT_PENDING`（409）；`APPROVAL_SELF_FORBIDDEN`（403）。

**副作用**：`approval_request.status`：`pending → rejected`（`reject`），写 `decision_note`、`reason_codes`；出站事件 `approval.rejected`（通知申请人：站内消息）；审计（`category = points_adjust`）。不动账。

### 3.29 admin.pointAdjustmentRequest.withdraw　撤回积分调整
`POST /admin/point-adjustment-requests/{pointAdjustmentRequestId}/withdraw`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.pointAdjustmentRequest.withdraw`（A14、A15；原 `a01.approvals.withdraw`） |
| 鉴权 | `staff`；`permission: assert-in-handler`：提交人本人；发起人已不是启用状态时，由持 `billing.adjust.approve` 且对象在范围内的员工代撤 |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 不带（03-staff-authz-audit.md:807） |
| 对应画板 | A:CreditAdjust、A:PointAccounts、A:MerchantDetail（原型没有撤回按钮，在申请详情里给发起人显示） |

**请求**：路径 `pointAdjustmentRequestId`。请求体 `WithdrawBody`。

**响应**：`PointAdjustmentRequestDetail`（审批单 `withdrawn`）。

**错误**：`APPROVAL_NOT_PENDING`（409）；`APPROVAL_WITHDRAW_FORBIDDEN`（403，a03）；`STEP_UP_REQUIRED`（403，代撤时：处理器取到的决定权限点在注册表里标了再验证，同样校验，C66、C67）。

**副作用**：`approval_request.status`：`pending → withdrawn`（`withdraw`）；出站事件 `approval.withdrawn`；审计（`category = points_adjust`，代撤时写明原发起人）。

### 3.30 admin.subscriptionTerm.list　套餐到期跟进
`GET /admin/subscription-terms`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.subscriptionTerm.list` |
| 鉴权 | `staff`；模块 `order` ≥ v；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Renewals 表格（随页签换列）与页脚说明 |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `tab` | enum(`RenewalTab`) | 是 | `expiring` 7 天内到期未续费 / `expired` 已过期未续费（30 天内）/ `renewed` 本月已续费 |
| `q` | string | 否 | 商家或主体名 |
| `managerId` | string(uuid) | 否 | 交付经理（主门店的 `store.delivery_manager_id`） |
| `planId` | string(uuid) | 否 | 套餐版本 |
| `page`、`pageSize` | integer | 否 | C43 |

页签口径（与 a02 工作台 ⑦、今日数据 `active_plans` 同一计数函数）：

| `tab` | 条件 | 排序 |
| --- | --- | --- |
| `expiring` | `subscription_term.status = active`、`ends_at > now`、`end_date ≤ 今日 + 6 天`，且该主体没有 `scheduled` 的后续周期 | `end_date` 升序 |
| `expired` | 该主体没有生效周期，最近结束的周期 `status = ended` 且止日在 30 天内（超过 30 天的到商家列表按“已过期”筛选跟进） | `end_date` 降序 |
| `renewed` | 先选出本月续上的新周期：`origin` ∈ (`renew`, `resume`)、来源付款单 `billing_order.paid_at` 在本月；**行是被续的上一周期**（同主体 `term_no` = 新周期 − 1），新周期放在行的 `renewal` 里（2.9）。`planId`、`managerId` 筛选按新周期的版本与主体的主门店 | 新周期 `paid_at` 降序 |

**响应**：`AdminPage<SubscriptionTermRow>`（a01 2.1）。`renewed` 页签的 `subscriptionTermId`、起止、`status` 都是上一周期的（页面“原至”列即其 `endDate`），点开详情（3.32）看到的 `nextTerm` 即该新周期。

**错误**：无。**副作用**：无。

**说明**：导出走 a02（`exportKey = subscription_terms.list`）。续费意向取每个周期最新一条跟进（03-staff-authz-audit.md:492）；“记录跟进”调 a03 `admin.followUp.create`（`subjectType = subscription_term`，带续费意向 `intent`；负责人固定为记录人，不传负责人）。

### 3.31 admin.subscriptionTerm.summary　套餐到期 KPI 与页签计数
`GET /admin/subscription-terms/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.subscriptionTerm.summary` |
| 鉴权 | `staff`；模块 `order` ≥ v；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Renewals 页头 KPI、页签计数、页脚说明 |

**请求**：查询参数 `q`、`managerId`、`planId`（与 3.30 相同，不含 `tab` 与分页，C83）。

**响应**：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `expiring` | integer | 是 | 7 天内到期未续费 | 3.30 口径 |
| `expired` | integer | 是 | 已过期未续费（30 天内） | 3.30 口径 |
| `renewed` | integer | 是 | 本月已续费 | 3.30 口径 |
| `renewedFen` | string(bigint) | 是 | 本月续费合计（“合计 ¥516,000.00”） | 本月续费周期来源付款单 `billing_order.paid_amount_fen` 之和 |
| `renewedAheadCount` | integer | 是 | 7 天内到期但已提前续费（“另有 12 家已提前续费”） | `subscription_term`（`status = active`、`end_date ≤ 今日 + 6`）且主体有 `scheduled` 后续周期 |
| `renewalRate` | object | 是 | 本月续费率 `{ month, dueCount, doneCount, rateBp, isProvisional }`（“9 月续费率 83.1%（到期 142 家 · 续费 118 家）”） | 与 a02 `admin.report.overview.get` 的 `renewalDueCount`、`renewalDoneCount`、`renewalRateBp` 同口径 |

**错误**：无。**副作用**：无。

### 3.32 admin.subscriptionTerm.get　到期详情
`GET /admin/subscription-terms/{subscriptionTermId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.subscriptionTerm.get` |
| 鉴权 | `staff`；模块 `order` ≥ v；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Renewals 右侧详情（当前套餐、本期、积分清零与停用预告、在播短剧、续费信息、提醒时间线、跟进） |

**请求**：路径 `subscriptionTermId`。

**响应**：`SubscriptionTermDetail`。

**错误**：无。**副作用**：无。

**说明**：续费试算调 3.9（带 `pointAccountId`）；完整跟进记录调 a03 `admin.followUp.list`。

### 3.33 admin.subscriptionTerm.extensionQuote　补偿延长预览
`POST /admin/subscription-terms/{subscriptionTermId}/extension-quote`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.subscriptionTerm.extensionQuote`（d1 `POST /billing/extensions/preview`；A20） |
| 鉴权 | `staff`；`billing.extension.request`；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（试算） |
| 乐观锁 | 无 |
| 对应画板 | A:Renewals 补偿延长弹窗“延长后周期预览” |

**请求**：路径 `subscriptionTermId`。请求体：`days`（integer，1–90；界面档位 3 / 7 / 15 / 30）。

**响应**：`ExtensionQuote`（2.10）。

**错误**：无（不可执行的原因放在 `blockReasons`）。**副作用**：无。

### 3.34 admin.subscriptionTerm.remind　补发续费提醒
`POST /admin/subscription-terms/{subscriptionTermId}/remind`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.subscriptionTerm.remind` |
| 鉴权 | `staff`；`order.renewal.remind`（增补：默认交付经理、客服；另需模块 `order` ≥ v）；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | required（对外发送，A17） |
| 乐观锁 | 无 |
| 对应画板 | A:Renewals“补发续费提醒”（当日只能补发一次，之后显示“今日已补发”） |

**请求**：路径 `subscriptionTermId`。请求体无。

**响应**：`{ manualReminderLogId, bizDate, remindedToday: true }`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `REMIND_NOT_APPLICABLE` | 409 | 周期不在可提醒的状态：已退款、已取消，或已有后续周期（已续费），或过期超过 30 天（a05 定义，`details: { scene, reason }`） |
| `REMINDED_TODAY` | 409 | 同一周期今天已补发（`uq_manual_reminder_log_subject_scene_biz_date`，13-notify-docs.md:614）；通用码 40920（A76、C27），`details` 为 `{ scene: 'renewal', nextAvailableDate }`（A131），端上提示“今天已补发过”，不自动重试 |

**副作用**：插入 `manual_reminder_log`（`subject_type = subscription_term`、`scene = renewal`、`biz_date` = 今日、`sent_by_staff_id` = 本人）；出站事件 `manual_reminder.sent`，通知模块按 `m.plan_expiring` 场景派发（节点 `M`；订阅消息与短信，13-notify-docs.md:141）。正文是否带“去续费”与价格按该主体的购买入口模式定（`notification.copy_mode`）。不另写审计（催办记录即留痕）。

### 3.35 admin.termExtensionRequest.create　发起补偿延长
`POST /admin/term-extension-requests`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.termExtensionRequest.create`（路线图 `a07.term-extensions.create`；A14 资源名按表） |
| 鉴权 | `staff`；`billing.extension.request`（交付经理）；对象主体在数据范围内 |
| 回显 | 要求 `confirm`：`{ subscriptionTermId, endDate }`（操作人看到的本期止日） |
| 幂等 | required；`Idempotency-Key` 写入 `approval_request.idempotency_key` |
| 乐观锁 | 无（新建） |
| 对应画板 | A:Renewals 补偿延长弹窗（“提交后由主管审批”） |

**请求体**：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `subscriptionTermId` | string(uuid) | 是 | 周期 `status = active` 且不在退款处理中 | → `term_extension_request.subscription_term_id`；审批单对象 |
| `days` | integer | 是 | 1–90（界面档位 3 / 7 / 15 / 30） | → `term_extension_request.days` |
| `reasonCode` | string | 是 | 字典 `extend_reason` 的启用编码 | → `term_extension_request.reason_code` |
| `note` | string | 是 | 1–200 字 | → `term_extension_request.note` |
| `confirm` | object | 是 | 见上 | |

**响应**：`TermExtensionRequestDetail`（审批单 `pending`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `EXTENSION_NOT_APPLICABLE` | 409 | 周期不是生效中（预约、已到期、已退款）；`details.termStatus` |
| `PLAN_REFUND_IN_PROGRESS` | 409 | 周期在退款处理中（m07） |
| `APPROVAL_ALREADY_PENDING` | 409 | 该主体已有在审的补偿延长（`dedupe_key = subscription_extend:{entityId}`；a03） |
| `CONFIRM_MISMATCH` | 409 | 止日已变化（已被延长或已续接） |

**副作用**（一个事务）：`approval_request.status`：（新建）→ `pending`：`kind = subscription_extend`、`subject_type = subscription_term`、`request_no = YQ…`、`dedupe_key = subscription_extend:{entityId}`、`requester_staff_group_id`（发起人当时所在组，审批限本组主管，d4-identity.md:1396）；不设决定时限（A93）；插入 `term_extension_request`；出站事件 `approval.submitted`（工作台 ⑭“补偿延长审批”，只计本组主管）；审计（`category = term_adjust`）。

**说明**：原型只允许在“7 天内到期”页签发起，审批与到期赛跑是常态：执行器面向主体审批当时的有效期（d1:1008-1040），见 3.37。

### 3.36 admin.termExtensionRequest.get　延长单详情
`GET /admin/term-extension-requests/{termExtensionRequestId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.termExtensionRequest.get`（A16：“我的待审批”详情跳到本接口） |
| 鉴权 | `staff`；`permission: assert-in-handler`：模块 `order` 或 `billing` 任一 ≥ v（2.0 模块等级；与 a01 审批类型表 `subscription_extend` 的查看等级一致），都不满足 403 `PERMISSION_DENIED`；数据范围 `entity`（发起人总能看到自己发起的） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Renewals“延长审批中”；我的待审批（原型无，A16） |

**请求**：路径 `termExtensionRequestId`。

**响应**：`TermExtensionRequestDetail`（`pending` 时带按此刻重算的 `preview`）。

**错误**：无。**副作用**：无。

### 3.37 admin.termExtensionRequest.approve　通过补偿延长（同事务顺延）
`POST /admin/term-extension-requests/{termExtensionRequestId}/approve`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.termExtensionRequest.approve`（A14、A16） |
| 鉴权 | `staff`；`billing.extension.approve`（仅主管，且是发起人所在组 `approval_request.requester_staff_group_id` 的主管；超级管理员兜底，d4-identity.md:1432-1443）；审批人不得是发起人；注册表未标再验证 |
| 回显 | 要求 `confirm`：`{ requestNo, days }` |
| 幂等 | required |
| 乐观锁 | 带审批单 `lockVersion` |
| 对应画板 | 我的待审批（原型无，A16）；A:Renewals |

**请求**：路径 `termExtensionRequestId`。请求体 `ApproveBody`，`confirmChecks` 必含 `effect_preview_checked`（“已核对延长后的周期与清零时间”）。

**响应**：`TermExtensionRequestDetail`（审批单 `approved`，`applied` 有值）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `APPROVAL_NOT_PENDING` | 409 | （a03） |
| `APPROVAL_SELF_FORBIDDEN` | 403 | （a03） |
| `PERMISSION_DENIED` | 403 | 不是发起人所在组的主管，也不是超级管理员 |
| `VERSION_CONFLICT` | 409 | |
| `CONFIRM_MISMATCH` | 409 | |
| `PRECONDITION_CHANGED` | 409 | 执行器前提不成立，审批单保持待审由审批人驳回：`details.reason` ∈ `refund_in_progress`（生效周期在退款处理中）、`no_term`（从未有周期，或最近的周期已退款、已取消）、`revive_not_allowed`（已到期且发起时周期已不在生效） |
| `ACCOUNT_BUSY` | 503 | （m07） |

**副作用**（一个事务；加锁：审批单 → 延长单 → `billing_account`）：

- `approval_request.status`：`pending → approved`。
- 处理器 `onApproved` 调 `billing.applyExtension`（幂等键 `extend:{YQ 单号}`，d1:1010-1040）：
  - 情况 A（有生效周期）：`subscription_term.end_date`、`ends_at`、`extended_days` 顺延；该周期套餐批次 `point_lot.expires_at` 同步；预约周期自链尾向前后移，重算 `pending` 发放计划的 `grant_schedule.due_at`、`due_date`；
  - 情况 B（到期后补批）：`subscription_term.status`：`ended → active`（07-billing-ledger.md:544），`billing_account.sub_status`：`expired → active`（07-billing-ledger.md:439），清零冲回（`ledger_operation.op_type = unexpire`，`expired → available`），写 `addon_resume`；
  - 写 `subscription_event`：情况 A `type = extended`，情况 B `type = resumed`（07 枚举“过期后恢复”）；负载 `days`、`gapDays`、`prevEndDate`、`newEndDate`；`ledger_operation`（`op_type = extend`）；回写 `term_extension_request` 的执行结果六列。
- 出站事件 `approval.approved`；情况 A 发 `billing.subscription.extended`（载荷 `termId`、`entityId`、`prevEndsAt`、`newEndsAt`），情况 B 发 `billing.subscription.resumed`（载荷 `termId`、`entityId`、`newEndsAt`），一次只发其一（x01-events-jobs.md:282-283，E2）；通知商家“有效期延长，清零时间同步顺延”。审计（`category = term_adjust`）。提醒节点因止日变化自动重排（d1:1039）。

**说明**：延长作用到新周期时（发起后原周期已续接），原周期已清零的积分不恢复；需要补的另发起积分调整并带 `termExtensionRequestId`（3.25）。

### 3.38 admin.termExtensionRequest.reject　驳回补偿延长
`POST /admin/term-extension-requests/{termExtensionRequestId}/reject`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.termExtensionRequest.reject` |
| 鉴权 | `staff`；`billing.extension.approve`（同 3.37 的主管与组判断）；审批人不得是发起人 |
| 回显 | 无；路由标 `x-step-up: skip`（C86 登记；`billing.extension.approve` 本身不要求再验证，登记是为防日后改标，A127） |
| 幂等 | required |
| 乐观锁 | 不带 |
| 对应画板 | 我的待审批（原型无）；A:Renewals（延长审批中的详情） |

**请求**：路径 `termExtensionRequestId`。请求体 `RejectBody`（`reasonCodes` 可省略，字典 `reject_reason` 没有补偿延长场景）。

**响应**：`TermExtensionRequestDetail`（审批单 `rejected`）。

**错误**：`APPROVAL_NOT_PENDING`（409）；`APPROVAL_SELF_FORBIDDEN`（403）。

**副作用**：`approval_request.status`：`pending → rejected`；出站事件 `approval.rejected`（通知发起人）；审计（`category = term_adjust`）。

### 3.39 admin.termExtensionRequest.withdraw　撤回补偿延长
`POST /admin/term-extension-requests/{termExtensionRequestId}/withdraw`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.termExtensionRequest.withdraw`（A15） |
| 鉴权 | `staff`；`permission: assert-in-handler`：提交人本人；发起人已不是启用状态时由 `billing.extension.approve` 持有人（同组主管或超级管理员）代撤 |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 不带 |
| 对应画板 | A:Renewals（延长审批中时给发起人显示“撤回”） |

**请求**：路径 `termExtensionRequestId`。请求体 `WithdrawBody`。

**响应**：`TermExtensionRequestDetail`（审批单 `withdrawn`）。

**错误**：`APPROVAL_NOT_PENDING`（409）；`APPROVAL_WITHDRAW_FORBIDDEN`（403）。

**副作用**：`approval_request.status`：`pending → withdrawn`；出站事件 `approval.withdrawn`；审计（`category = term_adjust`）。

### 3.40 admin.paymentOrder.list　付款单列表
`GET /admin/payment-orders`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.paymentOrder.list`（草案 `/billing/orders`） |
| 鉴权 | `staff`；模块 `order` ≥ v；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Orders 付款单视图；A:MerchantDetail“订单 › 付款单”子页签（A29，按门店所属主体 `entityId` 筛选，不做合并时间线）；a08 工单关联业务的选单器（`storeId`、`no`） |

**请求**：查询参数（结构名 `AdminPaymentOrderListQuery`；与 m07 的商家端 `PaymentOrderListQuery` 不同构，按 A132、A150 加 `Admin` 前缀）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `tab` | enum | 否 | `all`（默认）/ `pending_payment` / `pending_confirmation` / `paid` / `cancelled` / `refunded`（状态筛选条） |
| `q` | string | 否 | 付款单号、商家或主体名 |
| `no` | string | 否 | 付款单号精确匹配（C11） |
| `entityId` | string(uuid) | 否 | 付款主体（付款单的归属列） |
| `storeId` | string(uuid) | 否 | 下单门店（`billing_order.store_id` 只作展示、可为空，08-billing-payment.md:68、75）：按它筛会漏掉无门店的后台代建单与同主体其他门店下的单，只用于工单选单等按门店定位的场景 |
| `type` | enum | 否 | 同数据模型 `billing_order.type`，可多值 |
| `channel` | enum | 否 | 同数据模型 `billing_order.channel` |
| `source` | enum | 否 | `weapp` / `admin` |
| `hasOpenException` | boolean | 否 | 对账差异待处理 |
| `createdFrom`、`createdTo` | string(date) | 否 | 原型“今天 / 近 7 天 / 近 30 天”由前端换算 |
| `page`、`pageSize` | integer | 否 | C43；原型每页 10 条 |

排序：`-createdAt`（默认）、`-amountFen`。

**响应**：`AdminPage<PaymentOrderAdminRow>`（a01 2.1）。

**错误**：无。**副作用**：无。

**说明**：导出走 a02（`exportKey = payment_orders.list`，参数同构）。商家详情的“付款单”子页签传 `entityId`（套餐与积分是主体级的，同主体多门店共用），行上的 `store` 标出下单门店；子页签计数用 3.41 带同一 `entityId`。

### 3.41 admin.paymentOrder.summary　付款单状态计数
`GET /admin/payment-orders/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.paymentOrder.summary` |
| 鉴权 | `staff`；模块 `order` ≥ v；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Orders 状态筛选条（“全部 1,386、待支付 1、待确认收款 3…”） |

**请求**：查询参数同 3.40（不含 `tab`、分页）。

**响应**：`AdminPaymentOrderSummary` = `{ all, pending_payment, pending_confirmation, paid, cancelled, refunded }`（integer；键与 `tab` 取值一致，C83；与 m07 的 `PaymentOrderSummary` 不同构，A132 加 `Admin` 前缀）。

**错误**：无。**副作用**：无。

### 3.42 admin.paymentOrder.get　付款单详情
`GET /admin/payment-orders/{paymentOrderId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.paymentOrder.get` |
| 鉴权 | `staff`；模块 `order` ≥ v；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Orders 右侧抽屉（应付 / 实付、生效说明、计算式、支付记录、发票状态、操作日志）；A:Receipts、A:Invoices 的付款单链接 |

**请求**：路径 `paymentOrderId`。

**响应**：`PaymentOrderAdminDetail`。

**错误**：无。**副作用**：无。

### 3.43 admin.paymentOrder.create　线下开单（对公）
`POST /admin/payment-orders`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.paymentOrder.create`（退路 B，d2:749、1343） |
| 鉴权 | `staff`；`order.payment.create_offline`（财务；A46 标再验证）；对象主体在数据范围内 |
| 回显 | 要求 `confirm`：`{ entityName, amountFen }` |
| 幂等 | required |
| 乐观锁 | 无（新建） |
| 对应画板 | 原型无（线下开单，05-risks-and-open-issues.md:271） |

**请求体**：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `entityId` | string(uuid) | 是 | 主体已认证或审核中 | → `billing_order.entity_id` |
| `storeId` | string(uuid) | 否 | 属于该主体 | → `billing_order.store_id`（仅展示） |
| `kind` | enum | 是 | `plan` / `topup` | 套餐或加购 |
| `planId` | string(uuid) | `plan` 必填 | | 目标版本 |
| `months` | integer | `plan` 且不是立即升级时必填 | 启用周期之一 | |
| `intent` | enum | 否 | `upgrade_now` / `renew_next_term`（同 m07） | |
| `pointPackId` | string(uuid) | `topup` 必填 | 上架中 | |
| `expectAmountFen` | integer(分) | 是 | 与服务端报价比对 | 不一致返回 `QUOTE_CHANGED` |
| `contractNo` | string | 是 | 1–64 字 | → `billing_order.contract_no` |
| `confirm` | object | 是 | 见上 | |

**响应**：`PaymentOrderAdminDetail`（`status = pending_payment`、`transferState = awaiting_proof`，带 `bankAccount`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `OFFLINE_ORDER_DISABLED` | 403 | 受控配置 `controls.adminCreateOrder` 未开启 |
| `BANK_ACCOUNT_NOT_CONFIGURED` | 409 | 没有生效的对公收款账户版本 |
| `PURCHASE_QUALIFICATION_REQUIRED` | 409 | 主体资质未提交或已驳回（m07） |
| `OPEN_ORDER_EXISTS` | 409 | 已有未完成的套餐类付款单（`uq_billing_order_open_plan`；m07） |
| `PLAN_NOT_AVAILABLE`、`CYCLE_NOT_AVAILABLE`、`UPGRADE_NOT_ALLOWED_TODAY`、`SCHEDULED_TERM_LIMIT`、`TOPUP_REQUIRES_ACTIVE_PLAN`、`PLAN_REFUND_IN_PROGRESS` | 见 m07 | 报价函数的拒绝（m07） |
| `QUOTE_CHANGED` | 409 | `expectAmountFen` 与报价不一致（m07）；`details` 为 m07 的 `QuoteChangedDetails`（按 `kind` 判别，A131）：本接口只会出现套餐 `{ kind: 'plan', amountFen, quote: PlanQuote }` 与加购 `{ kind: 'topup', amountFen, pointPack }` 两支 |
| `CONFIRM_MISMATCH` | 409 | 主体名或金额回显不一致 |

**副作用**（一个事务）：

- 报价：套餐调 `billing.quotePlanPurchase`、加购调 `billing.quoteTopup`，内容快照写 `billing_order.content_snapshot`、`formula_code`、`formula_args`、`quote_hash`。
- `billing_order.status`：（新建）→ `pending_payment`（08-billing-payment.md:163，“后台线下代建”）：`channel = bank_transfer`、`transfer_state = awaiting_proof`、`source = admin`、`created_by_staff_id` = 本人、`contract_no`、`bank_account_finance_config_revision_id` = 此刻生效的收款账户版本、`expires_at` = 现在 + 参数 `billing.payment.transfer_valid_days`（升级单另受快照 `validUntil` 约束）；`order_no` 由 `biz_sequence` 取号。
- 登记定时器 `po.transfer_ttl`（主体 `billing_order`，`fire_at = expires_at`）。
- 出站事件 `billing_order.created`；审计（`category = payment`，2.0）。

**说明**：后台代建不调协议同意（08-billing-payment.md:179），不受购买入口策略限制（退路 B 正是 `offline_contract` 时用的）。确认到账的财务不得是开单员工（3.48）。凭证可由商家在小程序上传，也可由员工代传（3.44）。

### 3.44 admin.paymentOrder.transferProof.create　代传对公转账凭证
`POST /admin/payment-orders/{paymentOrderId}/transfer-proofs`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.paymentOrder.transferProof.create` |
| 鉴权 | `staff`；`finance.receipt.confirm`（财务；该键在注册表标了再验证，代传同样要求，A13）；对象主体在数据范围内 |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 无 |
| 对应画板 | A:Receipts；线下开单（原型无） |

**请求**：路径 `paymentOrderId`。请求体：`fileId`（string(uuid)，分类 `pay_receipt`，图片不超过 5MB 或 PDF，已入库）；`note`（0–200 字，写审计）。

**响应**：`TransferProofDetail`（新凭证，`reviewStatus = pending`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 不是对公付款单，或付款单已支付、已取消、已退款 |
| `PAYMENT_ORDER_EXPIRED` | 409 | 待支付已过 `expires_at`（m07） |
| `TRANSFER_PROOF_LOCKED` | 409 | 正在二人复核（`confirm_review`），须先由复核人退回（m07） |
| `FILE_NOT_USABLE` | 400 | 文件未入库或分类不符（m03） |

**副作用**（一个事务，08-billing-payment.md:167-168、403、410）：

- 插入 `transfer_proof`（`upload_no` + 1、`uploaded_by_staff_id` = 本人、`due_at` = 上传后 1 个工作日，`sla_snapshot.policy = review.transfer_proof`）；配置了识别时经 media 发起回单识别，`ocr_result` 先以 `pending` 建行。
- 付款单为 `pending_payment`（`awaiting_proof` / `proof_rejected`）时：`billing_order.status`：`pending_payment → pending_confirmation`（`transfer_state = proof_submitted`）。为 `pending_confirmation`（`proof_submitted`）时：旧凭证 `transfer_proof.review_status`：`pending → superseded`，付款单状态不变（只写审计），取消旧凭证的 `sla.breach` 定时器。
- 登记 `sla.breach` 定时器（主体 `transfer_proof`）；出站事件 `transfer.proof_submitted`；审计（`category = payment`）。

### 3.45 admin.transferProof.list　对公收款确认队列
`GET /admin/transfer-proofs`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.transferProof.list`（草案 `/finance/receipts`） |
| 鉴权 | `staff`；模块 `order` ≥ v（查看类不设权限点，C66）；数据范围 `global`（处理队列） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Receipts 左栏队列 |

**请求**：查询参数 `tab`（`pending` 待确认 / `processed_today` 今日已处理，默认 `pending`）、`q`（商家或付款单号）、`page`、`pageSize`。排序：`pending` 按升级单（报价将失效）置顶、再按 `uploaded_at` 升序（“昨日上传，请优先处理”）；`processed_today` 按 `reviewed_at` 降序。

**响应**：`AdminPage<TransferProofQueueItem>`（a01 2.1）。

**错误**：无。**副作用**：无。

**说明**：对公收款确认是处理队列，不进审批单（M22）；页面每 30 秒静默刷新计数（d7:1052），用 3.46。

### 3.46 admin.transferProof.summary　队列页签计数
`GET /admin/transfer-proofs/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.transferProof.summary`（A26、A23） |
| 鉴权 | `staff`；模块 `order` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Receipts 页签“待确认 N / 今日已处理 N” |

**请求**：查询参数 `q`（同 3.45，不含 `tab` 与分页）。

**响应**：`{ pending: integer, processed_today: integer, pendingAmountFen: string(bigint) }`（`pendingAmountFen` 与工作台 ② 的副指标同口径：所属付款单 `billing_order.amount_fen` 之和）。

**错误**：无。**副作用**：无。

### 3.47 admin.transferProof.get　凭证详情
`GET /admin/transfer-proofs/{transferProofId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.transferProof.get` |
| 鉴权 | `staff`；`permission: assert-in-handler`：模块 `order` 或 `finance` 任一 ≥ v（2.0 模块等级；A:Receipts 挂订单菜单按 `order`，“我的待审批”里的对公复核按 `finance`，与 a01 审批类型表 `transfer_confirm` 一致），都不满足 403 `PERMISSION_DENIED` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Receipts 右栏（付款单信息、业务提示、凭证图、凭证核对表） |

**请求**：路径 `transferProofId`。

**响应**：`TransferProofDetail`。凭证图不在响应里签发，前端用 `fileId` 调 a01 `admin.file.downloadUrls`（A19，写访问审计）。

**错误**：无。**副作用**：无。

**说明**：识别出的付款户名、金额、附言、时间是企业间转账的交易事实，按原值返回；付款账号只给脱敏串（A89、C40 的明文例外，待法务、财务确认，第 6 节第 1 项）。

### 3.48 admin.transferProof.confirm　确认到账
`POST /admin/transfer-proofs/{transferProofId}/confirm`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.transferProof.confirm`（草案 `POST /billing/orders/{no}/confirm-receipt`） |
| 鉴权 | `staff`；`finance.receipt.confirm`（财务；注册表标了再验证）；确认人不得是该单的开单员工 |
| 回显 | 要求 `confirm`：`{ orderNo, receivedAmountFen, conflictOrderNos? }`：`receivedAmountFen` 是财务对照银行流水填写的到账金额；规范化流水号与已有收款冲突、但付款行不同时，须在 `conflictOrderNos` 显式回显冲突的付款单号（d2:743） |
| 幂等 | required |
| 乐观锁 | 带凭证的 `lockVersion`（`transfer_proof.lock_version`；两名财务同时处理时后者得到 409，08-billing-payment.md:399） |
| 对应画板 | A:Receipts“确认到账”（须先勾选“已在银行流水中查到该笔到账，户名与金额一致”并填写银行流水号）；原型确认区只有勾选与流水号输入（Receipts.dc.html:109），本接口另要“到账金额”与冲突时的“付款行”，页面需补这两个输入（第 6 节第 4 项） |

**请求**：路径 `transferProofId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `lockVersion` | integer | 是 | | 凭证锁版本 |
| `bankSerialNo` | string | 是 | 1–64 字 | 银行流水号原文 → `payment_txn.bank_serial_raw`；规范化（去空白、全角转半角、去连字符、转大写）后 → `payment_txn.channel_txn_no` |
| `payerBankCode` | string | 否 | 字典 `bank` 的编码 | 只在流水号冲突时填写（先不填提交，收到 `BANK_SERIAL_DUPLICATE` 后页面再显示付款行选择）→ `payment_txn.payer_bank` |
| `confirm` | object | 是 | 见上；`receivedAmountFen` 由财务按银行流水填写，前端不得用应付金额自动回填 | |
| `confirmChecks` | array<string> | 是 | 1–10 项，必含 `bank_statement_checked` | 写审计 |

**响应**：`TransferProofDetail` 另加 `outcome`：`paid`（已入账）/ `review_pending`（启用二人复核且金额 ≥ 阈值，待第二人复核）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 凭证不是 `pending`，或已在复核中，或付款单不是 `pending_confirmation`（`proof_submitted`） |
| `VERSION_CONFLICT` | 409 | 凭证 `lockVersion` 不符 |
| `CONFIRMER_IS_ORDER_CREATOR` | 403 | 确认人是开单员工（08-billing-payment.md:171） |
| `TRANSFER_AMOUNT_MISMATCH` | 409 | 到账金额 ≠ 应付；请走“金额不符”驳回，实际到账由“登记异常到账”处理（d2:744-746） |
| `BANK_SERIAL_DUPLICATE` | 409 | 规范化流水号（加付款行）已入库（`uq_payment_txn_channel_txn_no`）；或冲突时未填付款行；`details.conflicts` 带已用该流水号的付款单号与付款行（`payerBank: DictRef \| null`） |
| `CONFIRM_MISMATCH` | 409 | 付款单号回显不符，或冲突放行时 `conflictOrderNos` 与实际冲突不一致 |
| `STEP_UP_REQUIRED` | 403 | |
| `ACCOUNT_BUSY` | 503 | 履约等账户锁超时（m07） |

**副作用**（一个事务；加锁：付款单 → 凭证 → `billing_account`）：

- **不需复核**（`controls.receiptSecondReviewFen` 为 null 或金额低于阈值）：
  - 插入 `payment_txn`（`channel = bank_transfer`、`status = succeeded`、`channel_amount_fen` = 到账金额、`channel_success_at` = 现在、`channel_payer_ref` = 付款户名、`confirmed_by_staff_id` = 本人、`transfer_proof_id` = 本凭证、`recon_state = matched`）；
  - `billing_order.status`：`pending_confirmation → paid`（08-billing-payment.md:171），写 `paid_at`、`paid_amount_fen`、`paid_payment_txn_id`、`applied_at`，清空 `transfer_state`；
  - 调 `billing.fulfill()`：`billing_order.fulfillment_status`：`none → done` 或 `blocked`（只写审计）；套餐：建周期与发放计划，`billing_account.sub_status`：`none` / `expired` → `active`（07-billing-ledger.md:436），首次开通的起算时刻 = 确认到账时刻；加购：建批次；受阻时同事务 `payment_exception.status`：（新建）→ `open`（`kind = fulfillment_blocked`），付款单 `has_open_exception = true`；
  - `transfer_proof.review_status`：`pending → accepted`（写 `reviewed_by_staff_id`、`reviewed_at`），取消其 `sla.breach` 定时器；
  - 出站事件 `billing_order.paid`（通知商家“到账已确认”、发货信息上报开关）、`billing.order_fulfilled` 及 `fulfill()` 内按履约内容发出的 `billing.subscription.activated` / `renewal_scheduled` / `upgraded`、`billing.points.granted` / `purchased`（x01 3.7）；受阻时改发 `billing_order.fulfillment_blocked`、`payment_exception.opened`；审计（`category = payment`，记 `confirm` 与勾选项）。
- **需复核**（金额 ≥ 阈值）：
  - `approval_request.status`：（新建）→ `pending`（`kind = transfer_confirm`、`subject_type = transfer_proof`、`dedupe_key = transfer_confirm:{transferProofId}`）；不设决定时限（A93）；
  - 写 `transfer_proof.first_confirm`（流水号原文与规范值、付款行、到账金额）、`transfer_proof.review_approval_request_id`；凭证状态仍是 `pending`；
  - `billing_order.transfer_state`：`proof_submitted → confirm_review`（子状态，只写审计，08-billing-payment.md:172）；
  - 出站事件 `approval.submitted`；审计（`category = payment`）。

**说明**：资质审核中也可以确认到账，套餐照常生效（d2:772）。升级单确认时已过报价有效期或本期已结束，`fulfill()` 返回 `blocked`，付款单仍是已支付，财务按差异单走全额退款（d2:747）。

### 3.49 admin.transferProof.reject　驳回凭证
`POST /admin/transfer-proofs/{transferProofId}/reject`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.transferProof.reject`（草案 `reject-receipt`） |
| 鉴权 | `staff`；`finance.receipt.reject`（财务；不要求再验证） |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 带凭证的 `lockVersion` |
| 对应画板 | A:Receipts 驳回弹窗（原因单选 5 项 + 说明 ≤200 字必填） |

**请求**：路径 `transferProofId`。请求体：`lockVersion`；`reasonCode`（字典 `reject_reason` 场景 `transfer`：未到账、金额不符、户名与购买主体不一致、凭证无法识别、其他）；`note`（1–200 字）。

**响应**：`TransferProofDetail`（`reviewStatus = rejected`）。

**错误**：`STATE_NOT_ALLOWED`（409，凭证不是 `pending` 或正在复核）；`VERSION_CONFLICT`（409）。

**副作用**（一个事务，08-billing-payment.md:170、409）：

- `transfer_proof.review_status`：`pending → rejected`，写 `reject_reason_code`、`reject_note`、`reviewed_by_staff_id`、`reviewed_at`；取消 `sla.breach` 定时器。
- `billing_order.status`：`pending_confirmation → pending_payment`（`transfer_state = proof_rejected`，M68）；`expires_at` 从驳回时刻起顺延一个对公有效期（升级单不延长），按新 `expires_at` 重新登记 `po.transfer_ttl` 定时器。
- 出站事件 `transfer.rejected`（载荷 `reasonCodes` = `[reasonCode]`，x01 的载荷是数组；通知商家“凭证被驳回：原因”，可重新上传）；审计（`category = payment`）。

**说明**：原型写“驳回后付款单保持待确认收款”（proto-admin-b.md:257），按数据模型 M68 回到待支付（凭证被驳回）。

### 3.50 admin.transferProof.approveReview　大额二人复核通过
`POST /admin/transfer-proofs/{transferProofId}/approve-review`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.transferProof.approveReview`（A14；原 `a01.approvals.approve` 的 `kind = transfer_confirm`） |
| 鉴权 | `staff`；`finance.receipt.confirm`（注册表标了再验证）；复核人不得是第一确认人（审批单的发起人 ≠ 审批人保证） |
| 回显 | 要求 `confirm`：`{ orderNo, receivedAmountFen }` |
| 幂等 | required |
| 乐观锁 | 带复核审批单的 `lockVersion` |
| 对应画板 | A:Receipts（复核中的凭证）；我的待审批 |

**请求**：路径 `transferProofId`。请求体 `ApproveBody`，`confirmChecks` 必含 `bank_statement_checked`（复核人同样在银行流水里核对到账）。

**响应**：`TransferProofDetail`（`reviewStatus = accepted`，`outcome = paid`）。

**错误**：`APPROVAL_NOT_PENDING`（409）；`APPROVAL_SELF_FORBIDDEN`（403）；`VERSION_CONFLICT`（409）；`CONFIRM_MISMATCH`（409）；`BANK_SERIAL_DUPLICATE`（409，复核期间流水号已被他单使用）；`STEP_UP_REQUIRED`（403）；`ACCOUNT_BUSY`（503）。

**副作用**（一个事务）：`approval_request.status`：`pending → approved`；按 `first_confirm` 的内容执行 3.48“不需复核”的全部写入：`payment_txn` 的 `confirmed_by_staff_id` 取审批单发起人、`reviewed_by_staff_id` 取本人（08-billing-payment.md:407）；`transfer_proof.review_status`：`pending → accepted`；`billing_order.status`：`pending_confirmation`（`confirm_review`）→ `paid`（08-billing-payment.md:173）；出站事件 `approval.approved`、`billing_order.paid` 及与 3.48 相同的履约事件（受阻时 `billing_order.fulfillment_blocked`、`payment_exception.opened`）；审计（`category = payment`）。

**说明**：二人复核默认不启用（`receiptSecondReviewFen = null`，M25）；V1.0 不提供复核单的撤回（A58）。

### 3.51 admin.transferProof.rejectReview　大额二人复核退回
`POST /admin/transfer-proofs/{transferProofId}/reject-review`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.transferProof.rejectReview`（A14） |
| 鉴权 | `staff`；`finance.receipt.confirm`（驳回不要求再验证，见回显栏）；复核人不得是第一确认人 |
| 回显 | 无；路由标 `x-step-up: skip`（C86 登记，A127：驳回不要求再验证，维持 03-staff-authz-audit.md:806） |
| 幂等 | required |
| 乐观锁 | 不带（驳回的守卫没有列锁版本） |
| 对应画板 | A:Receipts；我的待审批 |

**请求**：路径 `transferProofId`。请求体 `RejectBody`：`note` 必填；`reasonCodes` 不传——字典 `reject_reason` 没有对公复核场景（14-config-data.md:124-131 只播种了 `transfer` 凭证驳回等 6 个场景），退回原因写在 `note` 里；14 分组若补场景再启用。

**响应**：`TransferProofDetail`（凭证仍 `pending`，`firstConfirm = null`）。

**错误**：`APPROVAL_NOT_PENDING`（409）；`APPROVAL_SELF_FORBIDDEN`（403）。

**副作用**：`approval_request.status`：`pending → rejected`；清空 `transfer_proof.first_confirm`（凭证保持 `pending`，08-billing-payment.md:408）；`billing_order.transfer_state`：`confirm_review → proof_submitted`（子状态，只写审计）；出站事件 `approval.rejected`（通知第一确认人）；审计（`category = payment`）。第一名财务可重新确认（新复核单）或驳回凭证。

### 3.52 admin.paymentTransaction.list　收款流水
`GET /admin/payment-transactions`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.paymentTransaction.list`（草案 `/finance/payments`） |
| 鉴权 | `staff`；模块 `finance` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Payments 表格与表尾“共 N 条 · 合计 ¥X” |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `q` | string | 否 | 付款单号、交易单号或银行流水号、商家，模糊匹配 |
| `successFrom`、`successTo` | string(date) | 否 | 收款时间区间（原型“本月 / 近 7 天 / 今天”由前端换算，建议加自定义区间，proto-admin-d.md:81） |
| `orderType` | enum | 否 | 同数据模型 `billing_order.type` |
| `channel` | enum | 否 | 同数据模型 `payment_txn.channel` |
| `reconState` | enum | 否 | 同数据模型 `payment_txn.recon_state` |
| `isApplied` | boolean | 否 | 只看未入账收款（孤儿、重复款） |
| `page`、`pageSize` | integer | 否 | C43 |

排序：`-channelSuccessAt`（默认）。

**响应**：`AdminPage<PaymentTransactionRow>`（a01 2.1，C43；列表不返回合计，A23）。

**错误**：无。**副作用**：无。

**说明**：导出走 a02（`exportKey = payment_transactions.list`）。表尾“共 N 条 · 合计 ¥X”的合计随筛选变化，由 3.53 带同一组筛选参数返回的 `filtered` 给（C83：`summary` 的查询参数与列表相同）。

### 3.53 admin.paymentTransaction.summary　收款流水 KPI
`GET /admin/payment-transactions/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.paymentTransaction.summary` |
| 鉴权 | `staff`；模块 `finance` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Payments 页头 4 张 KPI 卡（“对账差异”整卡链接到对账页）与表尾合计 |

**请求**：查询参数与 3.52 相同（去掉 `page`、`pageSize`，C83）。

**响应**：`filtered` 随筛选变化；其余是页头的固定口径（不受筛选影响，同一个响应里并列返回，C83 允许同口径的副指标与页头上下文，A79）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `filtered` | object | 是 | 表尾合计 `{ count, channelAmountFen }`：与 3.52 同一筛选、同一查询构造函数 | 符合筛选的 `payment_txn` 计数与 `channel_amount_fen` 之和 |
| `today` | object | 是 | 今日收款 `{ amountFen, count, wechatCount, bankCount }` | `payment_txn`（`status = succeeded`、`channel_success_at` 在今日） |
| `month` | object | 是 | 本月收款 `{ amountFen, count, wechatCount, bankCount }` | 同上，本月 |
| `monthRefund` | object | 是 | 本月退款 `{ amountFen, count }`（含差异退款，真实的资金流出，d2:1124） | `refund_txn`（`status = succeeded`、`success_at` 在本月） |
| `openDiff` | object | 是 | 对账差异 `{ count, amountFen, earliestBillDate }`（与工作台 ⑰ 同一计数函数，2.19） | `payment_exception`（`status = open`） |

金额字段均为 `string(bigint)`（跨主体汇总，A90）。

**错误**：无。**副作用**：无。

### 3.54 admin.paymentOrder.refundQuote　现金退款试算
`POST /admin/payment-orders/{paymentOrderId}/refund-quote`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.paymentOrder.refundQuote`（草案 `POST …/refund-preview`；A20：试算一律 POST） |
| 鉴权 | `staff`；`order.refund.request`（客服）；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（试算） |
| 乐观锁 | 无 |
| 对应画板 | A:Orders 付款单抽屉的“发起退款”（原型没有现金退款的发起入口，proto-admin-d.md:130，建议放在付款单详情）；A:ServiceDetail（从工单发起） |

**请求**：路径 `paymentOrderId`。请求体：`ruleCode`（`window` / `qualification_failed` / `override`，可选；`override` 只有持 `refund.override.request` 时才计算，否则忽略）。

**响应**：`CashRefundQuote`（2.14）。

**错误**：无（不可发起的原因放在 `supported`、`unsupportedReason`、`rules[].reasons`）。**副作用**：无（`previewPlanRefund` 只读）。

### 3.55 admin.paymentOrder.refundRequest.create　发起现金退款申请
`POST /admin/payment-orders/{paymentOrderId}/refund-requests`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.paymentOrder.refundRequest.create`（d2:1473） |
| 鉴权 | `staff`；`order.refund.request`；`ruleCode = override` 时处理器另要求 `refund.override.request`（增补，默认仅超级管理员、要再验证），不足 403 `PERMISSION_DENIED`；数据范围 `entity` |
| 回显 | 要求 `confirm`：`{ orderNo, amountFen }`（`amountFen` = 试算的可退金额） |
| 幂等 | required；`Idempotency-Key` 写入 `approval_request.idempotency_key` |
| 乐观锁 | 无（新建） |
| 对应画板 | A:Orders、A:ServiceDetail |

**请求**：路径 `paymentOrderId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `ruleCode` | enum | 是 | `window` / `qualification_failed` / `override` | → `refund_request.rule_code`、`is_override` |
| `reasonCode` | string | 是 | 字典 `refund_reason` 的启用编码（商家申请取消、效果未达预期、资质审核不通过且无法补正等） | → `refund_request.reason_code` |
| `note` | string | `override` 必填 | 0–200 字 | → `refund_request.note` |
| `serviceTicketId` | string(uuid) | 否 | 同主体的客服工单 | 写 `service_ticket_ref`（`ref_type = approval_request`，12 分组） |
| `confirm` | object | 是 | 见上 | |

**响应**：`RefundRequestDetail`（`status = pending_approval`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `REFUND_NOT_SUPPORTED` | 409 | 不属于 V1.0 支持的组合（加购、单独的升级补差、未履约、部分金额，d2:1018-1031）；`details.reasonCode` 同 `CashRefundQuote.unsupportedReason` |
| `REFUND_REQUEST_EXISTS` | 409 | 该笔收款已有在途申请（`uq_refund_request_open_payment_txn`，M12） |
| `PLAN_REFUND_NOT_ELIGIBLE` | 409 | 规则核算不通过（窗口外、已使用积分含冻结、周期已升级而规则不是 `override`、资质未终审不通过），或 `suspendTermForRefund` 拒绝；`details: { rule, reasons }` |
| `CONFIRM_MISMATCH` | 409 | 回显金额与服务端核算不一致 |
| `ACCOUNT_BUSY` | 503 | （m07） |

**副作用**（一个事务，08-billing-payment.md:523）：

- `approval_request.status`：（新建）→ `pending`：`kind = plan_refund`、`subject_type = billing_order`、`request_no = TK…`、`dedupe_key` 为空（在途唯一由退款申请表达）、`requester_staff_id` = 本人；写决定时限 `due_at` 与 `sla_snapshot`（策略 `review.refund_approve`，1 个工作日），登记定时器 `sla.breach:approval_request:{approvalRequestId}:decision`（2.0“审批决定时限”）。
- `refund_request.status`：（新建）→ `pending_approval`：`source = customer_service`、`payment_txn_id` = 付款单入账交易、`base_amount_fen` = `amount_fen` = 可退金额、`breakdown_snapshot`（窗口截止、被退周期起止等）、`rule_text`；窗口按此刻（即 `created_at`）判断，只判断这一次（M99）。
- 套餐规则：`billing.suspendTermForRefund`（幂等键 `refund_suspend:{TK 单号}`）：`subscription_term.refund_request_id`、`refund_rule` 写入（退款处理中闸门，主体不可再新增冻结与购买，07-billing-ledger.md:553）；若是当前周期写 `ledger_operation`（`op_type = refund_suspend`）与 `subscription_event`（`type = refund_suspended`）。
- 该付款单 `pending` 的开票申请写 `invoice_request.held_by_refund_request_id`（暂停开具）。
- 带 `serviceTicketId` 时插入 `service_ticket_ref`（`ref_type = approval_request`、`ref_id` = 审批单；工单不属于该主体时 400 `VALIDATION_FAILED`）。
- 出站事件 `approval.submitted`、`refund.submitted`、`billing.subscription.refund_suspended`；审计（`category = refund`）。

**说明**：已开票的付款，执行前须回填红字发票（审批通过时开票申请转 `red_pending`，3.59；执行守卫 `RED_INVOICE_REQUIRED`，3.62）。同主体的加购积分不退现金，订阅失效后停用（d2:975）。

### 3.56 admin.refundRequest.list　现金退款申请列表
`GET /admin/refund-requests`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.refundRequest.list`（A26） |
| 鉴权 | `staff`；模块 `finance` ≥ v；数据范围 `entity`（财务为全部） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Refunds 队列（现金退款部分；订购与广告取消调 a05 `admin.cancelRequest.list`，页面合并展示） |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `tab` | enum(`RefundTab`) | 否 | `pending_approval` 待审批（默认）/ `pending_execution` 待执行（含 `executing` 执行中，原型“待执行”页签里以“退款处理中”状态显示）/ `processed` 已处理（`done` 与 `not_executed`）/ `all`；取值与默认页签同 a05 `admin.cancelRequest.list`（页面并排调用） |
| `q` | string | 否 | `TK` 单号、`FK` 单号、商家名 |
| `entityId`、`storeId` | string(uuid) | 否 | `storeId` 按付款单的下单门店 |
| `ruleCode` | enum | 否 | |
| `source` | enum | 否 | `customer_service` / `exception` |
| `overdueOnly` | boolean | 否 | 只看超时的待审批（`approval_request.due_at` 已过）与待执行（`exec_due_at` 已过），同 a05 |
| `page`、`pageSize` | integer | 否 | C43 |

排序：`pending_approval` 按申请时间升序；`pending_execution` 按 `exec_due_at` 升序（超时在前，`executing` 排在同页签最后）；其余 `-createdAt`。

**响应**：`AdminPage<RefundRequestRow>`（a01 2.1）。

**错误**：无。**副作用**：无。

### 3.57 admin.refundRequest.summary　现金退款页签计数与指标
`GET /admin/refund-requests/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.refundRequest.summary`（A26、A23） |
| 鉴权 | `staff`；模块 `finance` ≥ v；数据范围 `entity` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Refunds 页签计数与 KPI（与 a05 `admin.cancelRequest.summary` 各给各的，页面相加，C83） |

**请求**：查询参数同 3.56（不含 `tab`、分页）。

**响应**：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `tabs` | object | 是 | 页签计数 `{ pending_approval, pending_execution, processed }`（结构同 a05 `CancelRequestSummary.tabs`，页面按键相加；`pending_execution` 含 `executing`） | `refund_request.status` |
| `executingCount` | integer | 是 | 其中执行中（微信原路退在途） | `refund_request.status = executing` |
| `monthRefunded` | object | 是 | 本月已退款 `{ amountFen: string(bigint), count }` | `refund_request`（`status = done`、`done_at` 在本月） |
| `inProgressCount` | integer | 是 | 审批与执行中 = 待审批 + 待执行（含执行中） | 同上 |
| `monthRejectedCount` | integer | 是 | 本月驳回 | `refund_request`（`close_reason = rejected`、`closed_at` 在本月） |
| `overdueCount` | integer | 是 | 超时的待审批与待执行（同 a05） | `approval_request.due_at` 或 `refund_request.exec_due_at` 已过 |

**错误**：无。**副作用**：无。

### 3.58 admin.refundRequest.get　现金退款申请详情
`GET /admin/refund-requests/{refundRequestId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.refundRequest.get`（A26） |
| 鉴权 | `staff`；`permission: assert-in-handler`：模块 `finance` 或 `order` 任一 ≥ v（2.0 模块等级；客服从付款单抽屉进入时用 `order`，与 a01 审批类型表 `plan_refund` 的查看等级一致），都不满足 403 `PERMISSION_DENIED`；数据范围 `entity`（发起人总能看到自己发起的） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Refunds 详情（核算依据、开票状态、执行结果与退款交易、处理记录）；A:Orders |

**请求**：路径 `refundRequestId`。

**响应**：`RefundRequestDetail`。执行后的结果（`executing → done` 或回到待执行）按本接口轮询，建议每 5 秒一次、至多 2 分钟。

**错误**：无。**副作用**：无。

### 3.59 admin.refundRequest.approve　审批通过
`POST /admin/refund-requests/{refundRequestId}/approve`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.refundRequest.approve`（A14；原 `a01.approvals.approve` 的 `kind = plan_refund`） |
| 鉴权 | `staff`；`finance.refund.approve`（财务；注册表标了再验证）；审批人不得是申请人（只有一名财务时由超级管理员审批，d4-identity.md:1443） |
| 回显 | 要求 `confirm`：`{ requestNo, amountFen }` |
| 幂等 | required |
| 乐观锁 | 带审批单的 `lockVersion` |
| 对应画板 | A:Refunds 审批弹层（回显商家、单号、退回方式、开票状态、数额；强制勾选“已核对所处阶段、适用规则与退回数额”） |

**请求**：路径 `refundRequestId`。请求体 `ApproveBody`，`confirmChecks` 必含 `rule_amount_checked`（“已核对所处阶段、适用规则与退回数额”）。

**响应**：`RefundRequestDetail`（`status = pending_execution`）。

**错误**：`APPROVAL_NOT_PENDING`（409）；`APPROVAL_SELF_FORBIDDEN`（403）；`STEP_UP_REQUIRED`（403）；`VERSION_CONFLICT`（409）；`CONFIRM_MISMATCH`（409）；`PRECONDITION_CHANGED`（409，复核会变坏的事实不通过：套餐规则重新调 `previewPlanRefund` 只看“未使用”（窗口不再复核）、可退余额不足、差异转入的收款已入账；`details.reasons`；审批单保持待审，复核结果写 `recheck_log.approve`）。

**副作用**（一个事务，08-billing-payment.md:524）：

- `approval_request.status`：`pending → approved`；取消决定时限定时器 `sla.breach:approval_request:{approvalRequestId}:decision`。
- `refund_request.status`：`pending_approval → pending_execution`，写 `exec_due_at`（参数 `sla.review.refund_execute`，默认 1 个工作日）、`sla_snapshot`、`recheck_log.approve`。
- 登记执行时限定时器 `sla.breach:approval_request:{approvalRequestId}:execution`（主体审批单，M71）。
- 入账收款的退款：该付款单 `issued` 的开票申请 `invoice_request.status`：`issued → red_pending`（进入“待红冲”队列，08-billing-payment.md:1115）。
- 出站事件 `approval.approved`、`refund.approved`、`invoice.red_requested`（有红冲时）；审计（`category = refund`）。

### 3.60 admin.refundRequest.reject　驳回现金退款申请
`POST /admin/refund-requests/{refundRequestId}/reject`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.refundRequest.reject`（A14） |
| 鉴权 | `staff`；`finance.refund.approve`；审批人不得是申请人；驳回不要求再验证（见回显栏） |
| 回显 | 无；路由标 `x-step-up: skip`（C86 登记，A127：驳回不要求再验证，维持 03-staff-authz-audit.md:806） |
| 幂等 | required |
| 乐观锁 | 不带 |
| 对应画板 | A:Refunds 驳回弹层（原因单选 + 说明必填 ≤200 字；“驳回原因同步给申请人和关联的客服工单”） |

**请求**：路径 `refundRequestId`。请求体 `RejectBody`：`reasonCodes`（0–1 项；原型四项“不符合退款规则、金额核算有误、说明不充分、其他”，proto-admin-d.md:126。按 A156，14 分组在字典 `reject_reason` 下补“取消与退款驳回”场景（与 a05 取消申请共用）并播种这 4 项（数据模型待回写，场景键以回写为准；第 6 节第 5 项已定）；播种前不传）、`note`。

**响应**：`RefundRequestDetail`（`status = not_executed`、`closeReason = rejected`）。

**错误**：`APPROVAL_NOT_PENDING`（409）；`APPROVAL_SELF_FORBIDDEN`（403）。

**副作用**（一个事务，处理器 `onRejected`，08-billing-payment.md:525）：

- `approval_request.status`：`pending → rejected`；取消决定时限定时器。
- `refund_request.status`：`pending_approval → not_executed`（`close_reason = rejected`），写 `closed_at`。
- 套餐规则：`billing.resumeTermFromRefund`（幂等键 `refund_resume:{TK 单号}`）：清空 `subscription_term.refund_request_id`、`refund_rule`；当前周期写 `ledger_operation`（`op_type = refund_resume`）与 `subscription_event`（`type = refund_resumed`）。
- 清除该付款单开票申请的 `invoice_request.held_by_refund_request_id`。
- 差异转入：`payment_exception.status`：`resolving → open`（清空处理方式、说明、处理人与退款申请引用，08-billing-payment.md:764）。
- 出站事件 `approval.rejected`、`refund.rejected`（通知申请人，客服工单追加记录）、`billing.subscription.refund_resumed`、`payment_exception.reopened`（差异转入时）；审计（`category = refund`）。此时开票申请只是被暂停（还没有进入 `red_pending`），不发 `invoice.red_cancelled`。

### 3.61 admin.refundRequest.withdraw　撤回现金退款申请
`POST /admin/refund-requests/{refundRequestId}/withdraw`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.refundRequest.withdraw`（A14、A15） |
| 鉴权 | `staff`；`permission: assert-in-handler`：申请人本人；申请人已不是启用状态时由 `finance.refund.approve` 持有人代撤（08-billing-payment.md:526） |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 不带 |
| 对应画板 | A:Refunds、A:Orders、A:ServiceDetail |

**请求**：路径 `refundRequestId`。请求体 `WithdrawBody`。

**响应**：`RefundRequestDetail`（`status = not_executed`、`closeReason = withdrawn`）。

**错误**：`APPROVAL_NOT_PENDING`（409，已审批的只能作废）；`APPROVAL_WITHDRAW_FORBIDDEN`（403）；`STEP_UP_REQUIRED`（403，代撤时：处理器取到的决定权限点在注册表里标了再验证，同样校验，C66、C67）。

**副作用**：`approval_request.status`：`pending → withdrawn`，取消决定时限定时器；`refund_request.status`：`pending_approval → not_executed`（`close_reason = withdrawn`）；其余同 3.60 的恢复动作（`resumeTermFromRefund`、清除开票暂停、差异单 `resolving → open`）；出站事件 `approval.withdrawn`、`refund.withdrawn`、`billing.subscription.refund_resumed`、`payment_exception.reopened`；审计（`category = refund`）。

### 3.62 admin.refundRequest.execute　执行退款（微信原路退）
`POST /admin/refund-requests/{refundRequestId}/execute`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.refundRequest.execute`（d2:1473） |
| 鉴权 | `staff`；`finance.refund.execute`（财务；注册表标了再验证）；参数 `refund.require_distinct_executor` 为 true 时执行人不得是审批人（d4-identity.md:1501，原名 `sod.refund.distinct_executor` 作废；默认 false；参数待 14 分组登记，与 a05 取消申请同一个键，第 6 节第 6 项） |
| 回显 | 要求 `confirm`：`{ requestNo, amountFen, channelTxnNo }`（原交易单号与退款金额，原型强制勾选“已核对原交易单号与退款金额”） |
| 幂等 | required；**三段式用例，多事务形态**（C51）：事务 E1 落意图、回收权益、建 `refund_txn(created)` 并提交 → 事务外以 `out_refund_no` 调微信 → 事务 E2 落外调结果并写幂等记录。占用 `in_progress` 30 秒，期内重复请求 409 `IDEMPOTENCY_IN_PROGRESS`（可重试）；E1 已提交的状态不随外调失败回滚；占用过期后同键重放从“以同一 `out_refund_no` 提交微信”续做（E1 的写入按状态与幂等键识别为已完成）。约定 C51 已登记为“多事务”（A154），清单 `threePhase: true` |
| 乐观锁 | 不带（`refund_request` 状态机的守卫没有列锁版本；并发靠按序行锁与原状态条件） |
| 对应画板 | A:Refunds 执行弹层（“通过微信支付原路退回，发起后不可撤销”） |

**请求**：路径 `refundRequestId`。请求体：`confirm`、`confirmChecks`（1–10 项，必含 `original_txn_checked`）。

**响应**：`RefundRequestDetail`（`status = executing`）。退款结果一律由回调与 `rf.poll` 定时器落终态（`executing → done` 或回到待执行），前端按 3.58 轮询。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 申请不是 `pending_execution` |
| `REFUND_ROUTE_NOT_ALLOWED` | 409 | 不能原路退：对公收款，或微信收款已超 365 天减安全余量（d2:917）；`details.allowedRoutes = ["offline"]`，改用 3.63 |
| `RED_INVOICE_REQUIRED` | 409 | 入账收款的最新开票申请为 `issued` / `red_pending`，请先回填红字发票（d2:988）；`details` 带开票申请 |
| `REFUND_EXCEEDS_REFUNDABLE` | 409 | 金额 > 实收 − 已退 − 在途；`details.refundableFen` |
| `REFUND_TXN_OPEN` | 409 | 名下有未到终态的退款交易（`uq_refund_txn_open`） |
| `REFUND_EXECUTOR_CONFLICT` | 403 | 职责分离开关开启且执行人是审批人 |
| `PLAN_REFUND_NOT_ELIGIBLE` | 409 | `revokeTerm` 守卫不通过（如规则不是 `override` 且复核“未使用”失败）；整个事务回滚，申请留在待执行，由财务作废（d2:977） |
| `CONFIRM_MISMATCH` | 409 | |
| `STEP_UP_REQUIRED` | 403 | |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | 同键请求处理中（可重试） |
| `ACCOUNT_BUSY` | 503 | （m07） |

**副作用**：

事务 E1（加锁：审批单 → 申请 → 付款单 → 收款交易 → `billing_account`，08-billing-payment.md:527）：

- 套餐规则：`billing.revokeTerm`（幂等键 `revoke:subscription_term:{termId}`）：该周期批次 `available → revoked`（处理期间已到期的 `expired → revoked`），`pending` 发放计划 `grant_schedule.status`：`pending → cancelled`；`subscription_term.status`：`active → refunded` / `scheduled → cancelled` / `ended → refunded`（07-billing-ledger.md:542-546）；当前周期被退时有预约周期则提前生效（`scheduled → active`），否则 `billing_account.sub_status`：`active → expired`（从未有过其他生效周期则 `none`）并写 `addon_suspend`；清空退款处理中标记；首次成功写 `refund_request.entitlement_revoked_at`。
- 插入 `refund_txn`（`channel = wechat_jsapi`、`origin = system`、`status = created`、`out_refund_no = {TK 单号}-{序号}-{随机}`）。
- `refund_request.status`：`pending_execution → executing`，写 `exec_route = wechat_original`、`executed_by_staff_id`、`executed_at`、`recheck_log.execute`；取消执行时限定时器。
- 出站事件 `refund.execution_started`、`refund_txn.created`（订阅者 `billing.submitRefundTxn` 在内联提交失败时补提交并登记 `rf.poll`）、`billing.subscription.refunded`、`billing.subscription.rolled_over`（预约周期提前生效时）；审计（`category = refund`）。

事务外：以 `out_refund_no` 调微信退款。

事务 E2（落外调结果，写幂等记录）：微信受理（含同步返回已成功）→ `refund_txn.status`：`created → processing`，登记 `rf.poll` 定时器（首轮立即查询）；超时、网络错误或明确的业务错误 → 保持 `created`，记 `fail_code`、`fail_message`、`submit_count`、`last_submit_at`。本接口不直接把交易记为成功：成功与完成动作（同 3.63 的完成动作）只由退款回调 `hooks.wechatpay.refund.notify` 与 `rf.poll` 执行，`refund.completed`、`billing_order.refunded`、`approval.executed` 也只由它们发出（x01 的发出方登记即如此；08-billing-payment.md:661、669：先落意图再调微信，成功只由“回调、查询、账单”落库）。

**说明**：调微信失败（超时、网络错误、业务错误）不返回错误，只记 `refund_txn.fail_code`，申请保持执行中，由 3.64 重试与轮询处理。执行即回收权益、成功才改付款单状态（d2:944）；权益回收后申请不可作废，原路退最终失败时改走线下（3.63）。

### 3.63 admin.refundRequest.recordOffline　线下退款登记
`POST /admin/refund-requests/{refundRequestId}/record-offline`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.refundRequest.recordOffline`（d2:923） |
| 鉴权 | `staff`；`finance.refund.execute`；职责分离同 3.62 |
| 回显 | 要求 `confirm`：`{ requestNo, amountFen }` |
| 幂等 | required |
| 乐观锁 | 不带 |
| 对应画板 | 线下退款登记（原型无表单，proto-admin-d.md:144；字段与校验比照 admin/FinSettle）；A:Refunds 待执行队列的“线下退款登记”入口 |

**请求**：路径 `refundRequestId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `transferDate` | string(date) | 是 | 不晚于今天 | → `refund_txn.transfer_date` |
| `bankSerialNo` | string | 是 | 1–64 字；规范化后唯一 | → `refund_txn.channel_refund_no` |
| `payeeName` | string | 是 | 1–100 字；对公收款的退款须等于购买主体名称 | → `refund_txn.payee_name` |
| `payeeBank` | string | 是 | 1–100 字 | → `refund_txn.payee_bank` |
| `payeeAccount` | string | 是 | 6–40 位数字 | 加密 → `refund_txn.payee_account_enc`，脱敏 → `refund_txn.payee_account_mask` |
| `receiptFileId` | string(uuid) | 是 | 分类 `pay_receipt`（第 6 节第 7 项：默认必传） | → `refund_txn.receipt_file_id` |
| `note` | string | 微信收款改走线下时必填 | 0–200 字 | → `refund_txn.note` |
| `confirm`、`confirmChecks` | | 是 | `confirmChecks` 1–10 项，必含 `offline_transfer_checked`（“已核对转账回单与收款信息”） | |

**响应**：`RefundRequestDetail`（`status = done`）。

**错误**：`STATE_NOT_ALLOWED`（409）；`REFUND_TXN_OPEN`（409，名下有 `created` / `processing` / `abnormal` 的微信退款，`abnormal` 只能在商户平台处理，不允许改走线下，d2:934）；`RED_INVOICE_REQUIRED`（409）；`REFUND_EXCEEDS_REFUNDABLE`（409）；`PAYEE_NAME_MISMATCH`（400）；`BANK_SERIAL_DUPLICATE`（409，`uq_refund_txn_channel_refund_no`）；`PLAN_REFUND_NOT_ELIGIBLE`（409）；`FILE_NOT_USABLE`（400）；`REFUND_EXECUTOR_CONFLICT`（403）；`CONFIRM_MISMATCH`（409）；`ACCOUNT_BUSY`（503）。

**副作用**（一个事务，08-billing-payment.md:528）：

- 套餐规则：`revokeTerm`（同 3.62；已回收过的按幂等键直接返回）。
- 插入 `refund_txn`（`channel = offline`、`origin = system`、`status = succeeded`、`success_at` = 现在、`registered_by_staff_id` = 本人、`recon_state = matched`）。
- `refund_request.status`：`pending_execution → done`，写 `exec_route = offline`、`executed_*`、`done_at`、`closed_at`；取消执行时限定时器。
- 完成动作（同“退款交易成功”，08-billing-payment.md:531；与 h01 第 3.2 节退款回调的完成动作是同一段代码）：`payment_txn.refunded_fen` 累加；入账收款：`billing_order.refunded_amount_fen` 累加，累计 ≥ 实付则 `billing_order.status`：`paid → refunded`（写 `refunded_at`），该单 `pending` 的开票申请 `invoice_request.status`：`pending → rejected`（写 `rejected_at`、`reject_kind = order_refunded`，不填字典原因与驳回人，08-billing-payment.md:1114），同事务用 `timers.cancel` 取消该开票申请的 `sla.breach:invoice_request:{invoiceRequestId}` 定时器（01-kernel-flow.md:382、608）；差异转入：`payment_exception.status`：`resolving → resolved`（写 `resolved_at`，处理人与说明沿用，08-billing-payment.md:763），同事务刷新 `billing_order.has_open_exception`（08-billing-payment.md:211）。
- 清除被本申请暂停的开票申请标记：`held_by_refund_request_id` = 本申请的 `invoice_request` 行一律置空，含上一步刚被自动驳回的（08-billing-payment.md:1131、1140；与 3.60、3.66 一致）。
- 出站事件 `refund.completed`（通知商家）、`approval.executed`（有执行步的审批进入完成，x01-events-jobs.md:217，关联工单时间线）、`billing_order.refunded`（累计已退 ≥ 实付时）、`invoice.rejected`（有自动驳回时）、`payment_exception.resolved`（差异转入时）、`billing.subscription.refunded`、`billing.subscription.rolled_over`（预约周期提前生效时；x01 的发出方尚未登记本接口，cross_doc）；审计（`category = refund`，账号只记脱敏串）。

### 3.64 admin.refundRequest.retry　同单号重试微信退款
`POST /admin/refund-requests/{refundRequestId}/retry`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.refundRequest.retry`（d2:930） |
| 鉴权 | `staff`；`finance.refund.execute` |
| 回显 | 要求 `confirm`：`{ requestNo, outRefundNo }` |
| 幂等 | required；三段式，先外调（A50、C51）：占用 → 事务外以原 `out_refund_no` 提交微信 → 事务内落结果并写幂等记录 |
| 乐观锁 | 不带 |
| 对应画板 | A:Refunds（执行中、队列标“需处理”的申请；原型未画） |

**请求**：路径 `refundRequestId`。请求体：`confirm`。

**响应**：`RefundRequestDetail`。

**错误**：`STATE_NOT_ALLOWED`（409：申请不是 `executing`，或当前退款交易不是 `created`——`processing` 等回调、`abnormal` 只能在商户平台处理）；`CONFIRM_MISMATCH`（409）；`IDEMPOTENCY_IN_PROGRESS`（409）；`STEP_UP_REQUIRED`（403）。

**副作用**：以原 `out_refund_no` 再次提交微信（`pay-5`：重试必须用原单号）；`refund_txn.submit_count + 1`、`last_submit_at`；结果：受理（含同步返回已成功）→ `refund_txn.status`：`created → processing`，登记 `rf.poll`（首轮立即查询），成功与完成动作由回调与 `rf.poll` 落（同 3.62）；仍失败 → 保持 `created`，覆盖 `fail_code`、`fail_message`（路线图“`created → created`”）。无出站事件。审计（`category = refund`）。

### 3.65 admin.refundRequest.confirmNotAccepted　确认微信未受理
`POST /admin/refund-requests/{refundRequestId}/confirm-not-accepted`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.refundRequest.confirmNotAccepted` |
| 鉴权 | `staff`；`finance.refund.execute` |
| 回显 | 要求 `confirm`：`{ requestNo, outRefundNo }` |
| 幂等 | required；三段式，先外调（A84、C51）：占用 → 事务外按 `out_refund_no` 查询微信 → 事务内落结果并写幂等记录 |
| 乐观锁 | 不带 |
| 对应画板 | A:Refunds（原型未画） |

**请求**：路径 `refundRequestId`。请求体：`confirm`。

**响应**：`RefundRequestDetail`（`status = pending_execution`，可重新执行或改走线下）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 申请不是 `executing`，或当前退款交易不是 `created` |
| `REFUND_NOT_ACCEPTED_UNCONFIRMED` | 409 | 三条守卫不同时成立（08-billing-payment.md:665）：`details.reasons` ∈ `retry_not_halted`（未停止自动重试）、`too_soon`（距最近一次提交不足 10 分钟）、`exists_on_channel`（查询到该退款单） |
| `PROVIDER_UNAVAILABLE`、`UPSTREAM_TIMEOUT` | 503、504 | 查询微信失败，可重试 |
| `CONFIRM_MISMATCH` | 409 | |
| `STEP_UP_REQUIRED` | 403 | |

**副作用**（事务）：`refund_txn.status`：`created → not_accepted`；`refund_request.status`：`executing → pending_execution`，写 `exec_error`；执行时限不重新计时；出站事件 `refund.execution_failed`；审计（`category = refund`）。权益可能已回收，此后不可作废，须重新执行（新 `out_refund_no`）或改走线下。

**说明**：若之后仍收到该退款单的成功回调（申请已回到 `pending_execution`），照常记成功：`refund_txn` 记 `is_late_success`，申请 `pending_execution → done`（A102，由回调触发，08-billing-payment.md:529），完成动作同 3.63；申请已是 `done`，再执行或线下登记由 3.62、3.63 的状态守卫拦下（`STATE_NOT_ALLOWED`）。

### 3.66 admin.refundRequest.void　作废已批准未执行的申请
`POST /admin/refund-requests/{refundRequestId}/void`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.refundRequest.void`（草案 `/refunds/{no}/cancel`；A9 用 `void`） |
| 鉴权 | `staff`；`finance.refund.approve`（注册表标了再验证） |
| 回显 | 要求 `confirm`：`{ requestNo, amountFen }` |
| 幂等 | required |
| 乐观锁 | 不带 |
| 对应画板 | A:Refunds（原型未画） |

**请求**：路径 `refundRequestId`。请求体：`note`（1–200 字，必填 → `refund_request.close_note`）、`confirm`。

**响应**：`RefundRequestDetail`（`status = not_executed`、`closeReason = voided`）。

**错误**：`STATE_NOT_ALLOWED`（409，不是 `pending_execution`）；`REFUND_ALREADY_REVOKED`（409，`entitlement_revoked_at` 非空）；`REFUND_TXN_OPEN`（409，名下有成功或未到终态的退款交易）；`CONFIRM_MISMATCH`（409）；`STEP_UP_REQUIRED`（403）。

**副作用**（一个事务，08-billing-payment.md:530）：

- `refund_request.status`：`pending_execution → not_executed`（`close_reason = voided`），写 `voided_by_staff_id`、`close_note`、`closed_at`；审批单保持 `approved`。
- 套餐规则：`resumeTermFromRefund`（同 3.60）。
- 开票：`red_pending` 的开票申请 `invoice_request.status`：`red_pending → issued`（红票已回填的保持 `red_issued`）；清除 `held_by_refund_request_id`。
- 差异转入：`payment_exception.status`：`resolving → open`。
- 取消执行时限定时器。
- 出站事件 `refund.voided`、`invoice.red_cancelled`（有恢复时）、`billing.subscription.refund_resumed`、`payment_exception.reopened`；审计（`category = refund`）。

### 3.67 admin.invoiceRequest.list　开票申请队列
`GET /admin/invoice-requests`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.invoiceRequest.list` |
| 鉴权 | `staff`；模块 `finance` ≥ v；数据范围 `global`（处理队列） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Invoices 左栏队列；红字发票（原型无） |

**请求**：查询参数（结构名 `AdminInvoiceRequestListQuery`；与 m07 的 `InvoiceRequestListQuery` 不同构，A132 加 `Admin` 前缀）：`tab`（`pending` 待开票 / `red_pending` 待红冲 / `processed` 已处理（`issued`、`rejected`、`red_issued`），默认 `pending`）、`q`（`KP` / `FK` 单号、商家）、`invoiceType`、`medium`、`page`、`pageSize`。排序：`pending` 按 `applied_at` 升序；其余 `-updatedAt`。

**响应**：`AdminPage<InvoiceRequestAdminRow>`（a01 2.1）。

**错误**：无。**副作用**：无。

**说明**：队列页每 30 秒静默刷新计数（d7:1052），用 3.68。

### 3.68 admin.invoiceRequest.summary　开票页签计数与 KPI
`GET /admin/invoice-requests/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.invoiceRequest.summary` |
| 鉴权 | `staff`；模块 `finance` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Invoices 页头 KPI（待开票金额与张数、本月已开票）与页签计数 |

**请求**：查询参数 `q`、`invoiceType`、`medium`（同 3.67，不含 `tab`、分页）。

**响应**（`AdminInvoiceRequestSummary`；与 m07 的 `InvoiceRequestSummary` 不同构，A132 加 `Admin` 前缀）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `pending`、`red_pending`、`processed` | integer | 是 | 页签计数 | `invoice_request.status` |
| `pendingAmountFen` | string(bigint) | 是 | 待开票金额 | `invoice_request.amount_fen`（`status = pending`）之和 |
| `issuedThisMonth` | object | 是 | 本月已开票 `{ amountFen: string(bigint), count }` | `invoice_doc`（`doc_kind = blue`、`issued_at` 在本月） |

**错误**：无。**副作用**：无。

### 3.69 admin.invoiceRequest.get　开票申请详情
`GET /admin/invoice-requests/{invoiceRequestId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.invoiceRequest.get` |
| 鉴权 | `staff`；模块 `finance` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Invoices 右栏（付款单、抬头与税号脱敏、专票信息、接收方式、开票前核对清单、开具表单） |

**请求**：路径 `invoiceRequestId`。

**响应**：`InvoiceRequestAdminDetail`。抬头税号等只回脱敏值，明文走 a01 `admin.piiReveal.create`；已开具的发票文件用 `docs[].fileId` 调 a01 `admin.file.downloadUrls`（OFD 只下载、不预览）。

**错误**：无。**副作用**：无。

### 3.70 admin.invoiceRequest.issue　开具发票
`POST /admin/invoice-requests/{invoiceRequestId}/issue`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.invoiceRequest.issue` |
| 鉴权 | `staff`；`finance.invoice.issue`（财务） |
| 回显 | 要求 `confirm`：`{ requestNo, amountFen }` |
| 幂等 | required |
| 乐观锁 | 不带（`invoice_request` 状态机的守卫没有列锁版本；开具与发起、执行退款三个事务都先锁付款单行，严格串行） |
| 对应画板 | A:Invoices 开具表单（电子：号码 + PDF / OFD；纸质：号码 + 快递公司 + 运单号） |

**请求**：路径 `invoiceRequestId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `invoiceNo` | string | 是 | 按介质校验（参数 `invoice.no_rules`：电子 20 位数字；纸质 20 位数字或 8 位号码配代码） | → `invoice_doc.invoice_no` |
| `invoiceCode` | string \| null | 否 | 10 或 12 位；数电发票为 null | → `invoice_doc.invoice_code` |
| `fileId` | string(uuid) | 电子必填 | 分类 `invoice`，PDF 或 OFD | → `invoice_doc.file_id`、`file_format` |
| `expressCompanyCode` | string | 纸质必填 | 字典 `express_company` 的编码 | → `invoice_doc.express_company` |
| `trackingNo` | string | 纸质必填 | 1–20 字 | → `invoice_doc.tracking_no` |
| `confirm` | object | 是 | 见上 | |

**响应**：`InvoiceRequestAdminDetail`（`status = issued`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 开票申请不是 `pending` |
| `INVOICE_ISSUE_BLOCKED` | 409 | 先锁付款单行再现查不满足：已不是已支付、已退金额不为 0、有在途的入账收款退款申请（08-billing-payment.md:1111）；`details.reasons` ∈ `not_paid`、`refunded`、`refund_in_flight` |
| `INVOICE_NO_TAKEN` | 409 | 发票代码与号码已被使用（`uq_invoice_doc_code_no`） |
| `FILE_NOT_USABLE` | 400 | （m03） |
| `CONFIRM_MISMATCH` | 409 | |

**副作用**（一个事务）：插入 `invoice_doc`（`doc_kind = blue`、`amount_fen` = 开票金额、`issued_by_staff_id` = 本人、`issued_at` = 现在；纸质另写 `shipped_at`）；`invoice_request.status`：`pending → issued`（08-billing-payment.md:1111-1112）；电子且有接收邮箱：`invoice_doc.email_state`：`none → queued`（未配置邮件驱动为 `skipped`）；取消 `sla.breach` 定时器（如有）；出站事件 `invoice.issued`（通知商家，电子发票经通知中心发邮件，R14）；审计（`category = invoice`）。

### 3.71 admin.invoiceRequest.reject　驳回开票申请
`POST /admin/invoice-requests/{invoiceRequestId}/reject`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.invoiceRequest.reject`（d4 并入 `finance.invoice.issue`；草案 `invoice.reject`） |
| 鉴权 | `staff`；`finance.invoice.issue` |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 不带 |
| 对应画板 | A:Invoices 驳回弹层（原因单选 + 说明必填 ≤200 字；“驳回后商家可补正信息重新申请；抬头不可修改”） |

**请求**：路径 `invoiceRequestId`。请求体：`reasonCode`（字典 `reject_reason` 场景 `invoice`：开票信息有误、重复申请、其他；原型的“付款单已退款或退款中”由系统自动驳回表达，M55）、`note`（1–200 字）。

**响应**：`InvoiceRequestAdminDetail`（`status = rejected`）。

**错误**：`STATE_NOT_ALLOWED`（409，不是 `pending`）。

**副作用**：`invoice_request.status`：`pending → rejected`（`reject_kind = manual`，写 `reject_reason_code`、`reject_note`、`rejected_by_staff_id`、`rejected_at`）；取消 `sla.breach` 定时器；出站事件 `invoice.rejected`（通知商家）；审计（`category = invoice`）。商家可重新申请（新申请单）。

### 3.72 admin.invoiceRequest.issueRed　回填红字发票
`POST /admin/invoice-requests/{invoiceRequestId}/issue-red`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.invoiceRequest.issueRed`（草案 `/invoice-requests/{no}/red`） |
| 鉴权 | `staff`；`finance.invoice.red`（财务） |
| 回显 | 要求 `confirm`：`{ requestNo, blueInvoiceNo, amountFen }` |
| 幂等 | required |
| 乐观锁 | 不带 |
| 对应画板 | 红字发票（原型只有提示文案，proto-admin-d.md:240）；A:Invoices“待红冲”；A:Refunds |

**请求**：路径 `invoiceRequestId`。请求体：`invoiceNo`（红字发票号码）、`invoiceCode`（可空）、`fileId`（分类 `invoice`，PDF / OFD / XML）、`redReason`（0–100 字）、`confirm`。

**响应**：`InvoiceRequestAdminDetail`（`status = red_issued`）。

**错误**：`STATE_NOT_ALLOWED`（409，不是 `red_pending`）；`INVOICE_NO_TAKEN`（409）；`FILE_NOT_USABLE`（400）；`CONFIRM_MISMATCH`（409）。

**副作用**：插入 `invoice_doc`（`doc_kind = red`、`amount_fen` = 蓝字金额的相反数、`original_invoice_doc_id` = 蓝字票据）；`invoice_request.status`：`red_pending → red_issued`（08-billing-payment.md:1116）；出站事件 `invoice.red_issued`；审计（`category = invoice`）。之后该付款单的退款执行不再被 `RED_INVOICE_REQUIRED` 拦下。

**说明**：数电发票已被对方用途确认或入账的，红冲须对方确认《红字发票信息确认单》，这一步在系统外完成，系统只记录结果（d2:997）。

### 3.73 admin.invoiceRequest.resend　重发电子发票邮件
`POST /admin/invoice-requests/{invoiceRequestId}/resend`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.invoiceRequest.resend`（A9：`resend-email` 改 `resend`） |
| 鉴权 | `staff`；`finance.invoice.issue` |
| 回显 | 无 |
| 幂等 | required（实际发邮件，A17） |
| 乐观锁 | 无 |
| 对应画板 | A:Invoices（原型未画；蓝字票据邮件“发送失败”时显示“重发”） |

**请求**：路径 `invoiceRequestId`。请求体无（重发蓝字票据的邮件）。

**响应**：`InvoiceRequestAdminDetail`。

**错误**：`STATE_NOT_ALLOWED`（409：没有蓝字电子票据、没有接收邮箱，或邮件状态不是 `failed`）。

**副作用**：`invoice_doc.email_state`：`failed → queued`（08-billing-payment.md:1217）；调通知中心 `notify.resend`（业务对象类型 `invoice_doc`），新增一条 `notification_delivery`（`resend_no` + 1）；结果由 `notify.mail_delivered` / `notify.mail_failed` 回写；审计（`category = invoice`）。本模块不直接调邮件驱动（R14）。

### 3.74 admin.reconciliation.list　按月对账
`GET /admin/reconciliations`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.reconciliation.list`（草案 `/finance/reconciliations?month=`） |
| 鉴权 | `staff`；模块 `finance` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Reconcile（月度概览、差异告警区、每日对账表、表尾统计） |

**请求**：查询参数 `month`（`YYYY-MM`，必填；不得晚于本月）。

**响应**：`ReconMonth`（2.16）：`{ items: ReconDayRow[], month, overview, dayStatusCounts, openExceptions, prevMonthAllOk }`。日行是 A78 的有界小集合（C43 已登记本接口），放在 `items`、不分页、不带分页字段；月度概览等是并列的上下文字段。

**错误**：无（`month` 晚于本月为 `VALIDATION_FAILED`）。**副作用**：无。

**说明**：对账明细导出走 a02（`exportKey = reconciliations.detail`，`ReconExportParams`：按日或按月、内容多选，见 2.19）。

### 3.75 admin.reconciliation.rerun　重新对账
`POST /admin/reconciliations/{reconciliationId}/rerun`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.reconciliation.rerun`（草案按日期 `{date}` 取；A4 改 `recon_day` 的 id） |
| 鉴权 | `staff`；`finance.recon.resolve`（A46 标再验证） |
| 回显 | 要求 `confirm`：`{ billDate }` |
| 幂等 | required |
| 乐观锁 | 无（整个对账按账单日幂等，事务级咨询锁串行化） |
| 对应画板 | A:Reconcile（原型未画；有差异或账单补到时在日行上给“重新对账”） |

**请求**：路径 `reconciliationId`（`recon_day.id`，微信渠道行）。请求体：`confirm`。

**响应**：`ReconDayRow`（重跑后的当日行）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 不是微信渠道的日行（对公不对外部账单） |
| `RECON_BILL_NOT_READY` | 409 | 该账单日的交易账单不是 `parsed`（未下载、下载失败或当日无账单）；`details.billFileStatus`。账单下载由周期任务 `bill.download` 负责（含失败重试），不经本接口 |
| `CONFIRM_MISMATCH` | 409 | |

**副作用**（同步执行匹配步骤，d2:1056-1082）：重写该日 `wx_bill_line.match_state`；按差异单 `dedupe_key` 开新的差异单（`payment_exception.status`：（新建）→ `open` 或 `auto_healed`），`platform_only` 在账单补到后 `open → auto_healed`；更新 `payment_txn.recon_state`、`payment_txn.fee_fen` 回填与 `refund_txn.recon_state`；`recon_day` 重算汇总与 `status`，`run_count + 1`、`last_run_at`；出站事件 `payment_exception.opened`（新开时）、`payment_exception.auto_healed`（自愈时）、`recon.day_closed`（x01 这两个差异单事件的发出方还没有登记本接口，cross_doc）；审计（`category = recon`）。

### 3.76 admin.paymentException.list　差异单列表
`GET /admin/payment-exceptions`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.paymentException.list` |
| 鉴权 | `staff`；模块 `finance` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Reconcile 差异明细；工作台“对账差异”跳转 |

**请求**：查询参数：`tab`（`PaymentExceptionTab`：`open` 待处理（`status = open`，与工作台 ⑰ 同一计数函数，2.19）/ `resolving` 已转退款、等退款完成 / `resolved`（`resolved` 与 `auto_healed`）/ `all`，默认 `open`）、`kind`（可多值）、`billDateFrom` / `billDateTo`（date）、`q`（`CY` / `FK` 单号、交易单号、商家）、`page`、`pageSize`。排序 `-billDate`、`-createdAt`。

**响应**：`AdminPage<PaymentExceptionRow>`（a01 2.1）。

**错误**：无。**副作用**：无。

### 3.77 admin.paymentException.get　差异单详情
`GET /admin/payment-exceptions/{paymentExceptionId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.paymentException.get` |
| 鉴权 | `staff`；模块 `finance` ≥ v |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Reconcile 处理弹层（账单侧与平台侧事实、差异原因、可选处理方式） |

**请求**：路径 `paymentExceptionId`。

**响应**：`PaymentExceptionDetail`。

**错误**：无。**副作用**：无。

### 3.78 admin.paymentException.create　登记异常到账
`POST /admin/payment-exceptions`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.paymentException.create`（d2:1475 `POST /finance/exceptions`） |
| 鉴权 | `staff`；`finance.recon.resolve`（A46 标再验证） |
| 回显 | 要求 `confirm`：`{ amountFen, bankSerialNo }` |
| 幂等 | required |
| 乐观锁 | 无（新建） |
| 对应画板 | A:Reconcile（原型未画；对公到账找不到付款单、或到账金额与应付不符时登记） |

**请求体**：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `receivedAt` | string(date-time) | 是 | 不晚于现在 | 到账时间 → `payment_txn.channel_success_at` |
| `amountFen` | integer(分) | 是 | > 0 | → `payment_txn.amount_fen`、`channel_amount_fen`；`payment_exception.amount_fen` |
| `payerName` | string | 是 | 1–100 字 | 付款户名 → `payment_txn.channel_payer_ref` |
| `bankSerialNo` | string | 是 | 1–64 字 | 原文 → `payment_txn.bank_serial_raw`，规范化 → `channel_txn_no` |
| `payerBankCode` | string | 否 | 字典 `bank` 的编码；流水号冲突时必填 | → `payment_txn.payer_bank` |
| `note` | string | 是 | 1–200 字 | → `payment_exception.platform_fact.text` 与审计 |
| `confirm` | object | 是 | 见上 | |

**响应**：`PaymentExceptionDetail`（`kind = bank_unmatched`、`status = open`）。

**错误**：`BANK_SERIAL_DUPLICATE`（409）；`CONFIRM_MISMATCH`（409）；`STEP_UP_REQUIRED`（403）。

**副作用**（一个事务，08-billing-payment.md:760、319）：

- 插入孤儿收款 `payment_txn`（`billing_order_id`、`entity_id` 为空；`channel = bank_transfer`；`status = succeeded`；`attempt_no = 1`；`out_trade_no = {CY 单号}-01-{随机}`；`confirmed_by_staff_id` = 本人；`recon_state = diff`）。
- `payment_exception.status`：（新建）→ `open`：`kind = bank_unmatched`、`detected_by = manual`、`bill_date` = 到账日、`payment_txn_id`、`dedupe_key = bank_unmatched:{规范化流水号}`、`exception_no` 由 `biz_sequence` 取号。
- 出站事件 `payment_exception.opened`（通知财务）；审计（`category = recon`）。

**说明**：之后按 3.79 选择“关联到付款单并确认”或“线下退回”。

### 3.79 admin.paymentException.resolve　处理差异
`POST /admin/payment-exceptions/{paymentExceptionId}/resolve`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.paymentException.resolve`（d2:1475） |
| 鉴权 | `staff`；`finance.recon.resolve`（A46 标再验证）；`resolution = written_off` 时处理器另要求 `sys.super_admin`（A45），不足 403 `PERMISSION_DENIED` |
| 回显 | 要求 `confirm`：`{ exceptionNo, amountFen }` |
| 幂等 | required；三段式，先外调（A84、C51）：`restore`、`record_channel_refund` 先占用、事务外查微信，再开事务落结果并写幂等记录；其余处理方式不外调，直接一个事务 |
| 乐观锁 | 带差异单 `lockVersion`（人工处理带锁版本，08-billing-payment.md:798） |
| 对应画板 | A:Reconcile 处理弹层（处理方式单选 + 说明必填 ≤200 字） |

**请求**：路径 `paymentExceptionId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `lockVersion` | integer | 是 | | |
| `resolution` | enum | 是 | 同数据模型 `payment_exception.resolution`（不含 `none`）；须在该类型的可选处理内（第 4.3 节） | → `payment_exception.resolution` |
| `note` | string | 是 | 1–200 字 | → `payment_exception.resolution_note` |
| `linkPaymentOrderId` | string(uuid) | `link_order` 必填 | 同主体、对公、待支付或待确认且不在复核、金额相等 | 关联的付款单 |
| `offlineReturn` | object | `offline_return` 必填 | `{ transferDate, bankSerialNo, payeeName, payeeBank, payeeAccount, receiptFileId }`，约束同 3.63 | 线下退回登记 |
| `confirm` | object | 是 | 见上 | |

**响应**：`PaymentExceptionDetail`，另加 `outcome`：`resolved` / `refund_requested`（转退款）/ `still_blocked`（重试履约仍受阻，差异单保持 `open`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 差异单不是 `open`（`resolving` 等退款申请完成） |
| `RESOLUTION_NOT_ALLOWED` | 409 | 该类型不允许这种处理；`details.allowed` |
| `VERSION_CONFLICT` | 409 | |
| `CHANNEL_RECHECK_FAILED` | 409 | `restore`：实时查单不是成功或金额不相等；`record_channel_refund`：按账单行的 `out_refund_no` 查询不是成功或金额不符；`details.channelState`、`details.channelAmountFen` |
| `LINK_ORDER_INVALID` | 409 | 所选付款单不满足关联条件；`details.reasons` |
| `REFUND_REQUEST_EXISTS` | 409 | 转退款时该笔收款已有在途申请 |
| `BANK_SERIAL_DUPLICATE` | 409 | 线下退回的流水号已入库 |
| `PAYEE_NAME_MISMATCH` | 400 | |
| `CONFIRM_MISMATCH` | 409 | |
| `PROVIDER_UNAVAILABLE`、`UPSTREAM_TIMEOUT` | 503、504 | 查询微信失败 |
| `ACCOUNT_BUSY` | 503 | （m07） |

**副作用**（按处理方式；均同事务写审计，08-billing-payment.md:758-782）：

| `resolution` | 状态迁移与写入 | 出站事件 |
| --- | --- | --- |
| `refund` | `payment_exception.status`：`open → resolving`（写处理方式、说明、处理人）；`approval_request.status`：（新建）→ `pending`（`kind = plan_refund`，对象为付款单，孤儿收款为 `payment_txn`，`requester_staff_id` = 本人；决定时限同 3.55：写 `due_at`、`sla_snapshot`，登记 `sla.breach:approval_request:{approvalRequestId}:decision`）；`refund_request.status`：（新建）→ `pending_approval`（`source = exception`，规则 `unapplied_receipt` 或 `fulfillment_blocked`，金额 = 未退余额或全额；`reason_code` 为空——`ck_refund_request_reason` 要求差异转入不填原因，原因即差异单本身，处理说明只进 `payment_exception.resolution_note` 与审计）；审计 `category = refund` | `payment_exception.refund_requested`、`approval.submitted`、`refund.submitted` |
| `retried` | 仅 `fulfillment_blocked`：再调 `fulfill()`；返回 `done` 时 `billing_order.fulfillment_status`：`blocked → done`（只写审计），`payment_exception.status`：`open → resolved`；仍受阻时只覆盖 `fulfillment_result` | `payment_exception.resolved`、`billing.order_fulfilled` 及 `fulfill()` 的履约事件（同 3.48） |
| `restore` | 实时查单成功后：`billing_order.status`：`cancelled → paid`（08-billing-payment.md:176，起算 = 补单时刻），未入账收款入账，`fulfill()`；`payment_exception.status`：`open → resolved` | `billing_order.paid`、`payment_exception.resolved`、`fulfill()` 的履约事件（同 3.48；受阻时 `billing_order.fulfillment_blocked`、`payment_exception.opened`） |
| `rebuild_order` | `bill_only` 且无付款单：按收款的 `attach` 重建付款单 `billing_order.status`：（新建）→ `paid`（`source = weapp`、`created_by_staff_id` = 本人、`rebuilt_from` = 原商户单号，仅开通、续费、加购且金额与价目一致，d2:1108），孤儿收款关联并入账、`fulfill()`；`payment_exception.status`：`open → resolved` | `billing_order.created`（x01 的发出方尚未登记本接口，cross_doc）、`billing_order.paid`、`payment_exception.resolved`、`fulfill()` 的履约事件 |
| `link_order` | 孤儿收款补写 `payment_txn.billing_order_id`、`entity_id` 并入账：`billing_order.status`：`pending_payment` / `pending_confirmation` → `paid`（08-billing-payment.md:174）；该单 `pending` 的凭证 `transfer_proof.review_status`：`pending → accepted`（结论人 = 本人，交易的 `transfer_proof_id` 指向它），取消其 `sla.breach` 定时器；`fulfill()`；`payment_exception.status`：`open → resolved` | `billing_order.paid`、`payment_exception.resolved`、`fulfill()` 的履约事件 |
| `offline_return` | 插入 `refund_txn`（`channel = offline`、`status = succeeded`、`refund_request_id` 为空、`out_refund_no = {CY 单号}-{序号}-{随机}`）；`payment_txn.refunded_fen` 累加；`payment_exception.status`：`open → resolved` | `payment_exception.resolved` |
| `record_channel_refund` | 仅 `refund_bill_only`：查询确认后插入 `refund_txn`（`origin = external`、`status = succeeded`）；累加已退，累计 ≥ 实付则 `billing_order.status`：`paid → refunded`；已开具的开票申请 `invoice_request.status`：`issued → red_pending`。套餐类付款单按 08-billing-payment.md:780：周期**不在**退款处理中（`subscription_term.refund_request_id` 为空）时调 `revokeTermForExternalRefund`（不经闸门，规则按 `override`，`ledger_operation.ref_type = payment_exception`，M100；作废方式同 3.62 的 `revokeTerm`，预约周期可能提前生效），返回的 `unrecoveredPoints` 大于 0 时另开 `payment_exception.status`：（新建）→ `open`（`kind = entitlement_unrecovered`）；周期**正挂在**某张退款申请的闸门上，或回收守卫不通过时，不回收，另开 `entitlement_unrecovered`，那张在途申请不在本事务里处理（它之后执行时会被可退余额守卫 `REFUND_EXCEEDS_REFUNDABLE` 拦下，由财务作废或驳回）。本单 `open → resolved` | `billing_order.refunded`（累计 ≥ 实付时；x01 的发出方尚未登记本接口，cross_doc）、`invoice.red_requested`、`billing.subscription.refunded`、`billing.subscription.rolled_over`（预约周期提前生效时）、`payment_exception.resolved`、`payment_exception.opened`（另开 `entitlement_unrecovered` 时；同上 cross_doc） |
| `corrected`、`written_off` | 只记结论：`payment_exception.status`：`open → resolved`（数据更正由研发按运维手册执行，更正前后值写审计；核销仅超级管理员，d2:1117） | `payment_exception.resolved` |

`resolved` 时同事务刷新 `billing_order.has_open_exception` 与 `payment_txn.recon_state`（`diff → resolved`）。审计 `category` 除转退款为 `refund` 外都取 `recon`（2.0）。

**说明**：

- 原型把差异的“原路退款”画成财务一步完成，与“退款须审批”冲突；按 03-key-designs.md:108 改为生成退款申请走审批（d2:1127）。差异退款计入“本月退款”。
- 补记渠道退款遇到“周期挂在退款申请闸门上”：07-billing-ledger.md:556、562、1553 写 `revokeTermForExternalRefund` 一并收口并把该申请 id 交给 08 同事务处理，而 08-billing-payment.md:780 写“不回收、另开 `entitlement_unrecovered`”，且 08 的退款申请状态机没有对应的关闭迁移。A156 已定按 08（`refund_request` 与 `payment_exception` 的归属分组）处理，与本文写法一致：不回收、另开 `entitlement_unrecovered`；07 分组 `revokeTermForExternalRefund` 改为遇闸门不回收、返回 `heldByRefundRequestId`，由 07 分组随后回写。

### 3.80 admin.financeConfigRevision.list　受控财务配置
`GET /admin/finance-config-revisions`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.financeConfigRevision.list`（原 `a07.finance-configs.list` 并入，A5：读的是本表，按 `tab` 区分） |
| 鉴权 | `staff`；模块 `finance` ≥ v（查看类不设权限点，C66） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | 受控财务配置（原型无）；“我的待审批”里 `finance_config_change` 的领域详情（a01 第 2.10 节 `operations.get` 指向本接口，带 `financeConfigRevisionId`） |

**请求**：查询参数：`tab`（`current`：三个键各自的生效版本、已批准待生效版本、待批准提议，不分页；`history`：全部版本，分页）、`configKey`（可选）、`financeConfigRevisionId`（可选，只返回这一版；与 `tab = history` 合用，从“我的待审批”跳来时用）、`page`、`pageSize`（`history` 用）。

**响应**：`FinanceConfigRevisionList`，按 `tab` 二选一（oneOf）：`tab = current` 为 `{ items: FinanceConfigRevisionView[] }`（A78 的有界小集合，C43 已登记，不带分页字段）；`tab = history` 为 `AdminPage<FinanceConfigRevisionView>`（a01 2.1，C43）。

**错误**：无。**副作用**：无。

**说明**：对公收款账号只给脱敏串；明文经 a01 `admin.piiReveal.create`（`pii.bank.reveal`）。

### 3.81 admin.financeConfigRevision.create　提议变更受控配置
`POST /admin/finance-config-revisions`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.financeConfigRevision.create`（d2:1476 `POST /finance/config/{key}/proposals`） |
| 鉴权 | `staff`；`finance.config.propose`（增补：默认财务、超级管理员，要再验证，d2:1446） |
| 回显 | 要求 `confirm`：`{ configKey, baseRevisionId }`（提议所基于的当前生效版本；没有为 null），与此刻生效版本不一致 409 `CONFIRM_MISMATCH` |
| 幂等 | required；`Idempotency-Key` 写入 `approval_request.idempotency_key` |
| 乐观锁 | 无（新建；同一键同时只允许一张待审） |
| 对应画板 | 受控财务配置（原型无） |

**请求体**：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `configKey` | enum | 是 | `bank_account` / `purchase_policy` / `controls` | → `finance_config_revision.config_key` |
| `payload` | object | 是 | 按键校验（08-billing-payment.md:1491-1497）：`bank_account` 为 `{ accountName, bankName, accountNo }`（`accountNo` 明文只在请求里出现）；`purchase_policy` 为 `{ rules }`；`controls` 为完整的五个键 | → `finance_config_revision.payload`；账号加密 → `account_no_enc`，脱敏 → `account_no_mask`，`payload` 只放脱敏值 |
| `changeNote` | string | 是 | 1–200 字，非空白 | → `finance_config_revision.change_note` |
| `confirm` | object | 是 | 见上 | |

**响应**：`FinanceConfigRevisionView`（`state = pending`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `APPROVAL_ALREADY_PENDING` | 409 | 该键已有一张待审（`dedupe_key = finance_config_change:{configKey}`；a03） |
| `CHANGESET_EMPTY` | 400 | 与当前生效版本相同 |
| `CONFIRM_MISMATCH` | 409 | 基于的版本已不是当前生效版本 |
| `STEP_UP_REQUIRED` | 403 | |

**副作用**（一个事务，08-billing-payment.md:1279）：插入 `finance_config_revision`（`effective_at` 为空）；`approval_request.status`：（新建）→ `pending`（`kind = finance_config_change`、`subject_type = finance_config_revision`、`entity_id` 与 `store_id` 为空、`dedupe_key = finance_config_change:{configKey}`；不设决定时限，A93）；出站事件 `finance_config.proposed`（通知全体财务与超级管理员：企业微信应用消息与站内）、`approval.submitted`；审计（`category = finance_config`，账号只记脱敏串）。

### 3.82 admin.financeConfigRevision.approve　批准受控配置变更
`POST /admin/finance-config-revisions/{financeConfigRevisionId}/approve`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.financeConfigRevision.approve`（A14；原 `a01.approvals.approve` 的 `kind = finance_config_change`） |
| 鉴权 | `staff`；`finance.config.approve`（增补：默认财务、超级管理员，要再验证）；提议人不得是批准人 |
| 回显 | 要求 `confirm`：`{ configKey, financeConfigRevisionId }`；`bank_account` 另带 `accountNoLast4`（与新账号后 4 位比对） |
| 幂等 | required |
| 乐观锁 | 带审批单的 `lockVersion` |
| 对应画板 | 受控财务配置；我的待审批 |

**请求**：路径 `financeConfigRevisionId`。请求体 `ApproveBody`，`confirmChecks` 必含 `change_reviewed`（“已核对变更前后的值”；收款账户另核对新账号后 4 位，见回显）。

**响应**：`FinanceConfigRevisionView`（`state` 为 `scheduled`（收款账户）或 `effective`）。

**错误**：`APPROVAL_NOT_PENDING`（409）；`APPROVAL_SELF_FORBIDDEN`（403）；`VERSION_CONFLICT`（409）；`CONFIRM_MISMATCH`（409）；`STEP_UP_REQUIRED`（403）。

**副作用**（一个事务）：`approval_request.status`：`pending → approved`；写一次 `finance_config_revision.effective_at`：`bank_account` = 批准时刻 + 24 小时（代码常量），其余 = 批准时刻（08-billing-payment.md:1280）；出站事件 `approval.approved`、`finance_config.approved`（通知全体财务与超级管理员）；审计（`category = finance_config`）。

**说明**：生效后：购买入口策略与内控开关立即被下一次报价、建单读到；新收款账户只用于之后创建的对公付款单，已创建的付款单仍指向创建时的版本（`payment.I12`）。

### 3.83 admin.financeConfigRevision.reject　驳回受控配置变更
`POST /admin/finance-config-revisions/{financeConfigRevisionId}/reject`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.financeConfigRevision.reject`（A14） |
| 鉴权 | `staff`；`finance.config.approve`（驳回不要求再验证，见回显栏）；提议人不得是驳回人 |
| 回显 | 无；路由标 `x-step-up: skip`（C86 登记，A127：驳回不要求再验证，维持 03-staff-authz-audit.md:806） |
| 幂等 | required |
| 乐观锁 | 不带 |
| 对应画板 | 受控财务配置；我的待审批 |

**请求**：路径 `financeConfigRevisionId`。请求体 `RejectBody`（`reasonCodes` 不传：字典 `reject_reason` 没有受控配置场景，驳回说明写 `note`）。

**响应**：`FinanceConfigRevisionView`（`state = rejected`）。

**错误**：`APPROVAL_NOT_PENDING`（409）；`APPROVAL_SELF_FORBIDDEN`（403）。

**副作用**：`approval_request.status`：`pending → rejected`；`finance_config_revision` 不改（`effective_at` 保持为空）；出站事件 `approval.rejected`；审计（`category = finance_config`）。

### 3.84 admin.financeConfigRevision.withdraw　撤回受控配置提议
`POST /admin/finance-config-revisions/{financeConfigRevisionId}/withdraw`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.financeConfigRevision.withdraw`（A14、A15） |
| 鉴权 | `staff`；`permission: assert-in-handler`：提议人本人；提议人已不是启用状态时由 `finance.config.approve` 持有人代撤 |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 不带 |
| 对应画板 | 受控财务配置 |

**请求**：路径 `financeConfigRevisionId`。请求体 `WithdrawBody`。

**响应**：`FinanceConfigRevisionView`（`state = withdrawn`）。

**错误**：`APPROVAL_NOT_PENDING`（409）；`APPROVAL_WITHDRAW_FORBIDDEN`（403）；`STEP_UP_REQUIRED`（403，代撤时：处理器取到的决定权限点在注册表里标了再验证，同样校验，C66、C67）。

**副作用**：`approval_request.status`：`pending → withdrawn`；出站事件 `approval.withdrawn`；审计（`category = finance_config`）。

### 3.85 admin.plan.update　改套餐版本名称
`PATCH /admin/plans/{planId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.plan.update`（第二轮新增：PRD:765“维护版本名称”；数据模型允许原地改 `plan.name`，07-billing-ledger.md:91） |
| 鉴权 | `staff`；`billing.plan.edit` |
| 回显 | 无 |
| 幂等 | required（带 `lockVersion` 的 PATCH，A17） |
| 乐观锁 | 带 `lockVersion`（`plan.lock_version`，内容编辑，A21） |
| 对应画板 | A:Plans 列头“编辑”里的版本名称（原型编辑弹窗没有名称输入，proto-admin-c.md:159；与 3.6 同一个弹窗，名称变了才调本接口） |

**请求**：路径 `planId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `lockVersion` | integer | 是 | | `PlanAdminColumn.lockVersion` |
| `name` | string | 是 | 1–20 字，去首尾空白 | → `plan.name` |

只允许改名称：`code`、`rank` 创建后不改（升降级比较与价目链依赖它们），上下架走 3.4、3.5，价格与权益走 3.6。

**响应**：`PlanAdminColumn`。

**错误**：`VERSION_CONFLICT`（409）；`CHANGESET_EMPTY`（400，名称与当前相同）。

**副作用**：`plan.name` 更新，`plan.lock_version + 1`；审计 `billing.plan.update`（`category = plan_config`，`before` / `after`）。无状态迁移、无出站事件、无定时器。

**说明**：名称不进价目修订、不需要公告；已创建的付款单按内容快照展示原名称（`billing_order.content_snapshot`），其余读 `plan.name` 的地方（本文列表、报价、订阅周期的版本名、商家端 `m.plan.list`）显示新名称。

## 4. 枚举

### 4.1 本文用到的枚举

| 名称 | 取值与含义 | 备注 |
| --- | --- | --- |
| 套餐版本可见范围 | 同数据模型 `plan.scope` | V1.0 只写 `public` |
| 制作模型、制作排期 | 同数据模型 `plan_revision.production_model`、`plan_revision.schedule_priority` | |
| `PlanRevisionStatus` | `pending` 待生效；`effective` 当前生效；`superseded` 已被取代；`cancelled` 已撤销 | 接口枚举，由时间与 `cancelled_at` 现算；参数行同用 |
| `PlanColumnStatus` | `pending_change` 调整待生效；`listed` 已上架；`delisted` 已下架；`draft` 未上架且无生效价目 | 接口枚举 |
| `BillingParamKey` | 同数据模型 `billing_param.key`（12 个） | |
| 模板价等级 | 同数据模型 `price_tier_revision.tier` | |
| 订阅状态 | `none`、`active`、`expired` | 取值同数据模型 `billing_account.sub_status`，但现算 |
| 周期状态、来源 | 同数据模型 `subscription_term.status`、`subscription_term.origin` | |
| 积分类型 | 同数据模型 `point_lot.kind` | |
| 账本操作类型 | 同数据模型 `ledger_operation.op_type` | 17 个 |
| `AdminLedgerCategory` | `grant` 发放；`purchase` 加购；`hold` 冻结；`capture` 扣减；`return` 退回；`expire` 清零；`adjust` 调整；`gate` 停用与恢复 | 接口枚举，映射见 4.2 |
| 流水页签 | `all`、`gain`、`use`、`expire` | 原型“全部 / 获得 / 使用 / 清零” |
| 调整方向、调整原因 | 同数据模型 `point_adjustment_request.direction`、`point_adjustment_request.reason_code` | 原因是系统枚举（M55） |
| 延长执行方式 | 同数据模型 `term_extension_request.applied_mode` | |
| `RenewalTab` | `expiring` 7 天内到期未续费；`expired` 已过期未续费（30 天内）；`renewed` 本月已续费 | 接口枚举 |
| `RenewalIntent` | `none` 待跟进；`considering` 考虑中；`confirmed` 已确认续费；`declined` 暂不续费；`renewed` 已续费；`extension_pending` 延长审批中 | 接口枚举；`considering`、`confirmed`、`declined` 同数据模型 `follow_up.intent`（`ck_follow_up_intent`）；`none`、`renewed`、`extension_pending` 为计算值 |
| `RenewalTiming` | `early` 提前续费（付款早于原止日 7 天以上）；`before_due` 到期前续费（原止日前 7 天内）；`after_expiry` 过期后续费（新周期 `origin = resume`） | 接口枚举（Renewals.dc.html:273），见 2.9 `renewal` |
| `ReminderState` | `sent`、`pending`、`skipped` | 接口枚举 |
| 审批类型、审批状态 | 同数据模型 `approval_request.kind`、`approval_request.status` | |
| 付款单类型、状态、渠道、来源、对公子状态、履约状态、取消原因 | 同数据模型 `billing_order.type`、`status`、`channel`、`source`、`transfer_state`、`fulfillment_status`、`cancel_reason` | |
| 收款交易状态、对账状态 | 同数据模型 `payment_txn.status`、`payment_txn.recon_state` | |
| 凭证结论 | 同数据模型 `transfer_proof.review_status` | |
| `ProofHint` | `uploaded_today`、`uploaded_earlier`、`remark_missing_order_no`、`payer_name_mismatch`、`amount_mismatch`、`upgrade_quote_expiring`、`in_review` | 接口枚举，`x-open-enum` |
| 凭证核对项 | `payer_name`、`amount`、`remark_order_no`、`trade_time`；结论 `pass` / `warn` / `fail` / `unknown` | 同数据模型 `transfer_proof.check_result`（08-billing-payment.md:1396） |
| 退款申请来源、规则、状态、路由、关闭原因 | 同数据模型 `refund_request.source`、`rule_code`、`status`、`exec_route`、`close_reason` | |
| `RefundTab` | `pending_approval` 待审批；`pending_execution` 待执行（含 `executing`）；`processed` 已处理（`done`、`not_executed`）；`all` | 接口枚举，与 a05 `CancelTab` 取值相同 |
| 退款交易渠道、来源、状态 | 同数据模型 `refund_txn.channel`、`refund_txn.origin`、`refund_txn.status` | |
| 不支持退款的原因 `unsupportedReason` | `topup_not_refundable`、`upgrade_refund_source_first`、`not_fulfilled`、`not_paid`、`already_refunded`、`open_request_exists` | 接口枚举 |
| 退款规则不满足的原因 | `outside_window`、`points_used`、`term_upgraded`、`qualification_not_dead`、`term_not_refundable` | 接口枚举（`PLAN_REFUND_NOT_ELIGIBLE.details.reasons`） |
| 差异类型、发现途径、状态、处理方式 | 同数据模型 `payment_exception.kind`、`detected_by`、`status`、`resolution` | |
| `PaymentExceptionTab` | `open` 待处理（`status = open`）；`resolving` 已转退款；`resolved` 已处理（`resolved`、`auto_healed`）；`all` | 接口枚举 |
| 差异处理结果 `outcome` | `resolved`、`refund_requested`、`still_blocked` | 接口枚举 |
| 账单文件状态、账单行匹配结果 | 同数据模型 `wx_bill_file.status`、`wx_bill_line.match_state` | |
| 对账日状态 | 同数据模型 `recon_day.status` | |
| 发票类型、介质、状态、驳回方式；票据种类、文件格式、邮件状态 | 同数据模型 `invoice_request.invoice_type`、`medium`、`status`、`reject_kind`；`invoice_doc.doc_kind`、`file_format`、`email_state` | |
| 开票前核对项 | `order_paid_not_refunded`、`no_refund_in_flight`、`title_from_verified_license`、`not_invoiced_before`、`special_fields_filled` | 接口枚举 |
| 受控配置键 | 同数据模型 `finance_config_revision.config_key` | |
| `FinanceConfigState` | `pending`、`scheduled`、`effective`、`superseded`、`rejected`、`withdrawn` | 接口枚举 |
| 确认到账结果 `outcome` | `paid`、`review_pending` | 接口枚举 |

### 4.2 账本操作 → 后台流水类型与页签

按 d1:1406-1421；与商家端（m07 第 4.2 节）的区别是“扣减”单独成行、清零叫“清零”。

| `op_type` | `category` | 页签 | 说明 |
| --- | --- | --- | --- |
| `grant` | `grant` | `gain` | 月度发放、升级补发 |
| `purchase` | `purchase` | `gain` | |
| `hold` | `hold` | `use` | |
| `capture` | `capture` | `use` | 由冻结转出，`deltaPoints = 0`，`qty` 为转出数量 |
| `release`、`refund` | `return` | `gain` | 转为加购积分的部分 `lotKind = addon` |
| `unexpire` | `grant` | `gain` | 标题“有效期延长，恢复已清零积分” |
| `adjust` | `adjust` | 增加 `gain`、扣减 `use` | |
| `expire` | `expire` | `expire` | |
| `revoke` | `expire` | `expire` | 标题“套餐退款作废” |
| `addon_suspend`、`addon_resume`、`refund_suspend`、`refund_resume` | `gate` | 只在 `all` | `deltaPoints = 0`，不计入任何合计 |
| `fulfill`、`extend` | 不出行 | — | 只做幂等登记 |
| `fix` | 按变动方向 `adjust` | 按方向 | 人工修复 |

### 4.3 差异类型的可选处理

同 08-billing-payment.md:770-782；`allowedResolutions` 据此给出。

| `kind` | 可选 `resolution` |
| --- | --- |
| `paid_after_cancel` | `restore`、`refund` |
| `amount_mismatch`、`payer_mismatch`、`duplicate_receipt` | `refund`（规则 `unapplied_receipt`） |
| `fulfillment_blocked` | `retried`、`refund`（规则 `fulfillment_blocked`） |
| `bill_only` | 没有付款单：`rebuild_order`、`refund`；已关联付款单的由入账函数重新归类，不经本接口 |
| `bank_unmatched` | `link_order`、`offline_return` |
| `platform_only`、`status_mismatch`、`refund_platform_only`、`refund_amount_mismatch` | `corrected` |
| `refund_bill_only` | `record_channel_refund` |
| `refund_over`、`entitlement_unrecovered` | `corrected`、`written_off`（仅超级管理员） |

### 4.4 `actions` 动作名

列表与详情 DTO 的 `actions`（C16）只放对应某条路由的动作，取 C12 的词或路由动作段：`shelve`、`delist`、`withdraw`、`approve`、`reject`、`remind`、`confirm`、`approve-review`、`reject-review`、`submit-proof`（与 m07 第 4.3 节同名）、`execute`、`record-offline`、`retry`、`confirm-not-accepted`、`void`、`issue`、`issue-red`、`resend`、`resolve`、`rerun`。

C12 没有对应词的编辑与嵌套新建，按 operationId 的动作写：`update`（PATCH：3.13、3.85）、`create-plan-revision`（3.6）、`create-point-adjustment-request`（3.25）、`create-term-extension-request`（3.35）、`create-refund-request`（3.55）。这一写法已在约定 C12 登记（A154）。

纯前端的跳转与入口（记录跟进、续费试算、导出）不放进 `actions`，前端按模块查看等级显示。

## 5. 错误码

本文新定义的领域错误码。账本段 43100–43199，付款与财务段 44100–44299（A70）。`retryable` 一律为否。

| 符号 | 数值 | HTTP | 含义 | `details` |
| --- | --- | --- | --- | --- |
| `REVISION_PENDING_EXISTS` | 43101 | 409 | 该套餐已有待生效的价目修订，请先撤销再改 | `{ planRevisionId, effectiveAt }` |
| `PARAM_PENDING_EXISTS` | 43102 | 409 | 参数已有待生效的修订，请先撤销再改 | `{ items: [{ key, billingParamId, effectiveAt }] }` |
| `NOTICE_PERIOD_REQUIRED` | 43103 | 400 | 生效时间须在公告期之后 | `{ earliestEffectiveDate, keys? }` |
| `REVISION_ALREADY_EFFECTIVE` | 43104 | 409 | 修订已生效或已撤销，不能撤销 | `{ effectiveAt, cancelledAt }` |
| `CHANGESET_EMPTY` | 43105 | 400 | 没有需要保存的变化 | — |
| `PLAN_CODE_TAKEN` | 43106 | 409 | 版本码已存在 | — |
| `PLAN_RANK_TAKEN` | 43107 | 409 | 版本等级已被占用 | `{ planId }` |
| `PLAN_TIER_ORDER_INVALID` | 43108 | 409 | 高等级版本的价格与积分须高于低等级版本 | `{ conflictPlanId, field }` |
| `PLAN_REVISION_MISSING` | 43109 | 409 | 套餐没有生效价目或缺少启用周期的价格，不能上架 | `{ missingCycles }` |
| `POINT_PACK_DUPLICATE` | 43110 | 409 | 上架中已有相同积分数的积分包 | `{ pointPackId }` |
| `ADJUST_ACCOUNT_INACTIVE` | 43111 | 409 | 套餐未生效的账户不能手动调整，续费后再处理 | — |
| `ADJUST_EXCEEDS_AVAILABLE` | 43112 | 409 | 扣减数量超过该类型的可用积分 | `{ availablePoints }` |
| `ADJUST_HOLD_INVALID` | 43113 | 409 | 关联的订购或广告不能做平台原因退回 | `{ holdStatus, returnablePoints }` |
| `EXTENSION_NOT_APPLICABLE` | 43114 | 409 | 当前周期不能发起补偿延长 | `{ termStatus }` |
| `PLAN_REFUND_NOT_ELIGIBLE` | 43115 | 409 | 不符合套餐退款规则（d2 的 422 按 C24 改为 409） | `{ rule, reasons }` |
| `OFFLINE_ORDER_DISABLED` | 44101 | 403 | 线下开单未开启 | — |
| `BANK_ACCOUNT_NOT_CONFIGURED` | 44102 | 409 | 尚未配置生效的对公收款账户 | — |
| `CONFIRMER_IS_ORDER_CREATOR` | 44103 | 403 | 开单员工不能确认本单到账 | — |
| `TRANSFER_AMOUNT_MISMATCH` | 44104 | 409 | 到账金额与应付不一致，请驳回凭证并登记异常到账 | `{ amountFen }` |
| `BANK_SERIAL_DUPLICATE` | 44105 | 409 | 该银行流水号已被使用 | `{ conflicts: [{ ref, payerBank: DictRef \| null }] }`（`ref` 为付款单号或差异单号；`payerBank` 为字典 `bank`，C85） |
| `REFUND_NOT_SUPPORTED` | 44106 | 409 | 该付款单不支持现金退款（d2 的 422 按 C24 改为 409） | `{ reasonCode }` |
| `REFUND_REQUEST_EXISTS` | 44107 | 409 | 该笔收款已有在途退款申请 | `{ refundRequestId, requestNo }` |
| `RED_INVOICE_REQUIRED` | 44108 | 409 | 请先完成红字发票，再执行退款（d2:988） | `{ invoiceRequestId, requestNo, status }` |
| `REFUND_EXCEEDS_REFUNDABLE` | 44109 | 409 | 退款金额超过可退余额 | `{ refundableFen }` |
| `REFUND_TXN_OPEN` | 44110 | 409 | 申请名下有未完成或已成功的退款交易 | `{ refundTxnId, status }` |
| `REFUND_ALREADY_REVOKED` | 44111 | 409 | 套餐权益已回收，申请不能作废，须完成退款 | `{ entitlementRevokedAt }` |
| `REFUND_ROUTE_NOT_ALLOWED` | 44112 | 409 | 该退款不能走所选方式 | `{ allowedRoutes }` |
| `REFUND_NOT_ACCEPTED_UNCONFIRMED` | 44113 | 409 | 还不能确认微信未受理 | `{ reasons }` |
| `REFUND_EXECUTOR_CONFLICT` | 44114 | 403 | 执行人不能是审批人 | — |
| `PAYEE_NAME_MISMATCH` | 44115 | 400 | 对公付款的退款，收款户名须与购买主体一致 | `{ expectedName }` |
| `INVOICE_ISSUE_BLOCKED` | 44116 | 409 | 付款单已不满足开票条件 | `{ reasons }` |
| `INVOICE_NO_TAKEN` | 44117 | 409 | 该发票代码与号码已被使用 | — |
| `RESOLUTION_NOT_ALLOWED` | 44118 | 409 | 该差异不能这样处理 | `{ allowed }` |
| `CHANNEL_RECHECK_FAILED` | 44119 | 409 | 微信实时查询结果不支持该处理 | `{ channelState, channelAmountFen }` |
| `LINK_ORDER_INVALID` | 44120 | 409 | 所选付款单不能关联这笔到账 | `{ reasons }` |
| `RECON_BILL_NOT_READY` | 44121 | 409 | 该日账单尚未下载解析 | `{ billFileStatus }` |

本文引用、由其他文档定义的错误码：

| 符号 | 定义处 |
| --- | --- |
| `PLAN_NOT_AVAILABLE`、`CYCLE_NOT_AVAILABLE`、`UPGRADE_NOT_ALLOWED_TODAY`、`SCHEDULED_TERM_LIMIT`、`TOPUP_REQUIRES_ACTIVE_PLAN`、`PLAN_REFUND_IN_PROGRESS`、`QUOTE_CHANGED`、`ACCOUNT_BUSY`、`PURCHASE_QUALIFICATION_REQUIRED`、`OPEN_ORDER_EXISTS`、`PAYMENT_ORDER_EXPIRED`、`TRANSFER_PROOF_LOCKED` | m07-billing（账本 43000–43099、付款 44000–44099） |
| `FILE_NOT_USABLE` | m03-profile-asset（46001） |
| `REMIND_NOT_APPLICABLE` | a05-order-delivery（45309；催办场景与对象状态不符） |
| `APPROVAL_NOT_PENDING`、`APPROVAL_SELF_FORBIDDEN`、`APPROVAL_ALREADY_PENDING`、`APPROVAL_WITHDRAW_FORBIDDEN` | a03-merchant（48201–48204） |
| `VALIDATION_FAILED`、`PERMISSION_DENIED`、`STEP_UP_REQUIRED`（C86 登记的五条驳回 3.28、3.38、3.51、3.60、3.83 不返回）、`NOT_FOUND`、`VERSION_CONFLICT`、`STATE_NOT_ALLOWED`、`CONFIRM_MISMATCH`、`PRECONDITION_CHANGED`、`IDEMPOTENCY_IN_PROGRESS`、`PROVIDER_UNAVAILABLE`、`UPSTREAM_TIMEOUT`、`BUSY`、`REMINDED_TODAY`（409 / 40920，A76 升为通用码，a06 的 46201 已释放） | 通用（C27） |

## 6. 待确认

只列需要产品、业务、财务或法务决定的问题；约定与跨文档的事项见修订记录与 `cross_doc`。

| # | 问题 | 默认做法 | 谁定 |
| --- | --- | --- | --- |
| 1 | 对公凭证的识别结果（付款户名、金额、附言、时间）在 GET 里按原值返回，付款账号只给脱敏串（A89、C40 的明文例外；约定第 15 节第 15 项） | 按 A89：企业间转账事实不按个人信息处理；若法务不同意，付款户名改走 `admin.piiReveal.create` | 法务、财务 |
| 2 | A:Params 上的“下架提醒（使用期结束前）”是系统参数 `remind.offline.days`（14 分组 `param_value`），不在本文的变更集里，整页一次保存做不到原子；它的保存接口 a01 `admin.paramValue.replace` 要求 `sys.param.edit`（默认仅超级管理员），而本页的其他项由持 `billing.param.edit` 的运营保存 | 移到 A:SysParams 页（a01）；不移时本页按 `keys = remind.offline.days` 单独读写、分两次保存（3.16），没有 `sys.param.edit` 的员工只读，下架提醒不受计费参数的公告约束 | 产品 |
| 3 | 计费规则的“提前公告”在页面上没有落点：A:Plans 编辑弹窗没有公告输入（原型保存后自动生成公告）；A:Params 没有生效日输入（原型“保存即生效”，proto-admin-c.md:245）；A:Plans 的可选周期开关点了即生效（Plans.dc.html:134），而 `enabledCycles` 是需公告的键（07-billing-ledger.md:1452） | 接口已兜底：公告文案由服务端按差异生成、请求可覆盖（3.6、3.18）；需公告的参数不传生效日时取最早可选日（今天 + `noticeDays`）。页面在保存前加确认层“将于 X 起生效，并向商家发布调整公告（预览文案）”；A:Params 需公告的键旁显示生效日（可改晚不可改早） | 产品、设计 |
| 4 | A:Receipts 确认区只有“已核对”勾选与银行流水号（Receipts.dc.html:109；proto-admin-b.md:256），本文的确认到账另要财务填写的“到账金额”（与应付比对）和流水号冲突时的“付款行”（3.48） | 页面补“到账金额”输入（不预填应付金额）；付款行选择只在返回 `BANK_SERIAL_DUPLICATE` 后出现 | 产品、设计 |
| 5 | 现金退款（以及 a05 的订购与广告取消）驳回原因：原型给了 4 项（不符合退款规则、金额核算有误、说明不充分、其他，proto-admin-d.md:126），字典 `reject_reason` 没有这个场景（14-config-data.md:124-131）；对公复核退回、受控配置驳回也没有场景 | **已定（A156）**：14 分组在 `reject_reason` 下补“取消与退款驳回”场景并播种这 4 项（与 a05 同一事项，数据模型待回写）；播种前 `reasonCodes` 不传。对公复核、受控配置不设原因字典，说明写 `note` | 已关闭 |
| 6 | 退款的审批人能否同时是执行人：d4-identity.md:1501 定参数 `refund.require_distinct_executor`（原 `sod.refund.distinct_executor` 作废），14 分组参数表还没有这个键；a05 取消申请同一问题（a05 第 6 节第 3 项） | **已定（A156）**：14 分组登记该键，默认 false（允许同一人，财务可能只有一人；数据模型待回写）；为 true 时 3.62、3.63 返回 403 `REFUND_EXECUTOR_CONFLICT`，a05 的执行接口同步 | 已关闭 |
| 7 | 线下退款登记的回单文件是否必传（08-billing-payment.md:1566） | 必传 | 财务 |
| 8 | 规则外退款（`override`）对已升级周期：来源付款单的申请执行时作废整个周期，之后各笔升级补差款再各自发起 `override` 申请，只退现金（M111）；界面要提示“先退来源款” | 按此；试算返回 `upgrade_refund_source_first` | 业务、财务 |
| 9 | 对公收款确认队列（A:Receipts）挂在“订单管理”菜单，查看按模块 `order`；财务的默认角色须有 `order` ≥ v | 按 PRD §8.2 的菜单归属 | 产品 |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：路线图 `doc = a07-billing-finance` 的 84 条接口全部写到字段级；公共结构 18 组；新定义错误码 36 个（43101–43115、44101–44121）；`REMINDED_TODAY` 引用 a06、`REMIND_NOT_APPLICABLE` 引用 a05、审批类四个码引用 a03；审批决定按 A14 挂在领域资源，守卫顺序与 a03 一致；权限点增补 5 个 | 接口裁决 A1–A75；通用约定 C1–C84；数据模型 07、08 分组 |

**第二轮（2026-10-03，按裁决第十节 A76–A120、其他文档的请求、两位复核员的意见与整体核对修订）**

| 改动 | 依据 |
| --- | --- |
| `REMINDED_TODAY` 改为通用码 409 / 40920（3.34、第 5 节），不再引用 a06 的 46201；删去原第 6 节第 4 项 | A76；C27；复核 A、B |
| 新增 `admin.plan.update`（3.85，改版本名称，带 `plan.lock_version`），接口数 84 → 85；路线图切片同步 | 作者的路线图建议；PRD:765；07-billing-ledger.md:91 |
| 路线图切片：`admin.pricingChange.create` 与四个撤回接口的 `permission` 改 `assert-in-handler`；`admin.plan.quote`、`admin.pointAdjustmentRequest.get`、`admin.termExtensionRequest.get`、`admin.transferProof.get`、`admin.refundRequest.get` 也改 `assert-in-handler`（“模块 X 或 Y ≥ v”在处理器内判定，2.0）；价目修订两条去掉 `timer`；`admin.paymentException.resolve` 按处理方式展开迁移并标三段式 | 作者的路线图建议；A45；C66；复核 B |
| 员工引用改用 a01 的 `StaffBrief`；`ApprovalInfo` 改为 a01 `ApprovalDecisionView` 加 `requestNo`、`requesterRoleName`、`confirmChecks`（`approvalId`、`reasons: [{ code, name }]`） | a01 第 2.2、2.10 节；复核 B |
| 决定请求体：`confirmChecks` 1–10 项且必含各接口列出的编码；`reasonCodes` 0–1 项（与 a05 一致）；积分调整驳回的字典场景改 `point_adjust`；现金退款驳回、对公复核退回暂无场景、不传 | 14-config-data.md:124-131；a05；复核 A、B |
| 驳回与代撤的再验证按 C66 随权限点（3.28、3.51、3.60、3.83 补 `STEP_UP_REQUIRED`），与数据模型“驳回不要求再验证”的冲突报主负责人 | C66；复核 B |
| `plan_refund` 补决定时限：提交写 `due_at`、`sla_snapshot`（`sla.review.refund_approve`），登记 `…:decision` 定时器，决定与撤回时取消（3.55、3.59–3.61、3.79）；其余四类按 A93 不设时限，删去原第 6 节第 5 项 | A93；x01-events-jobs.md:511；复核 B |
| 审计 `category` 改用 03 分组登记编码（`plan_config`、`price_adjust`、`param`、`points_adjust`、`term_adjust`、`refund`）；对公收款、开票、对账、受控配置暂写 `payment`、`invoice`、`recon`、`finance_config`，进待回写清单 | A107；03-staff-authz-audit.md:931；复核 B |
| 事件按 x01 目录：补偿延长到期后补批改发 `billing.subscription.resumed`（`subscription_event.type = resumed`）；线下退款登记补 `approval.executed`；退款执行补 `billing.subscription.rolled_over`；执行与重试的成功只由回调与 `rf.poll` 落；转账驳回载荷 `reasonCodes = [reasonCode]`；入账类接口列出 `fulfill()` 的履约事件；重新对账补 `payment_exception.auto_healed`；x01 未登记的发出方与 `pricing.drama_price_changed` 的 `cause = tier_template` 进 `cross_doc` | A95；x01；复核 B |
| 退款执行写明三段式的多事务形态（E1 落意图 → 外调 → E2 落结果并写幂等记录），请主负责人把 C51 的登记改为“多事务” | C51；复核 B |
| 差异处理：删去 `refundReasonCode`（差异转入的申请 `reason_code` 必为空，`ck_refund_request_reason`）；补记渠道退款遇到周期挂在退款申请闸门上时按 08-billing-payment.md:780 不回收、另开 `entitlement_unrecovered`（07 / 08 冲突报主负责人）；转退款登记决定时限；三段式按 A84 | A84；复核 A |
| 对账 `admin.reconciliation.list` 的日行放进 `items`（并列返回月度概览）；受控配置 `tab = current` 只回 `{ items }`，补 `financeConfigRevisionId` 筛选供“我的待审批”跳转；删去原第 6 节第 7 项 | A78；C43；复核 B |
| 收款流水：列表去掉 `totals`；`summary` 改为接收列表的筛选参数，随筛选变化的合计放 `filtered`，页头 KPI 为固定字段 | A23；C83；复核 B |
| 退款管理页与 a05 对齐：页签 `pending_approval`（默认）/ `pending_execution`（含执行中）/ `processed` / `all`，`summary` 计数包进 `tabs`，补 `executingCount`、`overdueCount` 与 `overdueOnly` 筛选 | a05 3.8、3.9；复核 B；a05 的请求 |
| 计数口径：`newThisMonthCount`、`renewedThisMonthCount` 与 a02 的 `newCount`、`renewCount` 同一函数（不计延长复活的 `resumed`），权益矩阵按版本过滤；差异单页签 `open` 只计 `status = open`、另设 `resolving`；新增 2.19 给 a02 的计数函数与导出参数 | a02-workbench-report.md:309；a02 的请求；复核 A、B |
| 页面与数据补齐：积分账户备注条补 `pendingCancels`、`heldAwaitingQualification`；到期详情以 `orderItems`（制作中、待上线及最早上线日、上线中）取代 `liveOrderItemCount`；`renewed` 页签的行改为被续的上一周期，`isAhead` 改 `renewalTiming`；付款单 `statusNote` 补“附言缺付款单号”、补 `pendingTransferProofId`；`fulfillment` 在 m07 结构上扩展；积分调整补 `serviceTicketId` 与 `relatedServiceTickets`；`cyclePrices` 写明数组与库内对象的转换；变更记录的说明在只改模板价时取审计 `meta.note`；`reconState` 说明更正；`RenewalIntent` 与 `follow_up.intent` 的对应更正 | 复核 A；a08 的请求 |
| 计费规则公告：价目修订与参数变更集的 `notice` 改为可选，由服务端按差异生成文案；需公告的参数不传生效日时取最早可选日；页面落点列为第 6 节第 3 项 | 复核 A；a09 的请求 |
| 商家详情的付款单子页签改按 `entityId`；`storeId` 只用于工单选单等场景 | 08-billing-payment.md:68、75；复核 A |
| `actions` 动作名：`upload-proof` 改 `submit-proof`（同 m07），`confirm-receipt` 改 `confirm`，嵌套新建与编辑用 `create-<子资源>`、`update`（请主负责人在 C12 登记），跳转类按钮移出 | C12、C16；复核 B |
| 退款职责分离参数改名 `refund.require_distinct_executor`（与 a05 同键，待 14 分组登记）；晚到的退款成功回调按 A102 记成功（3.65） | d4-identity.md:1501；A102；h01 的请求；复核 A |
| 第 6 节只留产品、业务、财务、法务事项（9 项）；权限点增补表移到第 1 节 | A108；A119 |
| 审批决定的守卫顺序按 a03 第 1.1 节改为“路由级权限与再验证 → 取对象 → 审批单状态与自审 → 处理器追加的权限判定 → 锁版本 → 回显 → 事务内重算前提”（2.0） | a03 第二轮的请求；C7 |
| 与 m07 对齐：`PointAccountRow.planExpiresAt` 改名 `planPointsExpireAt`（含 3.20 的排序键）；`isRefundPending`、`spendablePoints`、`notices.pendingRefund` 与 3.20 的 `refund_pending` 筛选改为主体级闸门（任一 `scheduled` / `active` 周期被标记）；通用升级试算的 `pointsDeltaPerMonth` 改名 `monthlyDeltaPoints`；3.43 的 `QUOTE_CHANGED.details` 按 `kind` 判别；后台流水标题按 m07 第 4.5 节的现行文案表 | m07 第二轮的请求；m07 第 2.0、2.7、4.5、5 节 |
| A:CreditAdjust 的页签、计数与 KPI 按 a01 写明（`tab = all` 加 `status`；`byStatus`、`all`、`approvedThisMonth`、`rejectedThisMonth`、`pointsAdjustMonth`，3.26）；A:Params 的“下架提醒”写明调 a01 `admin.paramValue.list` / `replace`（`expectedRev` 取 `latestRev`，要 `sys.param.edit`），第 6 节第 2 项补上这个权限差异 | a01 第二轮的请求；a01 3.36、3.37、3.46、3.47 |
| “评定依据”改为前端文案的说法；写明 a04 `admin.priceTierRevision.list` 恰好 4 行当前值、没有页签与待生效行，`batchId` 即本文变更集 id（第 1 节页面对应表、3.16） | a04 第二轮的请求；A93、A94 |
| `FILE_NOT_USABLE` 写明 `details.reason`（`x-open-enum`）本文会返回的取值（2.0）；“记录跟进”写明带 `intent`、负责人固定为记录人（3.30）；2.0 补三段式路由标 `x-three-phase`、本文没有需要结果脱敏的路由；2.19 的字段引用改写 | m03、a03 第二轮的请求；A80、A124；C50、C75 |
| 路线图切片补齐：补 `admin.plan.update`（api-check 第 1 节“清单多出”，判定补进切片，切片 84 → 85 条）；10 条 `permission` 改 `assert-in-handler`；价目修订两条去掉 `timer`；三段式四条写 `idempotentNote`；决定时限定时器、`service_ticket_ref`、`cancel_request`、`order_item` 等补进 `tables`；`transitions` 与清单同步；过时的 `notes`（付款单子页签按 `storeId`、收款流水列表带合计、对公复核有字典场景、补发提醒“建议”等）改正 | A119；api-check 第 1 节；作者的路线图建议 |
| 清单：`PointAccountRow`、`PointAccountDetail` 字段改名同上；`admin.paymentTransaction.summary` 的请求 schema 改为同列表的 `PaymentTransactionListQuery`；`admin.refundRequest.retry` 的迁移去掉“成功”（与 3.64 一致） | 自查 |

不采纳或无需改动的请求：a06“引用 46201”（A76 已改通用码）；a04 的“`pricingChange.list` 只看模板价”已由 `kind = price_tier` 支持；a04 问的 `REVISION_ALREADY_EFFECTIVE`：本文已定义（43104），a04 已引用；a04 第二轮“`pricing.drama_price_changed` 的 `cause` 与 x01 对齐”：模板价变化是 x01 现有两种起因（`revision`、`tier_change`）之外的第三种，按 A95 由 x01 补登 `tier_template` 与发出方（x01 的复核员也这样建议），本文暂保留，x01 定稿后按它改；m07 第二轮第 (6) 项 `PurchasePolicy` 布尔字段改名：本文不引用这些字段，无需改动；a03、a08、m07、x01 的其余请求本文初稿已满足（见 `cross_doc` 与修订员结论）。

**第三轮（2026-10-03，按裁决第十二、十三节 A127–A150、约定 C85–C87、其他文档的请求与整体核对修订；并核对第二轮中断前的改动）**

| 改动 | 依据 |
| --- | --- |
| 五条审批驳回（3.28、3.38、3.51、3.60、3.83）：文档与清单已在第二轮末标 `x-step-up: skip`、错误表不列 `STEP_UP_REQUIRED`，本轮路线图切片补字段 `xStepUp: "skip"`；第 5 节注明这五条不返回 `STEP_UP_REQUIRED`。3.49 对公凭证驳回不登记（C86 表外） | A127；C86 |
| 公共结构：分页响应改写为 a01 的 `AdminPage<T>` / `AdminCursorPage<T>`（3.7、3.17、3.20、3.23、3.30、3.40、3.45、3.52、3.56、3.67、3.76、3.80），清单删去 12 个 `XxxPage`，新增 `PlanRevisionListItem`、`FinanceConfigRevisionList`（按 `tab` 二选一）；与 m07 同名不同构的四个结构加 `Admin` 前缀：`AdminPaymentOrderListQuery`、`AdminPaymentOrderSummary`、`AdminInvoiceRequestListQuery`、`AdminInvoiceRequestSummary`（2.1、2.19、3.40、3.41、3.67、3.68）；`DictRef` 改记为约定 C85 的通用结构；清单 `externalSchemas` 补 `AdminCursorPage`、`PlanQuote`、`QuoteChangedDetails`、`PaymentOrderContentView`、`InvoiceDocView` | A132、A150；C43、C87；整体核对 |
| 公告请求体（3.6、3.18）的 `notice.barEnabled` 改名 `isBarEnabled`，与 a09 `SiteNoticeItem.isBarEnabled` 同列 | C39；a09 的请求 |
| 3.63 线下退款登记的完成动作与 h01 3.2 对齐：开票申请自动驳回写 `rejected_at` 并 `timers.cancel` 其 `sla.breach`；差异单 `resolving → resolved` 同事务刷新 `billing_order.has_open_exception`；补“清除被本申请暂停的开票申请标记”；“退款交易成功”引用改 08-billing-payment.md:531；切片 `tables` 补 `payment_exception`、`timer` | h01-hooks.md:396-400、409；08-billing-payment.md:211、1131、1140 |
| 08 分组第 529 行插入 A102 一行后，本文引 529 行及以后的 23 处行号整体 +1（如 3.66 作废改 530、3.65 晚到回调改 529、3.60 差异单回退改 764、3.70 开具改 1111-1112、2.17 逾期改 790）；3.65 说明里“08 分组待回写”改为已回写的 08-billing-payment.md:529 | 08-billing-payment.md 现行文件 |
| 已核对无需再改：A131 的 `REMINDED_TODAY.details`（3.34）与 `QUOTE_CHANGED` 的 `plan` / `topup` 分支（3.43）第二轮已写；api-check 第 6 节的 `openDiff` 写法（2.19）已是“`admin.paymentTransaction.summary` 的 `openDiff`”；第二轮中断时的三份输入（xdoc、r2-xd、两位复核员）逐条核对均已落到文档、清单与切片，未完成的只有需要别人改的事项，本轮重新列入 `cross_doc` | A131；review/xdoc、r2-xd、r2-reviews |
| 第 6 节逐项核对：9 项都不在 A127–A150 的裁决范围内，保留 | A108 |

不采纳：整体核对提示 `TransferProofListQuery` 与 a09 `NotifySceneListQuery` 同构（`page`、`pageSize`、`q`、`tab`），两者 `tab` 取值与语义不同，不合并。

**第四轮（2026-10-03，按裁决 A151–A156 收尾）**：3.62 的 C51 登记已改“多事务”（A154），删去待办说明；补记渠道退款遇闸门按 A156 定稿（3.79 说明改写），第 6 节第 5、6 项关闭，3.60 退款驳回原因改按 A156 的新场景；单值字典字段按 A151 / C85：请求 `payerBank` → `payerBankCode`（3.48、3.78）、`expressCompany` → `expressCompanyCode`（3.70），响应 `firstConfirm.payerBank` 与 `BANK_SERIAL_DUPLICATE.details.conflicts[].payerBank` 改为 `DictRef | null`；驳回原因响应第三轮已是 `DictRef`，系统枚举 `reasonCode`、`ruleCode` 不变。m07 的六个同名结构：第三轮已加 `Admin` 前缀、分页改用 `AdminPage<T>`，无需再改。
