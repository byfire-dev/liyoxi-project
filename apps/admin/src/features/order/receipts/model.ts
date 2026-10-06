import { yuanToFen } from "@liyoxi/shared/format/money";
import { newIdempotencyKey } from "../../../lib/idempotency";
import type { Body } from "./api";
import { ReceiptFailure } from "./api";
export type BankConflict = { ref: string; payerBank: { code: string; name: string } | null };
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
export function bankConflicts(error: unknown): BankConflict[] | null {
  if (!(error instanceof ReceiptFailure) || error.failure.symbol !== "BANK_SERIAL_DUPLICATE")
    return null;
  const details = error.failure.body?.details;
  if (!record(details) || !Array.isArray(details.conflicts)) return null;
  const result: BankConflict[] = [];
  for (const item of details.conflicts) {
    if (!record(item) || typeof item.ref !== "string") return null;
    let payerBank: BankConflict["payerBank"] = null;
    if (item.payerBank !== null) {
      if (
        !record(item.payerBank) ||
        typeof item.payerBank.code !== "string" ||
        typeof item.payerBank.name !== "string"
      )
        return null;
      payerBank = { code: item.payerBank.code, name: item.payerBank.name };
    }
    result.push({ ref: item.ref, payerBank });
  }
  return result;
}
export function receivedFen(value: string): number | null {
  try {
    const fen = yuanToFen(value);
    return Number.isSafeInteger(fen) && fen > 0 ? fen : null;
  } catch {
    return null;
  }
}
/** 同一请求体重试沿用键，修改内容是新意图；同步闩拦住同一事件循环重复提交。 */
export function createReceiptIntent<
  B extends Body<"admin.transferProof.confirm"> | Body<"admin.transferProof.reject">,
  R,
>(
  action: string,
  call: (body: B, key: string) => Promise<R>,
  key = () => newIdempotencyKey(action),
) {
  let fingerprint: string | null = null,
    intentKey: string | null = null,
    running = false;
  return {
    async submit(body: B): Promise<R | null> {
      if (running) return null;
      const next = JSON.stringify(body);
      if (next !== fingerprint) {
        intentKey = key();
        fingerprint = next;
      }
      const ownKey = intentKey!;
      running = true;
      try {
        return await call(body, ownKey);
      } finally {
        running = false;
      }
    },
  };
}
