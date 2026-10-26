import type { Agreement, Body, Data } from "@/lib/account-api";
import { ApiError } from "@/lib/request";
import type { PurchaseApi } from "./api";
import { purchaseVisible } from "../wallet/model";
export type Quote = Data<"m.plan.quote">;
export type Payment = Data<"m.paymentOrder.get">;
const models: Readonly<Record<string, string>> = {
  standard: "标准模型",
  advanced: "高级模型",
  top: "顶级模型",
};
const priorities: Readonly<Record<string, string>> = {
  standard: "标准排期",
  priority: "优先排期",
  rush: "加急排期",
};
export const planBenefitLabels = (benefits: Quote["benefits"]) =>
  `${models[benefits.productionModel] ?? benefits.productionModel} · ${priorities[benefits.schedulePriority] ?? benefits.schedulePriority}`;
export const enabledChannels = (policy: Quote["policy"]) =>
  policy.channels.filter((v) => v.isEnabled);
export function purchaseAgreements(policy: Quote["policy"], items: readonly Agreement[]) {
  return policy.copy.agreementKeys
    .map((key) =>
      items.find(
        (v) => v.agreementKey === key && v.consentMode === "by_action" && v.currentVersion !== null,
      ),
    )
    .filter((v): v is Agreement & { currentVersion: NonNullable<Agreement["currentVersion"]> } =>
      Boolean(v?.currentVersion),
    );
}
export const quoteConfirmationKey = (quote: Quote) =>
  JSON.stringify({ ...quote, quotedAt: null, validUntil: null });
export const planActionLabel = (action: string) =>
  ({
    subscribe: "开通",
    renew: "续费",
    downgrade: "下期降级",
    renew_upgrade: "下期升级",
    upgrade: "立即升级",
  })[action] ?? "套餐变更";
export function quoteTermLabel(quote: Quote): string {
  if (quote.upgrade) return `沿用当前周期至 ${quote.upgrade.currentTermEndDate}`;
  return quote.newTerm
    ? `${quote.newTerm.startDate} 至 ${quote.newTerm.endDate}`
    : "以付款结果为准";
}
export function planPurchaseBody(
  quote: Quote,
  selection: Body<"m.plan.quote">,
  agreements: readonly Agreement[],
  channel: string,
  acknowledged: boolean,
): Body<"m.paymentOrder.create"> | null {
  const docs = purchaseAgreements(quote.policy, agreements);
  if (
    !purchaseVisible(quote.policy) ||
    !["subscribe", "renew", "downgrade", "renew_upgrade", "upgrade"].includes(quote.action) ||
    quote.planId !== selection.planId ||
    !["bank_transfer", "wechat_jsapi"].includes(channel) ||
    !enabledChannels(quote.policy).some((c) => c.code === channel) ||
    !docs.length ||
    docs.length !== quote.policy.copy.agreementKeys.length ||
    (quote.downgradeImpact !== null && !acknowledged)
  )
    return null;
  return {
    planId: quote.planId,
    ...(selection.intent ? { intent: selection.intent } : {}),
    ...(quote.months === null ? {} : { months: quote.months }),
    channel: channel as "bank_transfer" | "wechat_jsapi",
    expectAmountFen: quote.payFen,
    agreementVersionIds: docs.map((d) => d.currentVersion.agreementVersionId),
    ...(quote.downgradeImpact ? { acknowledgedDowngradeImpact: quote.downgradeImpact } : {}),
  };
}
/** 一次确认固定请求体和键；建单重放脱敏时只补读该单，不再生成交易。 */
export function createPurchaseIntent(
  api: Pick<PurchaseApi, "create" | "detail">,
  body: Body<"m.paymentOrder.create">,
  key: string,
  current = () => true,
) {
  let running = false,
    created: Data<"m.paymentOrder.create"> | null = null;
  return {
    get pending() {
      return running;
    },
    async submit(): Promise<Payment | null> {
      if (running || !current()) return null;
      running = true;
      try {
        created ??= await api.create(body, key);
        if (!current()) return null;
        const result =
          created.bankAccount?.accountNo === null
            ? await api.detail(created.paymentOrderId)
            : created;
        return current() ? result : null;
      } finally {
        running = false;
      }
    },
  };
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const number = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
const nullableString = (v: unknown) => v === null || typeof v === "string";
/** 仅处理 M1 subscribe 的返回报价；检查端上实际要展示与回传的全部字段。 */
function isSubscribeQuote(v: unknown): v is Quote {
  if (
    !record(v) ||
    v.action !== "subscribe" ||
    v.orderType !== "plan_new" ||
    !record(v.policy) ||
    !record(v.benefits) ||
    !record(v.formula)
  )
    return false;
  const p = v.policy,
    b = v.benefits;
  return (
    [
      v.planId,
      v.planRevisionId,
      v.planName,
      v.quotedAt,
      v.effectiveMode,
      v.formula.text,
      v.formula.code,
    ].every((x) => typeof x === "string") &&
    number(v.months) &&
    number(v.payFen) &&
    nullableString(v.fromPlanName) &&
    nullableString(v.validUntil) &&
    nullableString(v.firstGrantDate) &&
    v.upgrade === null &&
    v.downgradeImpact === null &&
    (v.promo === null ||
      (record(v.promo) &&
        v.promo.type === "previous_revision" &&
        typeof v.promo.appliedRevisionId === "string")) &&
    (v.newTerm === null ||
      (record(v.newTerm) &&
        typeof v.newTerm.startDate === "string" &&
        typeof v.newTerm.endDate === "string")) &&
    [b.monthlyPoints, b.discountBp, b.maxStores].every(number) &&
    (b.maxMembers === null || number(b.maxMembers)) &&
    typeof b.productionModel === "string" &&
    typeof b.schedulePriority === "string" &&
    typeof b.hasMonthlyReport === "boolean" &&
    typeof p.mode === "string" &&
    typeof p.isPriceShown === "boolean" &&
    typeof p.isPurchasePromptAllowed === "boolean" &&
    record(p.copy) &&
    [p.copy.planNounKey, p.copy.pointsNounKey, p.copy.payButtonKey].every(
      (x) => typeof x === "string",
    ) &&
    Array.isArray(p.copy.agreementKeys) &&
    p.copy.agreementKeys.every((x) => typeof x === "string") &&
    Array.isArray(p.channels) &&
    p.channels.every(
      (c) =>
        record(c) &&
        typeof c.code === "string" &&
        typeof c.isEnabled === "boolean" &&
        typeof c.isRecommended === "boolean" &&
        nullableString(c.hintKey),
    ) &&
    record(v.formula.args) &&
    Object.values(v.formula.args).every((x) => typeof x === "number")
  );
}
export function changedQuote(error: unknown): Quote | null {
  return error instanceof ApiError &&
    error.error === "QUOTE_CHANGED" &&
    record(error.details) &&
    error.details.kind === "plan" &&
    isSubscribeQuote(error.details.quote)
    ? error.details.quote
    : null;
}
export function existingOrder(error: unknown): string | null {
  return error instanceof ApiError &&
    ["OPEN_ORDER_EXISTS", "OPEN_ORDER_EXPIRING"].includes(error.error) &&
    record(error.details) &&
    typeof error.details.paymentOrderId === "string"
    ? error.details.paymentOrderId
    : null;
}
export const agreementStale = (error: unknown) =>
  error instanceof ApiError && error.error === "AGREEMENT_VERSION_STALE";
/** 换版后只刷新展示事实；新协议必须由用户再次确认，不能自动建单。 */
export async function reloadPurchaseConfirmation(
  api: Pick<PurchaseApi, "agreements" | "quote">,
  selection: Body<"m.plan.quote">,
) {
  const [agreements, quote] = await Promise.all([api.agreements(), api.quote(selection)]);
  return { agreements, quote };
}
export function paymentView(order: Payment): {
  title: string;
  description: string;
  canUpload: boolean;
} {
  if (order.isProcessingReceipt)
    return {
      title: "已收到付款，正在处理",
      description: "请稍后下拉刷新查看结果",
      canUpload: false,
    };
  if (order.status === "cancelled")
    return {
      title: "付款已取消",
      description: order.cancelReason ?? "这张付款单已关闭",
      canUpload: false,
    };
  if (order.status === "paid" && order.fulfillmentStatus === "done")
    return {
      title:
        order.type === "topup"
          ? "积分已到账"
          : order.type === "plan_upgrade"
            ? "套餐已升级"
            : order.type === "plan_renew"
              ? "续费已完成"
              : "套餐已开通",
      description: "有效期与已到账积分如下",
      canUpload: false,
    };
  if (order.status === "paid" || order.isProcessingReceipt)
    return {
      title: "已收到付款，正在处理",
      description: "请稍后下拉刷新查看结果",
      canUpload: false,
    };
  if (order.transferState === "proof_rejected")
    return {
      title: "凭证被驳回",
      description: order.latestTransferProof?.rejectNote ?? "请核对原因后重新上传凭证",
      canUpload: order.actions.includes("submit-proof"),
    };
  if (
    order.transferState === "proof_submitted" ||
    order.transferState === "confirm_review" ||
    order.status === "pending_confirmation"
  )
    return { title: "待财务确认", description: "凭证已收到，财务核对到账后开通", canUpload: false };
  if (order.channel === "wechat_jsapi")
    return {
      title: order.isConfirmingResult ? "正在确认付款结果" : "待微信支付",
      description: "到账与履约以后台查询结果为准，可查询或继续支付",
      canUpload: false,
    };
  return {
    title: "待上传转账凭证",
    description: "请按收款账户转账，备注付款单号并上传凭证",
    canUpload: order.actions.includes("submit-proof"),
  };
}
