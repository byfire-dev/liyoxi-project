// 外部回调与探活 · wechatpay（docs/api/h01-hooks.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { hookMeta } from "../meta-only.js";

export const hooksWechatpayRefundNotify = hookMeta({
  method: "post",
  path: "/hooks/wechatpay/refunds",
  operationId: "hooks.wechatpay.refund.notify",
  summary: "微信退款结果回调：验签解密后落退款结果，驱动退款申请、付款单、开票申请与差异单",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_webhook_event_provider_event_id"],
});

export const hooksWechatpayTransactionNotify = hookMeta({
  method: "post",
  path: "/hooks/wechatpay/transactions",
  operationId: "hooks.wechatpay.transaction.notify",
  summary:
    "微信支付结果回调：验签 → 解密 → 同事务落去重行与资金事实（收款交易成功）→ 提交后内联尝试入账与履约 → 应答",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_webhook_event_provider_event_id"],
});
