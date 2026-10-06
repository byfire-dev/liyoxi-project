import type { Data } from "@/lib/account-api";

export type Wallet = Data<"m.wallet.get">;
export type Policy = Data<"m.purchasePolicy.get">;

// m08 §2.2：bootstrap.copy 仅给覆盖项，V1.0 可为 {}。策略选择键，页面按键取默认或覆盖。
const DEFAULT_COPY: Readonly<Record<string, string>> = {
  plan: "套餐",
  points: "积分",
  pay: "付款",
  limit_exceeded: "超限，仅支持对公转账",
};
export function billingCopy(key: string, overrides: Readonly<Record<string, string>>): string {
  return overrides[key] ?? DEFAULT_COPY[key] ?? "";
}
export function purchaseVisible(policy: Policy): boolean {
  return policy.mode === "in_app" && policy.isPriceShown && policy.isPurchasePromptAllowed;
}
export function walletPurchaseLabel(
  wallet: Wallet,
  policy: Policy,
  overrides: Readonly<Record<string, string>>,
): string | null {
  const noun = billingCopy(policy.copy.planNounKey, overrides);
  if (
    !purchaseVisible(policy) ||
    !noun ||
    wallet.subscription.isRefundPending ||
    wallet.subscription.status === "active"
  )
    return null;
  if (wallet.subscription.status === "none") return `开通${noun}`;
  return wallet.subscription.status === "expired" ? "续费" : null;
}
