import type { operations } from "@liyoxi/contract/types/admin";
import { IdSchema } from "@liyoxi/contract";
import { formatMoney } from "@liyoxi/shared/format/money";
import { newIdempotencyKey } from "../../../lib/idempotency";
import type { AccessSnapshot } from "../../../lib/permissions";
export type Body<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { "application/json": infer T } };
}
  ? T
  : never;
export function billingScope(access: AccessSnapshot | null) {
  return JSON.stringify([
    access?.staff.id,
    access?.staff.roleKey,
    access?.isLead,
    access?.dataScope,
    access?.moduleLevels,
    access?.actions,
  ]);
}
/** Decimal-string金额只作显示，不转Number、不推算报价。0与未提供不同。 */
export function moneyText(value: number | string | null | undefined): string {
  if (value == null) return "—";
  if (typeof value === "number") return formatMoney(value);
  if (!/^\d+$/.test(value)) return "—";
  const digits = value.padStart(3, "0"),
    cents = digits.slice(-2),
    whole = digits
      .slice(0, -2)
      .replace(/^0+(?=\d)/, "")
      .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `¥${whole}${cents === "00" ? "" : `.${cents}`}`;
}
export const pointsText = (value: number | null | undefined) =>
  value == null ? "—" : `${value.toLocaleString("zh-CN")} 积分`;
export const idValue = (value: unknown) =>
  IdSchema.safeParse(value).success ? String(value) : undefined;
export function plansSearch(raw: Record<string, unknown>) {
  const page = Number(raw.revisionPage);
  return {
    planId: idValue(raw.planId),
    revisionPage: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    revisionSize:
      raw.revisionSize === 20 || raw.revisionSize === "20"
        ? 20
        : raw.revisionSize === 50 || raw.revisionSize === "50"
          ? 50
          : 10,
    includeDelisted: raw.includeDelisted !== false && raw.includeDelisted !== "false",
  };
}
/** 本包表单的单意图：同步忙锁、内容变更换key、失败重用、关闭/角色切换丢弃迟到结果。 */
export function createBillingIntent(action: string, makeKey = () => newIdempotencyKey(action)) {
  let key = makeKey(),
    fingerprint: string | undefined,
    busy = false,
    closed = false,
    generation = 0,
    lifetime = new AbortController();
  return {
    get pending() {
      return busy;
    },
    get signal() {
      return lifetime.signal;
    },
    activate() {
      if (closed) {
        closed = false;
        lifetime = new AbortController();
      }
    },
    change() {
      if (!busy && !closed) {
        key = makeKey();
        fingerprint = undefined;
      }
    },
    close() {
      closed = true;
      generation += 1;
      busy = false;
      lifetime.abort();
    },
    async submit<T>(body: unknown, send: (key: string, signal: AbortSignal) => Promise<T>) {
      if (closed || busy) return undefined;
      const signature = JSON.stringify(body);
      if (fingerprint !== undefined && fingerprint !== signature) key = makeKey();
      fingerprint = signature;
      busy = true;
      const own = generation,
        signal = lifetime.signal;
      try {
        const result = await send(key, signal);
        if (closed || signal.aborted || own !== generation) return undefined;
        key = makeKey();
        fingerprint = undefined;
        return result;
      } finally {
        if (own === generation) busy = false;
      }
    },
  };
}
/** 报价/详情随输入切换失效；不把上次报价装到下一主体/版本。 */
export function createBillingRead() {
  let generation = 0,
    active = true,
    controller: AbortController | undefined;
  return {
    activate() {
      active = true;
    },
    invalidate() {
      generation += 1;
      controller?.abort();
    },
    close() {
      active = false;
      generation += 1;
      controller?.abort();
    },
    async run<T>(read: (signal: AbortSignal) => Promise<T>) {
      if (!active) return undefined;
      controller?.abort();
      controller = new AbortController();
      const own = ++generation,
        signal = controller.signal;
      try {
        const result = await read(signal);
        return active && own === generation && !signal.aborted ? result : undefined;
      } catch (error) {
        if (active && own === generation && !signal.aborted) throw error;
        return undefined;
      }
    },
  };
}
