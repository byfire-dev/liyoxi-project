// 全仓唯一的取整函数（01 第 6.3 节；ADR-007；D1 第 3.3 节）。
//
// 金额（分）、积分、比例（万分比）都是整数。凡是“乘完再除、结果要取整”的地方只许调这里：
// 订剧、广告、升级补发积分、升级补交金额、取消扣除额。
// 价值分摊不用它，用向下取整加尾差，见 ../alloc。
//
// 口径：四舍五入（HALF_UP）。用 BigInt 做整数运算，中间的乘积不受 2^53 的限制；
// 入参与返回值是普通整数，越界即抛错，不悄悄丢精度。

function factor(value: number, label: string, min: 0 | 1): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`取整：${label}必须是安全整数，收到 ${String(value)}`);
  }
  if (value < min) {
    throw new RangeError(`取整：${label}不得小于 ${min}，收到 ${value}`);
  }
  return BigInt(value);
}

function product(factors: readonly number[], label: string, min: 0 | 1): bigint {
  if (factors.length === 0) throw new RangeError(`取整：${label}至少要有一个因数`);
  let result = 1n;
  for (const value of factors) result *= factor(value, label, min);
  return result;
}

/**
 * round(分子各因数之积 ÷ 分母各因数之积)，四舍五入。
 *
 * 分子的因数是非负整数，分母的因数是正整数。例：9 折后的积分 = `divRoundHalfUp([P, 9000], [10000])`。
 * 先乘后除、只取整一次：因数拆开传，是为了让乘积在 BigInt 里算，不在调用方用浮点先乘。
 */
export function divRoundHalfUp(
  numerators: readonly number[],
  denominators: readonly number[],
): number {
  const n = product(numerators, "分子", 0);
  const d = product(denominators, "分母", 1);
  const rounded = (2n * n + d) / (2n * d);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`取整：结果 ${rounded.toString()} 超出安全整数范围`);
  }
  return Number(rounded);
}
