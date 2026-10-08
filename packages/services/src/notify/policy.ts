import { addDays, atMinuteOfDay, calendarDate, minuteOfDay, parseHm } from "@liyoxi/shared/time";
import type { NotificationProviderResult } from "../providers/types.js";

/** Shanghai window is left closed/right open. Jitter applies only when deferred. */
export function notificationDueAt(
  now: Date,
  id: string,
  window: boolean,
  start = "08:00",
  end = "21:00",
): Date {
  if (!window) return now;
  const minute = minuteOfDay(now);
  const lo = parseHm(start);
  const hi = parseHm(end);
  if (minute >= lo && minute < hi) return now;
  const date = minute >= hi ? addDays(calendarDate(now), 1) : calendarDate(now);
  const jitter = [...id].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 301, 0);
  return new Date(atMinuteOfDay(date, lo).getTime() + jitter * 1000);
}

export const FALLBACK_REASONS = new Set([
  "no_quota",
  "no_target",
  "unconfigured",
  "slot_disabled",
  "policy_suppressed",
  "user_refused",
  "provider_rejected",
  "unknown_outcome",
  "claim_exhausted",
  "retry_exhausted",
]);

export interface SendVerdict {
  readonly success: boolean;
  readonly retry: boolean;
  readonly reason: "user_refused" | "provider_rejected" | "unknown_outcome";
  readonly code: string | null;
  readonly providerMsgId: string | null;
}

/** Legacy failure is unknown: only an explicit not-accepted result proves a safe retry. */
export function sendVerdict(result: NotificationProviderResult<unknown>): SendVerdict {
  if (result.ok)
    return {
      success: true,
      retry: false,
      reason: "provider_rejected",
      code: null,
      providerMsgId: result.providerMsgId ?? null,
    };
  const detail = result.notification;
  const unknown = detail === undefined || detail.acceptance === "unknown";
  return {
    success: false,
    retry: !unknown && ["rate_limited", "aborted"].includes(detail?.code ?? ""),
    reason: unknown
      ? "unknown_outcome"
      : ["no_quota", "user_refused"].includes(detail?.code ?? "")
        ? "user_refused"
        : "provider_rejected",
    code: detail?.code ?? null,
    providerMsgId: null,
  };
}

export const textLimit = (text: string, max: number): string => [...text].slice(0, max).join("");

export function externalAllowed(scene: string, channel: string, mode: string | null) {
  if (scene === "m.pay_success" && mode !== "in_app") return false;
  if (mode === "hidden" && scene === "m.points_changed") return false;
  if (mode === "hidden" && scene === "m.plan_expiring" && channel === "wx_subscribe") return false;
  return true;
}
