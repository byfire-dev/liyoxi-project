// 六个微信端点的有限投影；不读取或输出上游 errmsg/detail/session_key。
import { failed, ok } from "../types.js";
import type {
  ContentCheckOutcome,
  ProviderFailure,
  ProviderResult,
  WechatProvider,
  WechatSession,
} from "../types.js";
import type { WechatHttpFailure } from "./client.js";

export type WechatMethod = Exclude<keyof WechatProvider, "status" | "configured">;
const REJECTIONS: Record<WechatMethod, readonly number[]> = {
  code2Session: [40029, 40226],
  getPhoneNumber: [40013, 40029],
  sendSubscribeMessage: [40003, 40037, 43101, 43107, 45168, 47003],
  createMiniProgramCode: [40097, 40129, 40169, 41030, 85096],
  checkText: [40003, 40129, 43002, 43104, 44002, 47001, 61010],
  checkImage: [40003, 40004, 43104, 61010, 87020],
};
export const tokenInvalid = (code: number | undefined): boolean =>
  code !== undefined && [40001, 40014, 42001].includes(code);
export const unavailable = (): ProviderFailure => failed("unavailable", "微信服务暂不可用");
export function mapWechatFailure(
  method: WechatMethod,
  failure: WechatHttpFailure,
): ProviderFailure {
  const { code, status } = failure;
  const rejected =
    status !== undefined &&
    status >= 200 &&
    status < 500 &&
    status !== 429 &&
    !(status >= 300 && status < 400) &&
    code !== undefined &&
    REJECTIONS[method].includes(code);
  return rejected ? failed("rejected", "微信服务明确拒绝本次请求") : unavailable();
}
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const successful = (value: unknown): value is Record<string, unknown> =>
  object(value) && value["errcode"] === 0;

export function sessionResult(value: unknown): ProviderResult<WechatSession> {
  if (
    !object(value) ||
    (value["errcode"] !== undefined && value["errcode"] !== 0) ||
    !nonempty(value["openid"]) ||
    (value["unionid"] !== undefined && !nonempty(value["unionid"]))
  )
    return unavailable();
  return ok({
    openid: value["openid"],
    ...(typeof value["unionid"] === "string" ? { unionid: value["unionid"] } : {}),
  });
}
export function phoneResult(
  value: unknown,
  appid: string,
): ProviderResult<{
  phone: string;
  countryCode: string;
  purePhoneNumber: string;
}> {
  const phone = successful(value) ? value["phone_info"] : undefined;
  if (!object(phone)) return unavailable();
  const country = phone["countryCode"],
    pure = phone["purePhoneNumber"];
  const raw = phone["phoneNumber"],
    watermark = phone["watermark"];
  if (
    !nonempty(country) ||
    !/^[1-9]\d{0,2}$/.test(country) ||
    !nonempty(pure) ||
    !/^\d+$/.test(pure) ||
    !nonempty(raw) ||
    !object(watermark) ||
    watermark["appid"] !== appid ||
    typeof watermark["timestamp"] !== "number" ||
    !Number.isSafeInteger(watermark["timestamp"]) ||
    watermark["timestamp"] < 0
  )
    return unavailable();
  const international = `${country}${pure}`;
  if (raw !== international && raw !== `+${international}` && !(country === "86" && raw === pure))
    return unavailable();
  return ok({
    phone: country === "86" ? pure : `+${international}`,
    countryCode: country,
    purePhoneNumber: pure,
  });
}
export function textResult(value: unknown): ProviderResult<ContentCheckOutcome> {
  if (!successful(value)) return unavailable();
  const result = value["result"];
  if (!object(result)) return unavailable();
  const suggest = result["suggest"];
  if (suggest !== "pass" && suggest !== "review" && suggest !== "risky") return unavailable();
  const trace = value["trace_id"];
  if (trace !== undefined && !nonempty(trace)) return unavailable();
  return ok({
    verdict: suggest === "risky" ? "block" : suggest,
    ...(typeof trace === "string" ? { traceId: trace } : {}),
  });
}
export function imageResult(value: unknown): ProviderResult<ContentCheckOutcome> {
  if (!successful(value) || !nonempty(value["trace_id"])) return unavailable();
  return ok({ verdict: "pending", traceId: value["trace_id"] });
}
export function subscribeResult(value: unknown): ProviderResult<void> {
  return successful(value) ? ok(undefined) : unavailable();
}
