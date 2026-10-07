import { newIdempotencyKey } from "../../../lib/idempotency";
import { readQueueSearch } from "../../../lib/queue";
import type { PushBody, Template } from "./api";
export const DELIVERIES_KEY = ["publish", "deliveries"] as const;
export function deliverySearch(raw: Readonly<Record<string, unknown>>) {
  const search = readQueueSearch(raw);
  return {
    ...search,
    tab: search.tab === "delivered_today" ? "delivered_today" : "delivering",
    q: search.q?.slice(0, 40),
  };
}
export function pushBody(
  template: Template | undefined,
  checked: readonly string[],
  abnormalAccount = false,
): PushBody | null {
  if (
    !template?.items.length ||
    template.items.some((item) => !checked.includes(item.key)) ||
    (abnormalAccount && !checked.includes("ack:abnormal"))
  )
    return null;
  return {
    ...(abnormalAccount ? { ackAbnormalAccount: true } : {}),
    precheck: {
      checklistVersionNo: template.versionNo,
      results: template.items.map((item) => ({ key: item.key, result: "pass" })),
    },
  };
}
/** 本包两个工作台共用的私有意图边界：网络重试保留键，事实或输入变化换键。 */
export function createIntent(newKey = () => newIdempotencyKey("publish-delivery")) {
  let busy = false,
    fingerprint = "",
    key = "";
  return async <T>(payload: unknown, send: (key: string) => Promise<T>): Promise<T | null> => {
    if (busy) return null;
    const next = JSON.stringify(payload);
    if (next !== fingerprint) {
      fingerprint = next;
      key = newKey();
    }
    busy = true;
    try {
      return await send(key);
    } finally {
      busy = false;
    }
  };
}
