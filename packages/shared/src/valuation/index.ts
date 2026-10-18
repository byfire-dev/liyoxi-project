// D1 §7.7、07 §2.19：口径1，按单批次seq回放。只派生价值，不改变账本。
import type { EnumValue, POINT_BUCKET, POINT_ENTRY_VALUATION_EFFECT } from "@liyoxi/contract/enums";

type Bucket = EnumValue<typeof POINT_BUCKET>;
type Effect = EnumValue<typeof POINT_ENTRY_VALUATION_EFFECT>;
export interface ValuationEntry {
  readonly id: string;
  readonly seq: bigint;
  readonly fromBucket: Bucket;
  readonly toBucket: Bucket;
  readonly points: number;
  readonly pointHoldId: string | null;
}
export interface ValuationLot {
  readonly originalQty: number;
  readonly costBasisFen: number | null;
  /** 仅conversion批次：调用方按真实origin_entry取得原批次转出流水的价值。 */
  readonly resolvedConversionValueFen?: number;
}
export interface EntryValuation {
  readonly entryId: string;
  readonly seq: bigint;
  readonly effect: Effect;
  readonly valueFen: number;
  readonly remainingValueFen: number;
}
interface Pool {
  qty: number;
  value: number;
}
function integer(value: number, positive = false): number {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    throw new RangeError("估值数量或金额必须是安全范围内的非负整数，流水数量须为正");
  return value;
}
/** 比例向下取整；最后一笔精确取尽尾差。乘法用BigInt防止中间值丢精度。 */
function take(pool: Pool, qty: number): number {
  if (qty > pool.qty) throw new RangeError("估值流水超过所属价值池数量");
  const value = Number((BigInt(pool.value) * BigInt(qty)) / BigInt(pool.qty));
  pool.qty -= qty;
  pool.value -= value;
  return value;
}
function put(pool: Pool, qty: number, value: number): void {
  pool.qty = integer(pool.qty + qty);
  pool.value = integer(pool.value + value);
}

/**
 * 入参必须是单个批次完整且严格递增的流水前缀；不替调用方排序或补缺失事实。
 * conversion来源的归属/转出流向由DB读者核验，再把已回放的原流水价值传入。
 */
export function replayLotValuation(
  lot: ValuationLot,
  entries: readonly ValuationEntry[],
): EntryValuation[] {
  const qty = integer(lot.originalQty, true);
  if (lot.costBasisFen !== null && lot.resolvedConversionValueFen !== undefined)
    throw new TypeError("普通批次不能覆盖入账成本");
  const cost = lot.costBasisFen ?? lot.resolvedConversionValueFen;
  if (cost === undefined) throw new TypeError("转加购批次必须有原转出流水的估值");
  integer(cost);
  if (entries.length === 0) throw new RangeError("估值缺少批次入账流水");
  const remaining: Pool = { qty: 0, value: 0 };
  const expired: Pool = { qty: 0, value: 0 };
  const captured = new Map<string, Pool>();
  const buckets: Record<Exclude<Bucket, "external">, number> = {
    available: 0,
    held: 0,
    consumed: 0,
    expired: 0,
    revoked: 0,
    converted_out: 0,
    adjusted_out: 0,
  };
  const ids = new Set<string>();
  let previous = 0n;
  let received = false;
  return entries.map((entry) => {
    const q = integer(entry.points, true);
    if (!entry.id || ids.has(entry.id) || typeof entry.seq !== "bigint" || entry.seq <= previous)
      throw new RangeError("估值流水ID须唯一且seq严格递增");
    ids.add(entry.id);
    previous = entry.seq;
    let effect: Effect = "none";
    let value = 0;
    const pool = () => {
      if (!entry.pointHoldId) throw new TypeError("消耗或冲回流水缺少冻结单身份");
      let item = captured.get(entry.pointHoldId);
      if (!item) {
        item = { qty: 0, value: 0 };
        captured.set(entry.pointHoldId, item);
      }
      return item;
    };
    switch (`${entry.fromBucket}:${entry.toBucket}`) {
      case "external:available":
        if (received || q !== qty) throw new RangeError("批次入账数量不符或重复入账");
        received = true;
        effect = "inflow";
        value = cost;
        put(remaining, q, value);
        break;
      case "available:held":
      case "held:available":
        break;
      case "held:consumed":
        effect = "recognize";
        value = take(remaining, q);
        put(pool(), q, value);
        break;
      case "consumed:available":
        effect = "reverse";
        value = take(pool(), q);
        put(remaining, q, value);
        break;
      case "consumed:converted_out":
        effect = "reverse_transfer";
        value = take(pool(), q);
        break;
      case "consumed:expired":
        // 不予退回仍保持已确认收入；只缩小可冲回池，不进入清零可复活池。
        take(pool(), q);
        break;
      case "available:expired":
        effect = "recognize_breakage";
        value = take(remaining, q);
        put(expired, q, value);
        break;
      case "held:expired":
        effect = "recognize_breakage";
        value = take(remaining, q);
        break;
      case "expired:available":
        effect = "reverse_breakage";
        value = take(expired, q);
        put(remaining, q, value);
        break;
      case "expired:revoked":
        effect = "reverse_breakage_refund";
        value = take(expired, q);
        break;
      case "held:converted_out":
        effect = "transfer_out";
        value = take(remaining, q);
        break;
      case "available:revoked":
        effect = "refund_out";
        value = take(remaining, q);
        break;
      case "available:adjusted_out":
        effect = "adjust_out";
        value = take(remaining, q);
        break;
      default:
        throw new RangeError("估值收到未定义的积分流向");
    }
    if (entry.fromBucket !== "external") {
      if (!received || buckets[entry.fromBucket] < q)
        throw new RangeError("估值流水超过来源桶余额");
      buckets[entry.fromBucket] -= q;
    }
    if (entry.toBucket === "external") throw new RangeError("估值不允许流回external桶");
    buckets[entry.toBucket] = integer(buckets[entry.toBucket] + q);
    if (
      remaining.qty !== buckets.available + buckets.held ||
      remaining.value > cost ||
      (remaining.qty === 0 && remaining.value !== 0)
    )
      throw new RangeError("估值剩余数量或价值不守恒");
    return {
      entryId: entry.id,
      seq: entry.seq,
      effect,
      valueFen: value,
      remainingValueFen: remaining.value,
    };
  });
}
