import { BILLING_PARAM_KEY, DateSchema, PricingChangeCreateBodySchema } from "@liyoxi/contract";
import type { BillingParam } from "./api";
export const PARAM_LABELS: Record<BillingParam["key"], string> = {
  adUnitPoints: "每条广告积分",
  adFreeRevisions: "广告免费修改次数",
  topModelSurchargeBp: "顶级模型加扣比例（万分比）",
  cancelDeductionBp: "制作中取消扣除比例",
  expiredTermRefund: "原周期到期后退回去向",
  minLicenseMonths: "最短授权期（月）",
  renewalReminderDays: "到期提醒节点（提前天数）",
  prorationBaseDays: "升级折算基数（天）",
  planRefundWindowHours: "套餐退款窗口（小时）",
  enabledCycles: "可选购买周期（月）",
  maxScheduledTerms: "未来预约周期上限",
  noticeDays: "提前公告天数",
};
export const OBJECT_LABELS: Record<string, string> = {
  planConfirm: "方案确认后",
  adAndSample: "广告与样片阶段",
  samplePending: "样片待确认",
  postSample: "样片确认后",
  adInProduction: "广告制作中",
  merchant: "商家原因",
  platform: "平台原因",
  qualification: "资质原因",
};
const validDate = (v: unknown) => (DateSchema.safeParse(v).success ? String(v) : undefined);
export function paramsSearch(raw: Record<string, unknown>) {
  const page = Number(raw.page);
  return {
    tab: raw.tab === "history" ? ("history" as const) : ("current" as const),
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    pageSize:
      raw.pageSize === 20 || raw.pageSize === "20"
        ? (20 as const)
        : raw.pageSize === 50 || raw.pageSize === "50"
          ? (50 as const)
          : (10 as const),
    kind:
      raw.kind === "price_tier"
        ? ("price_tier" as const)
        : raw.kind === "billing_param"
          ? ("billing_param" as const)
          : undefined,
    key: BILLING_PARAM_KEY.values.find((v) => v === raw.key),
    createdFrom: validDate(raw.createdFrom),
    createdTo: validDate(raw.createdTo),
  };
}
export function paramText(value: unknown): string {
  if (value == null) return "—";
  if (Array.isArray(value)) return value.join("、") || "无节点";
  if (typeof value === "object" && value !== null)
    return Object.entries(value)
      .map(
        ([key, v]) =>
          `${OBJECT_LABELS[key] ?? key}：${v === null && ["planConfirm", "adAndSample", "samplePending", "postSample", "adInProduction"].includes(key) ? "由客服填写、财务核定" : paramText(v)}`,
      )
      .join("；");
  if (value === "addon") return "转为加购积分";
  if (value === "forfeit") return "不予退回";
  return String(value);
}
/** 仅将操作人选择的字段交canonical校验；不回写未选项，不删除0或null。 */
export function pricingChangeBody(input: {
  selected: BillingParam["key"][];
  values: Partial<Record<BillingParam["key"], unknown>>;
  effectiveDate: string | null;
  tiers?: Record<string, number | undefined>;
  note?: string;
  title?: string;
  summary?: string;
  summaryNoPrice?: string;
}) {
  return PricingChangeCreateBodySchema.parse({
    ...(input.tiers ? { tiers: input.tiers } : {}),
    ...(input.selected.length
      ? {
          params: input.selected.map((key) => ({
            key,
            value: input.values[key],
            effectiveDate: input.effectiveDate,
          })),
        }
      : {}),
    note: input.note || undefined,
    notice: {
      title: input.title || undefined,
      summary: input.summary || undefined,
      summaryNoPrice: input.summaryNoPrice || undefined,
    },
  });
}
