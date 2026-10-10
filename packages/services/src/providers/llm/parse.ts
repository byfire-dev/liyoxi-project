import { LLM_LIMITS } from "./config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function strings(value: unknown, min: number, max: number, chars: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= min &&
    value.length <= max &&
    value.every((item: unknown) => text(item, chars))
  );
}

export type ChatContent =
  { kind: "json"; value: unknown } | { kind: "schema" } | { kind: "invalid" } | { kind: "refused" };

/** 外层允许供应商 usage/id 等协议字段；业务 JSON 必须严格匹配旧公开 DTO。 */
export function chatContent(value: unknown): ChatContent {
  const root = record(value);
  if (
    !root ||
    root.error !== undefined ||
    !Array.isArray(root.choices) ||
    root.choices.length !== 1
  )
    return { kind: "invalid" };
  const choice = record(root.choices[0]);
  const message = record(choice?.message);
  if (!choice || !message || message.role !== "assistant") return { kind: "invalid" };
  if (
    (message.refusal !== undefined && message.refusal !== null) ||
    (message.tool_calls !== undefined && message.tool_calls !== null) ||
    (message.function_call !== undefined && message.function_call !== null)
  )
    return { kind: "refused" };
  if (choice.finish_reason !== "stop" || typeof message.content !== "string")
    return { kind: "invalid" };
  try {
    return { kind: "json", value: JSON.parse(message.content) };
  } catch {
    return { kind: "schema" };
  }
}

export function tagOutput(value: unknown): { description: string; tags: string[] } | undefined {
  const data = record(value);
  if (
    !data ||
    Object.keys(data).length !== 2 ||
    !text(data.description, LLM_LIMITS.descriptionChars) ||
    !strings(data.tags, 0, LLM_LIMITS.tags, LLM_LIMITS.tagChars)
  )
    return undefined;
  return { description: data.description, tags: [...data.tags] };
}

export function pointOutput(value: unknown, maxPoints: number): { points: string[] } | undefined {
  const data = record(value);
  if (
    !data ||
    Object.keys(data).length !== 1 ||
    !strings(data.points, 1, maxPoints, LLM_LIMITS.pointChars)
  )
    return undefined;
  return { points: [...data.points] };
}
