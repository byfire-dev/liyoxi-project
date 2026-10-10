import type { AsrSegment, AsrTaskStatus } from "../types.js";

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function taskId(value: unknown): string | undefined {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === "string" &&
    /^(?:0|[1-9][0-9]{0,19})$/.test(text) &&
    BigInt(text) <= 18446744073709551615n
    ? text
    : undefined;
}

/** Node24 reviver 的 source 是原始 JSON token，不能先舍入 uint64 再转字符串。 */
export function parseResponse(text: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(
    text,
    (key: string, value: unknown, context?: { source?: string }): unknown => {
      if (key !== "TaskId") return value;
      const raw = typeof value === "number" ? (context?.source ?? value) : value;
      const id = taskId(raw);
      if (id === undefined) throw new TypeError("录音转写任务号不合法");
      return id;
    },
  );
  return record(record(parsed)?.Response);
}
export function requestId(response: Record<string, unknown>): string | undefined {
  const value = response.RequestId;
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
export function errorCode(response: Record<string, unknown>): string | undefined {
  const value = record(response.Error)?.Code;
  return typeof value === "string" && /^[A-Za-z0-9_.]{1,128}$/.test(value) ? value : undefined;
}
export function rejectedBeforeAcceptance(code: string): boolean {
  return /^(?:AuthFailure|InvalidParameter|InvalidParameterValue|MissingParameter|UnknownParameter|RequestLimitExceeded)(?:\.|$)/.test(
    code,
  );
}
export function parseTask(
  response: Record<string, unknown>,
  expected: string,
): AsrTaskStatus | undefined {
  const data = record(response.Data);
  const id = taskId(data?.TaskId);
  const request = requestId(response);
  if (!data || !id || id !== expected || !request) return undefined;
  const status = data.Status;
  const expectedNames = ["waiting", "doing", "success", "failed"];
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 0 ||
    status > 3 ||
    data.StatusStr !== expectedNames[status]
  )
    return undefined;
  const identity = { taskId: id, requestId: request };
  if (status === 0) return { ...identity, state: "waiting" };
  if (status === 1) return { ...identity, state: "doing" };
  if (status === 3) return { ...identity, state: "failed", code: "recognition_failed" };
  const duration = data.AudioDuration;
  const text = data.Result;
  const details = data.ResultDetail;
  if (
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 18000 ||
    typeof text !== "string" ||
    !text.trim() ||
    !Array.isArray(details) ||
    details.length === 0
  )
    return undefined;
  const segments: AsrSegment[] = [];
  for (const detail of details) {
    const sentence = record(detail);
    const start = sentence?.StartMs;
    const end = sentence?.EndMs;
    const words = sentence?.FinalSentence;
    if (
      typeof words !== "string" ||
      !words.trim() ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > Math.ceil(duration * 1000)
    )
      return undefined;
    segments.push({ text: words, startMs: start, endMs: end });
  }
  return { ...identity, state: "succeeded", text, durationSec: duration, segments };
}
