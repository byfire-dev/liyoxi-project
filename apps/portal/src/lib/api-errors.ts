import { ERRORS, isErrorSymbol } from "@liyoxi/contract/errors";
import type { components } from "@liyoxi/contract/types/portal";

type FieldError = NonNullable<components["schemas"]["ErrorBody"]["fieldErrors"]>[number];
export type PortalErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

/** Never retain the original response, request, cause, or a server-provided message. */
export class PortalApiError extends Error {
  override readonly name = "PortalApiError";
  constructor(
    readonly error: string,
    readonly status = 0,
    readonly requestId: string | null = null,
    readonly details: PortalErrorDetails = {},
    readonly fieldErrors: readonly FieldError[] = [],
    readonly retryAfter: number | null = null,
  ) {
    super(isErrorSymbol(error) ? ERRORS[error].message : "请求未完成，请稍后重试");
  }
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function safeRequestId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f-]{8,64}$/i.test(value) ? value : null;
}

const reasons = new Set([
  "not_found",
  "expired",
  "revoked",
  "authorizer_invalid",
  "owner_revoked",
  "membership_changed",
  "account_action",
  "portal_logout",
  "rejected",
  "consumed",
  "approved",
  "secret_mismatch",
  "attempts_exceeded",
  "window_passed",
  "superseded",
  "missing",
  "not_delivered",
  "release_closed",
  "order_item_closed",
  "usage_ended",
  "file_unavailable",
]);

function safeDetails(value: unknown): PortalErrorDetails {
  const source = object(value);
  const result: Record<string, string | number | boolean | null> = {};
  if (!source) return result;
  for (const key of ["reason", "revokeReason"] as const) {
    const item = source[key];
    if (item === null || (typeof item === "string" && reasons.has(item))) result[key] = item;
  }
  for (const key of ["currentVersionNo", "retryAfter"] as const) {
    const item = source[key];
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) result[key] = item;
  }
  if (typeof source.canRegenerate === "boolean") result.canRegenerate = source.canRegenerate;
  if (
    typeof source.expiresAt === "string" &&
    source.expiresAt.length <= 30 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(source.expiresAt) &&
    Number.isFinite(Date.parse(source.expiresAt))
  ) {
    result.expiresAt = source.expiresAt;
  }
  return Object.freeze(result);
}

function safeFields(value: unknown): readonly FieldError[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((item) => {
    const field = object(item);
    if (
      !field ||
      typeof field.path !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_.]{0,99}$/.test(field.path) ||
      /secret|token|cookie|authorization/i.test(field.path)
    )
      return [];
    // Keep field placement without allowing echoed input or authentication material into errors.
    return [{ path: field.path, message: "请检查该字段" }];
  });
}

export function readPortalError(
  value: unknown,
  status: number,
  headers: Headers,
  now: number,
): PortalApiError {
  const body = object(value);
  const symbol =
    typeof body?.error === "string" && isErrorSymbol(body.error)
      ? body.error
      : status === 401
        ? "AUTH_REQUIRED"
        : status === 429
          ? "RATE_LIMITED"
          : "HTTP_ERROR";
  const retry = headers.get("Retry-After");
  let retryAfter: number | null = null;
  if (retry !== null) {
    const seconds = /^\d+$/.test(retry)
      ? Number(retry)
      : Math.ceil((Date.parse(retry) - now) / 1000);
    if (Number.isSafeInteger(seconds) && seconds >= 0) retryAfter = seconds;
  }
  return new PortalApiError(
    symbol,
    status,
    safeRequestId(body?.requestId) ?? safeRequestId(headers.get("X-Request-Id")),
    safeDetails(body?.details),
    symbol === "VALIDATION_FAILED" ? safeFields(body?.fieldErrors) : [],
    retryAfter,
  );
}

export function safePortalError(error: unknown): PortalApiError {
  return error instanceof PortalApiError ? error : new PortalApiError("NETWORK_ERROR");
}
