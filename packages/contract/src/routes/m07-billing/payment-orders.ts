// 商家端：套餐、积分、付款与发票 · payment-orders（docs/api/m07-billing.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mPaymentOrderList = merchantMeta({
  method: "get",
  path: "/m/payment-orders",
  operationId: "m.paymentOrder.list",
  summary:
    "付款单列表（?invoiceState=eligible,applying 为“可开票”页签，含“已申请，开票中”的单）：类型、单号、金额、标题、时间、支付方式、开票项目、开票状态",
  "x-capability": "invoice.*",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mPaymentOrderCreate = merchantMeta({
  method: "post",
  path: "/m/payment-orders",
  operationId: "m.paymentOrder.create",
  summary:
    "创建付款单（不传类型，按内容判定套餐或加购；记录《会员服务协议》《积分规则》同意）；对公同时返回收款账户与转账备注（= 付款单号）",
  "x-capability": "plan.purchase",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  "x-idempotent-reason":
    "结果脱敏（C50、A80）：bankAccount.accountNo 不进幂等记录，重放为 null 且 replayed = true",
});

export const mPaymentOrderSummary = merchantMeta({
  method: "get",
  path: "/m/payment-orders/summary",
  operationId: "m.paymentOrder.summary",
  summary:
    "开票页“可开票 · N”的计数（查询参数同列表，页面传 invoiceState=eligible，不算已申请的单）",
  "x-capability": "invoice.*",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mPaymentOrderGet = merchantMeta({
  method: "get",
  path: "/m/payment-orders/{paymentOrderId}",
  operationId: "m.paymentOrder.get",
  summary: "付款单详情与状态（含“已收到付款，正在处理”）、生效时间或到账积分、对公收款账户",
  "x-capability": "plan.purchase",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mPaymentOrderCancel = merchantMeta({
  method: "post",
  path: "/m/payment-orders/{paymentOrderId}/cancel",
  operationId: "m.paymentOrder.cancel",
  summary:
    "取消付款单：微信支付先查单再关单、以结果为准（查得已支付则入账，返回 outcome = paid）；对公在凭证待财务确认期间不可取消；响应 CancelResult {outcome: cancelled | paid | cancelling, paymentOrder}",
  "x-capability": "plan.purchase",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  "x-idempotent-reason": "三段式用例（C51，先调外部）：微信先查单再关单，幂等记录随最后的事务写",
});

export const mPaymentOrderSync = merchantMeta({
  method: "post",
  path: "/m/payment-orders/{paymentOrderId}/sync",
  operationId: "m.paymentOrder.sync",
  summary: "让服务端主动查单并尝试入账，返回付款单状态（每单每 3 秒一次）",
  "x-capability": "plan.purchase",
  "x-clerk-view": "none",
  "x-idempotent": "none",
  "x-idempotent-reason":
    "只查询渠道状态，入账由账本操作键 fulfill:/purchase:billing_order:{id} 去重（A50）；三段式用例",
});

export const mPaymentOrderTransferProofCreate = merchantMeta({
  method: "post",
  path: "/m/payment-orders/{paymentOrderId}/transfer-proofs",
  operationId: "m.paymentOrder.transferProof.create",
  summary: "提交或重新上传对公转账凭证 {fileId}（回单截图或照片），财务 1 个工作日内确认",
  "x-capability": "plan.purchase",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mPaymentOrderWechatPrepay = merchantMeta({
  method: "post",
  path: "/m/payment-orders/{paymentOrderId}/wechat-prepay",
  operationId: "m.paymentOrder.wechatPrepay",
  summary: "微信预下单，返回 wx.requestPayment 调起参数（三段式用例，幂等于 out_trade_no）",
  "x-capability": "plan.purchase",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  "x-idempotent-reason":
    "三段式用例（C51，多事务）：幂等记录随事务 B 写；结果脱敏（C50、A80）：payParams 重放为 null，响应带 replayed",
});
