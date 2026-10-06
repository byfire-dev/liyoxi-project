/** 本包固定离线样张；截图脚本直接读取，保留账户八态。 */
export const BILLING_SCENES = [
  { name: "wallet-active", route: "sub/billing/wallet/index" },
  { name: "wallet-expired", route: "sub/billing/wallet/index" },
  { name: "wallet-none", route: "sub/billing/wallet/index" },
  { name: "plan-pick", route: "sub/billing/plan-pick/index" },
  { name: "bank-waiting", route: "sub/billing/plan-pick/index" },
  { name: "bank-selected", route: "sub/billing/plan-pick/index" },
  ...["waiting", "rejected", "active", "processing", "cancelled"].map((state) => ({
    name: `payment-${state}`,
    route:
      "sub/order/result/index?type=payment&paymentOrderId=00000000-0000-4000-8000-000000000001",
  })),
] as const;
