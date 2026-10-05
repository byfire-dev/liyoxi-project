// 计费参数 billing_param.value 的结构（W1-10 读侧先用；写侧在 M3、M4）。依据：07 分组 第 4.3 节。
// 每个键一份 schema，值是该键的完整值；数值与范围只在这里校验，库只校验 JSON 类型。
import { BpSchema, PointsSchema } from "../common/scalars.js";
import type { BILLING_PARAM_KEY, EnumValue } from "../enums/index.js";
import { z } from "../zod.js";

const bp = BpSchema.min(0).max(10_000);
/** 原周期已结束的套餐积分退回去向：转为加购积分，或不予退回 */
const refundTarget = z.enum(["addon", "forfeit"]);

export const BILLING_PARAM_VALUES = {
  /** 广告每条积分 */
  adUnitPoints: PointsSchema.min(1).max(1000),
  /** 每条广告免费修改次数 */
  adFreeRevisions: z.int().min(0).max(5),
  /** 顶级模型加扣比例 */
  topModelSurchargeBp: bp,
  /** 制作中取消的扣除比例；postSample 为空 = 由客服填写、财务核定 */
  cancelDeductionBp: z.strictObject({
    planConfirm: bp.nullable(),
    adAndSample: bp.nullable(),
    samplePending: bp.nullable(),
    postSample: bp.nullable(),
    adInProduction: bp.nullable(),
  }),
  /** 原周期已结束的退回去向，按退回原因类别 */
  expiredTermRefund: z.strictObject({
    merchant: refundTarget,
    platform: refundTarget,
    qualification: refundTarget,
  }),
  /** 最短可订授权期（月） */
  minLicenseMonths: z.int().min(1).max(12),
  /** 到期与清零提醒节点（提前几天） */
  renewalReminderDays: z.array(z.int().min(1)),
  /** 升级补差的计算天数 */
  prorationBaseDays: z.int().min(1),
  /** 套餐退款窗口（小时） */
  planRefundWindowHours: z.int().min(0),
  /** 可选购买周期（月） */
  enabledCycles: z.array(z.int().min(1)).min(1),
  /** 最多预约几个未生效周期 */
  maxScheduledTerms: z.int().min(0),
  /** 提前公告天数 */
  noticeDays: z.int().min(0),
} as const satisfies Record<EnumValue<typeof BILLING_PARAM_KEY>, z.ZodType>;

/** 某一时刻生效的全部计费参数 */
export type BillingParams = {
  [K in keyof typeof BILLING_PARAM_VALUES]: z.infer<(typeof BILLING_PARAM_VALUES)[K]>;
};
