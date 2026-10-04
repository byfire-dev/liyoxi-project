// 三个报价函数（03 第 2.5、2.7 节；D1 第 5.1 节）。不读库、不取当前时间。
// 商家端报价、提交订购时的锁内重算、后台试算器调用的是同一份实现。
// 取 P、R、T 的服务函数在账本包；这里只管算。

import { divRoundHalfUp } from "./round.js";

/** 万分比的基数：9 折 = 9000，20% = 2000 */
export const BP_BASE = 10_000;

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`计价：${label}必须是非负整数，收到 ${String(value)}`);
  }
  return value;
}

function basisPoints(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > BP_BASE) {
    throw new RangeError(
      `计价：${label}是万分比，须在 0 到 ${BP_BASE} 之间，收到 ${String(value)}`,
    );
  }
  return value;
}

export interface DramaQuoteInput {
  /** P：剧目积分价 */
  listPricePoints: number;
  /** R：套餐折扣率，万分比 */
  discountBp: number;
  /** 顶级模型加扣比例的参数值，万分比。是否适用由下面两个布尔决定 */
  topModelSurchargeBp: number;
  /** 商家是否选用顶级模型 */
  isTopModelSelected: boolean;
  /** 套餐的制作模型已是顶级（旗舰版）：是则不加扣 */
  isTopModelIncluded: boolean;
}

export interface DramaQuote {
  /** P */
  listPricePoints: number;
  /** R */
  discountBp: number;
  /** 实际适用的 T：旗舰版或未选用顶级模型时为 0 */
  surchargeBp: number;
  /** S = round(P × R × (1 + T)) */
  chargePoints: number;
  /** 折扣行：round(P × R) − P，不大于 0 */
  discountDeltaPoints: number;
  /** 加扣行：S − round(P × R)，不小于 0 */
  surchargeDeltaPoints: number;
}

/**
 * 订一部剧：S = round(P × R × (1 + T))。
 *
 * 展示用的两行从 S 反推，保证 P + 折扣行 + 加扣行 一定等于 S。
 */
export function quoteDramaItem(input: DramaQuoteInput): DramaQuote {
  const listPricePoints = nonNegativeInteger(input.listPricePoints, "积分价");
  const discountBp = basisPoints(input.discountBp, "折扣率");
  const paramBp = basisPoints(input.topModelSurchargeBp, "顶级模型加扣比例");
  const surchargeBp = input.isTopModelIncluded || !input.isTopModelSelected ? 0 : paramBp;

  const chargePoints = divRoundHalfUp(
    [listPricePoints, discountBp, BP_BASE + surchargeBp],
    [BP_BASE, BP_BASE],
  );
  const discounted = divRoundHalfUp([listPricePoints, discountBp], [BP_BASE]);
  return {
    listPricePoints,
    discountBp,
    surchargeBp,
    chargePoints,
    discountDeltaPoints: discounted - listPricePoints,
    surchargeDeltaPoints: chargePoints - discounted,
  };
}

export interface DramaOrderQuote {
  items: DramaQuote[];
  /** ΣS：逐部取整后求和，不是对合计取整 */
  totalChargePoints: number;
}

/** 一次订多部剧：逐部计算、逐部取整，合计 = 各部之和 */
export function quoteDramaItems(inputs: readonly DramaQuoteInput[]): DramaOrderQuote {
  const items = inputs.map(quoteDramaItem);
  let totalChargePoints = 0;
  for (const item of items) totalChargePoints += item.chargePoints;
  if (!Number.isSafeInteger(totalChargePoints)) {
    throw new RangeError("计价：合计超出安全整数范围");
  }
  return { items, totalChargePoints };
}

/** 一条广告，或一次超出免费次数的修改：round(单价 × R) */
export function quoteAd(unitPoints: number, discountBp: number): number {
  return divRoundHalfUp(
    [nonNegativeInteger(unitPoints, "广告单价"), basisPoints(discountBp, "折扣率")],
    [BP_BASE],
  );
}

/** 多条广告：按条取整，再乘条数 */
export function quoteAds(unitPoints: number, discountBp: number, count: number): number {
  const total = quoteAd(unitPoints, discountBp) * nonNegativeInteger(count, "广告条数");
  if (!Number.isSafeInteger(total)) throw new RangeError("计价：合计超出安全整数范围");
  return total;
}

export interface UpgradeQuoteInput {
  /** 每月差价（分）= 目标版本的月度金额 − 当前周期的月度金额 */
  feeDeltaPerMonthFen: number;
  /** 每月积分差 = 目标版本每月积分 − 当前每月积分 */
  pointsDeltaPerMonth: number;
  /** 本计费月剩余天数，当天不计，已按基准天数封顶（见 ../period 的 upgradePosition） */
  remainingDays: number;
  /** 折算的基准天数：参数 prorationBaseDays，默认 30。由调用方传入，这里不写死 */
  baseDays: number;
  /** 其后已预付的整月数：月付为 0 */
  remainingFullMonths: number;
}

export interface UpgradeQuote {
  /** 应补交 = 本月折算差价 + 每月差价 × 其后已预付的整月数 */
  payFen: number;
  /** 本月折算差价 = round(每月差价 × 剩余天数 ÷ 基准天数) */
  proratedFen: number;
  /** 立即补发的套餐积分 = round(每月积分差 × 剩余天数 ÷ 基准天数) */
  topupPoints: number;
}

/**
 * 升级补差：当月按剩余天数折算，其后已预付的整月补全额差价。
 *
 * 差价或积分差为负（目标版本后来降过价）不在这里处理：调用方不提供自助升级，不应走到这里。
 */
export function quoteUpgrade(input: UpgradeQuoteInput): UpgradeQuote {
  const feeDelta = nonNegativeInteger(input.feeDeltaPerMonthFen, "每月差价");
  const pointsDelta = nonNegativeInteger(input.pointsDeltaPerMonth, "每月积分差");
  const remainingDays = nonNegativeInteger(input.remainingDays, "剩余天数");
  const fullMonths = nonNegativeInteger(input.remainingFullMonths, "其后已预付的整月数");
  const baseDays = input.baseDays;
  if (!Number.isSafeInteger(baseDays) || baseDays < 1) {
    throw new RangeError(`计价：基准天数必须是正整数，收到 ${String(baseDays)}`);
  }
  if (remainingDays > baseDays) {
    throw new RangeError(`计价：剩余天数 ${remainingDays} 超过基准天数 ${baseDays}`);
  }

  const proratedFen = divRoundHalfUp([feeDelta, remainingDays], [baseDays]);
  const payFen = proratedFen + feeDelta * fullMonths;
  if (!Number.isSafeInteger(payFen)) throw new RangeError("计价：应补交金额超出安全整数范围");
  return {
    payFen,
    proratedFen,
    topupPoints: divRoundHalfUp([pointsDelta, remainingDays], [baseDays]),
  };
}
