// billing 的种子数据（W0-21）：三个套餐与首版价目、积分包、等级模板价、12 个计费参数、估值口径版本 1。
// 数值取 PRD 与后台原型的产品默认值（计划 第 4.1 节 E13：真实的价目初始值没到位前用它）；上线前由业主核定，
// 之后在后台改：价目、模板价、参数都是带生效时间的修订，种子只在某个键一行都没有时写初始行。
// 出处：07 分组 第 2.1、2.2、2.4、2.5、2.7、2.18 节，第 4.1、4.3、4.7 节；原型 admin/Plans、PointPacks、Params。
import type {
  BILLING_PARAM_KEY,
  EnumValue,
  HEAT_TIER,
  PRODUCTION_MODEL,
  SCHEDULE_PRIORITY,
} from "@liyoxi/contract";

export interface PlanSeed {
  readonly code: string;
  readonly name: string;
  /** 升降级比较 */
  readonly rank: number;
  readonly monthlyFeeFen: number;
  readonly monthlyPoints: number;
  /** 订剧与广告折扣（万分比）：原价 10000 */
  readonly discountBp: number;
  readonly productionModel: EnumValue<typeof PRODUCTION_MODEL>;
  readonly maxStores: number;
  /** 成员数上限；null = 不限 */
  readonly maxMembers: number | null;
  readonly schedulePriority: EnumValue<typeof SCHEDULE_PRIORITY>;
  readonly hasMonthlyReport: boolean;
}

/** 可选购买周期（月）的初始值；各套餐首版价目的 cycle_prices 按它出键 */
export const INITIAL_CYCLES: readonly number[] = [1, 3, 12];

export const PLAN_SEEDS: readonly PlanSeed[] = [
  {
    code: "basic",
    name: "基础版",
    rank: 1,
    monthlyFeeFen: 300_000,
    monthlyPoints: 3000,
    discountBp: 10_000,
    productionModel: "standard",
    maxStores: 1,
    maxMembers: 3,
    schedulePriority: "standard",
    hasMonthlyReport: false,
  },
  {
    code: "pro",
    name: "专业版",
    rank: 2,
    monthlyFeeFen: 600_000,
    monthlyPoints: 6600,
    discountBp: 9000,
    productionModel: "advanced",
    maxStores: 3,
    maxMembers: 10,
    schedulePriority: "priority",
    hasMonthlyReport: true,
  },
  {
    code: "flagship",
    name: "旗舰版",
    rank: 3,
    monthlyFeeFen: 1_200_000,
    monthlyPoints: 14_400,
    discountBp: 8000,
    productionModel: "top",
    maxStores: 10,
    maxMembers: null,
    schedulePriority: "rush",
    hasMonthlyReport: true,
  },
];

/** 首版价目各周期的总价：月费 × 月数，没有季付、年付优惠 */
export function cyclePricesOf(plan: PlanSeed): Record<string, number> {
  return Object.fromEntries(
    INITIAL_CYCLES.map((months) => [String(months), plan.monthlyFeeFen * months]),
  );
}

/** 加购积分包：1 积分 1 元，四档 */
export const POINT_PACK_SEEDS: readonly { readonly points: number; readonly priceFen: number }[] = [
  1000, 3000, 5000, 10_000,
].map((points) => ({ points, priceFen: points * 100 }));

/** 等级模板积分价 */
export const PRICE_TIER_SEEDS: Readonly<Record<EnumValue<typeof HEAT_TIER>, number>> = {
  S: 3000,
  A: 2000,
  B: 1600,
  C: 1000,
};

/** 12 个计费参数的初始值（07 分组 第 4.3 节“默认值”一栏） */
export const BILLING_PARAM_SEEDS: Readonly<Record<EnumValue<typeof BILLING_PARAM_KEY>, unknown>> = {
  adUnitPoints: 50,
  adFreeRevisions: 2,
  topModelSurchargeBp: 2000,
  cancelDeductionBp: {
    planConfirm: 1000,
    adAndSample: 3000,
    samplePending: 5000,
    postSample: null,
    // 占位：待业务给数
    adInProduction: 10_000,
  },
  expiredTermRefund: { merchant: "addon", platform: "addon", qualification: "addon" },
  minLicenseMonths: 3,
  renewalReminderDays: [7, 3, 1],
  prorationBaseDays: 30,
  planRefundWindowHours: 168,
  enabledCycles: [...INITIAL_CYCLES],
  maxScheduledTerms: 1,
  noticeDays: 30,
};

/** 估值口径版本 1（07 分组 第 2.18、4.7 节） */
export const VALUATION_POLICY_SEED = {
  versionNo: 1,
  description: "套餐款 100% 计入积分价值；按数量等比分摊时向下取整，尾差由最后一笔吃掉",
  rule: { costBasis: "as_recorded", rounding: "floor", remainder: "last_take" },
} as const;
