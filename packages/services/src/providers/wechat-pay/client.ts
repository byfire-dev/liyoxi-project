// 请求客户端：统一做签名、发送、应答验签、超时与错误归一（03 第 1.4 节；D2 第 10.2 节）。
// 骨架借自参考工程的微信 Provider：可注入 fetchImpl、默认超时常量、外部失败一律归一成结果，不往外抛。
//
// 归一的口径：
//   连不上、超时、5xx、429                      → unavailable（可以重试）
//   其余 4xx                                    → rejected（带微信的错误码，如 ORDER_NOT_EXIST）
//   2xx 而应答验签不过（含时间戳超 5 分钟）     → unavailable：应答丢弃，由调用方重试（官方文档 4013053249 第 5 节）
// 非 2xx 的应答不验签，只读错误码（官方 Go SDK 同此；D2 第 10.2 节写“所有应答也要验签”，出入记在状态文件偏差里）。
// 所以错误码是没验过签的：调用方拿它分支时要知道这一点（如 NO_STATEMENT_EXIST 不足以单独认定当日没有交易）。
// 账单下载的应答不带签名，靠摘要值校验（unsigned）。
// 错误信息只带状态码、错误码与微信的 Request-ID；请求体、Authorization 头、地址里的查询串都不进信息与日志。
// 时钟必须注入（deps.now）：请求时间戳与应答时间戳的 5 分钟判定都用它，不取系统时间。

import { randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";

import type { ProviderLogger } from "../types.js";
import type { VerifierTable } from "./keyring.js";
import { parseObject, text } from "./mapping.js";
import type { Json } from "./mapping.js";
import {
  authorizationHeader,
  requestSignMessage,
  responseSignMessage,
  rsaSign,
  rsaVerify,
  withinSkew,
} from "./sign.js";

export const DEFAULT_BASE_URL = "https://api.mch.weixin.qq.com";
/** 默认超时 8 秒（D2 第 4.3 节：预下单超时 8 秒） */
export const DEFAULT_TIMEOUT_MS = 8000;

export interface ClientConfig {
  mchid: string;
  /** 商户 API 证书序列号 */
  merchantSerialNo: string;
  /** 商户 API 私钥 */
  merchantPrivateKey: KeyObject;
  /** 微信支付公钥 ID：放进请求头 Wechatpay-Serial，微信据此用公钥对应的私钥签应答 */
  publicKeyId: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface ClientDeps {
  verifiers: VerifierTable;
  fetchImpl?: typeof fetch;
  now: () => Date;
  /** 请求随机串；缺省 32 位大写十六进制 */
  nonce?: () => string;
  logger?: ProviderLogger;
}

export interface RequestSpec {
  method: "GET" | "POST";
  /** 去掉域名的地址，带查询串 */
  path: string;
  /** 不给用 baseUrl。账单下载地址是微信给的完整地址，域名可能与 baseUrl 不同 */
  origin?: string;
  body?: Json;
  /** 应答不带签名（账单下载）：跳过验签 */
  unsigned?: boolean;
  /** 退款查询/可信账单：不存在证明也必须验签；其他旧调用的错误归一保持原样。 */
  verifyError?: boolean;
}

export type HttpOutcome =
  | { ok: true; status: number; bytes: Buffer; json: Json | null }
  | {
      ok: false;
      reason: "unavailable" | "rejected";
      status?: number;
      /** 微信的错误码 */
      code?: string;
      message: string;
      verifiedError?: true;
    };

export interface WechatPayClient {
  readonly baseUrl: string;
  request(spec: RequestSpec): Promise<HttpOutcome>;
}

export const randomNonce = (): string => randomBytes(16).toString("hex").toUpperCase();

// 错误码与 Request-ID 取自没验签的应答：只放行各自的写法（如 ORDER_NOT_EXIST），别的不进结果、信息与日志
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const REQUEST_ID = /^[\w-]{1,64}$/;

export function createClient(config: ClientConfig, deps: ClientDeps): WechatPayClient {
  const doFetch = deps.fetchImpl ?? fetch;
  const { now } = deps;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  async function request(spec: RequestSpec): Promise<HttpOutcome> {
    const body = spec.body === undefined ? "" : JSON.stringify(spec.body);
    const timestamp = String(Math.floor(now().getTime() / 1000));
    const nonce = (deps.nonce ?? randomNonce)();
    const message = requestSignMessage({
      method: spec.method,
      pathWithQuery: spec.path,
      timestamp,
      nonce,
      body,
    });
    const headers: Record<string, string> = {
      Authorization: authorizationHeader({
        mchid: config.mchid,
        serialNo: config.merchantSerialNo,
        nonce,
        timestamp,
        signature: rsaSign(message, config.merchantPrivateKey),
      }),
      Accept: "application/json",
      "User-Agent": "liyoxi-wechatpay/1",
      "Wechatpay-Serial": config.publicKeyId,
    };
    if (body !== "") headers["Content-Type"] = "application/json";

    const failure = (
      reason: "unavailable" | "rejected",
      what: string,
      status?: number,
      code?: string,
      requestId?: string | null,
    ): HttpOutcome => {
      const detail = [status && `HTTP ${status}`, code, requestId && `Request-ID ${requestId}`];
      const message = `微信支付${what}（${detail.filter(Boolean).join("，") || "没有应答"}）`;
      const fields = { provider: "wechatPay", path: spec.path.split("?")[0], status, code };
      deps.logger?.warn({ ...fields, requestId }, message);
      return { ok: false, reason, status, code, message };
    };

    let response: Response;
    let bytes: Buffer;
    try {
      response = await doFetch(`${spec.origin ?? baseUrl}${spec.path}`, {
        method: spec.method,
        headers,
        body: body === "" ? undefined : body,
        // 微信支付的接口不重定向：遇到 3xx 不跟随（带着签名头去别的地址不合适），按被拒绝归一
        redirect: "manual",
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      return failure("unavailable", "连不上或超时");
    }
    const { status } = response;
    const requestId = REQUEST_ID.exec(response.headers.get("Request-ID") ?? "")?.[0];
    if (spec.verifyError && (status < 200 || status >= 300)) {
      const stamp = response.headers.get("Wechatpay-Timestamp") ?? "";
      const identity = deps.verifiers.lookup(response.headers.get("Wechatpay-Serial") ?? "");
      const signed = responseSignMessage(
        stamp,
        response.headers.get("Wechatpay-Nonce") ?? "",
        bytes,
      );
      if (
        !identity ||
        !rsaVerify(signed, response.headers.get("Wechatpay-Signature") ?? "", identity.publicKey) ||
        !withinSkew(stamp, now())
      )
        return failure("unavailable", "的应答验签失败，应答已丢弃", status, undefined, requestId);
    }
    if (status < 200 || status >= 300) {
      const raw = text(parseObject(bytes.toString("utf8"))?.code) ?? "";
      const code = ERROR_CODE.test(raw) ? raw : undefined;
      const retryable = status >= 500 || status === 429;
      const result = retryable
        ? failure("unavailable", "暂时不可用", status, code, requestId)
        : failure("rejected", "拒绝了请求", status, code, requestId);
      return { ...result, ...(spec.verifyError ? { verifiedError: true as const } : {}) };
    }
    if (!spec.unsigned) {
      const stamp = response.headers.get("Wechatpay-Timestamp") ?? "";
      const signed = responseSignMessage(
        stamp,
        response.headers.get("Wechatpay-Nonce") ?? "",
        bytes,
      );
      const identity = deps.verifiers.lookup(response.headers.get("Wechatpay-Serial") ?? "");
      const signature = response.headers.get("Wechatpay-Signature") ?? "";
      const verified = identity !== undefined && rsaVerify(signed, signature, identity.publicKey);
      if (!verified || !withinSkew(stamp, now())) {
        return failure("unavailable", "的应答验签失败，应答已丢弃", status, undefined, requestId);
      }
    }
    if (spec.unsigned || bytes.length === 0) return { ok: true, status, bytes, json: null };
    const json = parseObject(bytes.toString("utf8"));
    if (!json) return failure("unavailable", "的应答不是 JSON 对象", status, undefined, requestId);
    return { ok: true, status, bytes, json };
  }

  return { baseUrl, request };
}
