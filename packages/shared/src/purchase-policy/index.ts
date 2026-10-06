// D2 §10.3：有序首匹配。纯计算，不读配置、库、Provider 或时钟。
export interface PurchaseRule {
  when: {
    platforms?: string[];
    versionRange?: string;
    entityIds?: string[];
    types?: string[];
    amountGteFen?: number;
    amountLtFen?: number;
  };
  then: {
    mode?: "in_app" | "offline_contract" | "hidden";
    channels?: { wechat_jsapi?: "on" | "off"; bank_transfer?: "on" | "off" };
    copySet?: { planNounKey: string; pointsNounKey: string; payButtonKey: string };
  };
}
export interface PolicyInput {
  platform: string;
  appVersion?: string;
  entityId: string;
  type?: string;
  amountFen?: number;
  payerPaidTodayFen?: number;
  providers: { wechatPayConfigured: boolean };
  bankAccountConfigured: boolean;
  bankMinFen: number;
  adviseTransferAboveFen?: number | null;
}
export interface Controls {
  adminCreateOrder: boolean;
  wechatSingleLimitFen: number;
  wechatDailyLimitFen: number;
  receiptSecondReviewFen: number | null;
  shippingReport: boolean;
}
export const DEFAULT_CONTROLS: Controls = {
  adminCreateOrder: false,
  wechatSingleLimitFen: 0,
  wechatDailyLimitFen: 0,
  receiptSecondReviewFen: null,
  shippingReport: false,
};
function compare(a: string, b: string): number {
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
// 受控配置仅接受三段数值版本及空格相连的比较器；不可解析时不匹配，不猜测客户端版本。
export function versionMatches(version: string | undefined, range: string): boolean {
  if (version === undefined || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version) || !range) return false;
  return range.split(" ").every((token) => {
    const m = /^(>=|<=|>|<|=)(\d{1,5}\.\d{1,5}\.\d{1,5})$/.exec(token);
    if (!m) return false;
    const c = compare(version, m[2]!);
    switch (m[1]) {
      case ">=":
        return c >= 0;
      case "<=":
        return c <= 0;
      case ">":
        return c > 0;
      case "<":
        return c < 0;
      default:
        return c === 0;
    }
  });
}
export function getPurchasePolicy(
  input: PolicyInput,
  rules: readonly PurchaseRule[],
  controls: Controls = DEFAULT_CONTROLS,
) {
  const matched = rules.find(
    ({ when: w }) =>
      (w.platforms === undefined || w.platforms.includes(input.platform)) &&
      (w.entityIds === undefined || w.entityIds.includes(input.entityId)) &&
      (w.types === undefined || (input.type !== undefined && w.types.includes(input.type))) &&
      (w.versionRange === undefined || versionMatches(input.appVersion, w.versionRange)) &&
      (w.amountGteFen === undefined ||
        (input.amountFen !== undefined && input.amountFen >= w.amountGteFen)) &&
      (w.amountLtFen === undefined ||
        (input.amountFen !== undefined && input.amountFen < w.amountLtFen)),
  );
  const then = matched?.then,
    mode = then?.mode ?? "in_app",
    amount = input.amountFen;
  const wechat =
    then?.channels?.wechat_jsapi !== "off" &&
    input.providers.wechatPayConfigured &&
    (amount === undefined ||
      (amount <= controls.wechatSingleLimitFen &&
        (input.payerPaidTodayFen ?? 0) + amount <= controls.wechatDailyLimitFen));
  const bank =
    then?.channels?.bank_transfer !== "off" &&
    input.bankAccountConfigured &&
    (amount === undefined || amount >= input.bankMinFen);
  const recommendBank =
    bank &&
    (!wechat ||
      (amount !== undefined &&
        input.adviseTransferAboveFen != null &&
        amount > input.adviseTransferAboveFen));
  return {
    mode,
    isPriceShown: mode === "in_app",
    isPurchasePromptAllowed: mode === "in_app",
    channels:
      mode !== "in_app"
        ? []
        : [
            {
              code: "wechat_jsapi" as const,
              isEnabled: wechat,
              isRecommended: wechat && !recommendBank,
              hintKey: wechat
                ? null
                : input.providers.wechatPayConfigured
                  ? "limit_exceeded"
                  : "channel_unavailable",
            },
            {
              code: "bank_transfer" as const,
              isEnabled: bank,
              isRecommended: recommendBank,
              hintKey: bank ? null : "channel_unavailable",
            },
          ],
    copy: {
      ...(then?.copySet ?? { planNounKey: "plan", pointsNounKey: "points", payButtonKey: "pay" }),
      agreementKeys: input.type === "topup" ? ["points"] : ["member", "points"],
    },
  };
}
