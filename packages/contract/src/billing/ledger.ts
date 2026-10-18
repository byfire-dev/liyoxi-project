// 账本操作的展示文案码与参数（ledger_operation.title_code、title_args；W1-10）。
// 依据：07 分组 第 4.6 节；m07 第 4.5 节（清单在接口契约阶段定，商家端与后台流水共用）。
// 库里不存成品字符串：文案由码与参数拼出；参数只放数字、业务单号、日期与剧名这类短文本。
// 这里登记 M1 的十种操作用到的码（grant、purchase、hold、capture、release、refund、expire、adjust、
// addon_suspend、addon_resume）；升级补发、延长补批、套餐退款作废、退款闸门、人工修复的码随 M4。
import { BpSchema, DateSchema, FenSchema, PointsSchema } from "../common/scalars.js";
import {
  PAY_CHANNEL,
  POINT_ADJUSTMENT_REQUEST_REASON_CODE,
  POINT_HOLD_PURPOSE,
  RETURN_REASON_CLASS,
} from "../enums/index.js";
import { zodEnum } from "../enums/zod.js";
import { z } from "../zod.js";

/** 短文本：单号、套餐名、剧名。不放自由文本 */
const short = z.string().min(1).max(64);
const positivePoints = PointsSchema.positive();
const term = { termStartDate: DateSchema, termEndDate: DateSchema } as const;

export const LEDGER_TITLE_ARGS = {
  /** 新开通或过期后重新开通的第 0 个月发放 */
  grant_open: z.strictObject({ planName: short, ...term, billingOrderNo: short }),
  /** 续接周期的第 0 个月发放 */
  grant_term: z.strictObject({ planName: short, ...term }),
  /** 季付、年付其后各月发放 */
  grant_monthly: z.strictObject({ planName: short, monthNo: z.int().positive() }),
  grant_upgrade: z.strictObject({
    toMonthlyPoints: positivePoints,
    fromMonthlyPoints: positivePoints,
    remainingDays: z.int().nonnegative(),
    baseDays: z.int().positive(),
    billingOrderNo: short,
  }),
  /** 加购入账 */
  topup: z.strictObject({
    billingOrderNo: short,
    payFen: FenSchema.nonnegative(),
    channel: zodEnum(PAY_CHANNEL),
  }),
  /** 订购冻结：取整单的值，同一订购单的每次冻结传相同参数 */
  order_hold: z.strictObject({
    dramaTitles: z.array(short).min(1).max(50),
    count: z.int().positive(),
    pricePoints: z.array(positivePoints).min(1).max(50),
    discountBp: BpSchema.nonnegative(),
    surchargeBp: BpSchema.nonnegative(),
  }),
  /** 广告冻结（一条一行） */
  ad_hold: z.strictObject({
    adNo: short,
    unitPoints: positivePoints,
    discountBp: BpSchema.nonnegative(),
  }),
  /** 冻结转扣减 */
  capture: z.strictObject({
    refType: zodEnum(POINT_HOLD_PURPOSE),
    refNo: short,
    count: z.int().positive(),
  }),
  /** 超次修改 */
  ad_revision_charge: z.strictObject({
    adNo: short,
    unitPoints: positivePoints,
    discountBp: BpSchema.nonnegative(),
  }),
  /** 开工前取消退回 */
  release: z.strictObject({ refNo: short, dramaTitles: z.array(short).max(50) }),
  /** 开工后退回 */
  refund: z.strictObject({
    refNo: short,
    reasonClass: zodEnum(RETURN_REASON_CLASS),
    isConversion: z.boolean(),
  }),
  /** 期末清零 */
  term_expire: z.strictObject(term),
  /** 手动调整。note 是给商家看的一句短说明 */
  adjust: z.strictObject({
    reasonCode: zodEnum(POINT_ADJUSTMENT_REQUEST_REASON_CODE),
    note: z.string().max(200).optional(),
  }),
  /** 补偿到期复活，冲回原清零积分。 */
  unexpire: z.strictObject({ days: z.int().min(1).max(90) }),
  /** 套餐过期，加购积分停用 */
  addon_suspend: z.strictObject({ termEndDate: DateSchema }),
  /** 续费后加购积分恢复 */
  addon_resume: z.strictObject({ termEndDate: DateSchema }),
} as const satisfies Record<string, z.ZodType>;

export type LedgerTitleCode = keyof typeof LEDGER_TITLE_ARGS;
export const LEDGER_TITLE_CODES = Object.keys(LEDGER_TITLE_ARGS) as LedgerTitleCode[];
/** 某个文案码的参数 */
export type LedgerTitleArgs<C extends LedgerTitleCode = LedgerTitleCode> = z.infer<
  (typeof LEDGER_TITLE_ARGS)[C]
>;

/** 写入前校验一遍：码不在清单里、参数不合结构即抛错（代码缺陷，不是用户输入） */
export function parseLedgerTitleArgs<C extends LedgerTitleCode>(
  code: C,
  args: unknown,
): LedgerTitleArgs<C> {
  if (!Object.hasOwn(LEDGER_TITLE_ARGS, code)) {
    throw new TypeError(`账本文案码 ${JSON.stringify(code)} 不在登记里`);
  }
  return LEDGER_TITLE_ARGS[code].parse(args) as LedgerTitleArgs<C>;
}
