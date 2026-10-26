const payment =
  "sub/order/result/index?type=payment&paymentOrderId=00000000-0000-4000-8000-000000000001";
export const TOPUP_SCENES = [
  ...["list", "offline", "hidden", "disabled", "clerk", "error"].map((state) => ({
    name: `topup-${state}`,
    route: "sub/billing/topup/index",
  })),
  { name: "plan-renew", route: "sub/billing/plan-pick/index?intent=renew_next_term" },
  { name: "plan-upgrade", route: "sub/billing/plan-pick/index?intent=upgrade_now" },
  { name: "wechat-pending", route: payment },
] as const;
