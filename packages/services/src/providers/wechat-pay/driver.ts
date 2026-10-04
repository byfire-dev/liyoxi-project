// 微信支付的真实驱动：预下单、调起参数签名、回调验签与解密、查单、关单、退款、退款查询、账单下载
// （03 第 1.4 节；D2 第 10.2 节；ADR-016）。地址与字段照官方现行文档（pay.weixin.qq.com/doc/v3/merchant）：
//   下单 4012791897；查单 4012791900；关单 4012791901；退款 4012791903；查询退款 4012791904；
//   申请交易账单 4012791907；下载账单 4012791909。
// 本驱动还没有接进 providers/index.ts 的选择分支，也没有任何用例调用它：接入归 G4-A。
// 比 WechatPayProvider 多出来的方法（调起参数签名、退款查询、账单的申请与下载、带判别结果的回调入口）
// 先放在 WechatPayDriver 上，由用到的包按“只增”提进接口。
// 金额一律整数分。发请求的方法在入口调一次外呼前钩子（deps.beforeCall）；本地签名与验签不调。

import { createHash, timingSafeEqual } from "node:crypto";

import { failed, ok } from "../types.js";
import type {
  BeforeProviderCall,
  ProviderFailure,
  ProviderLogger,
  ProviderMethodName,
  ProviderResult,
  WechatPayProvider,
  WechatPayRefund,
  WechatPayTransaction,
} from "../types.js";
import { unconfiguredWechatPay } from "../unconfigured.js";
import { createClient, DEFAULT_BASE_URL, randomNonce } from "./client.js";
import type { HttpOutcome } from "./client.js";
import { resolveWechatPayConfig, WechatPayConfigError } from "./config.js";
import type { WechatPayConfig, WechatPaySettings } from "./config.js";
import { createApiV3Keyring, createVerifierTable } from "./keyring.js";
import type { ResourceCipher } from "./keyring.js";
import { mapRefund, mapTransaction, parseObject, text } from "./mapping.js";
import type { Json } from "./mapping.js";
import { verifyAndDecrypt } from "./notification.js";
import type { NotificationResult } from "./notification.js";
import { miniProgramPaySignMessage, rsaSign } from "./sign.js";

/** 生效状态里的驱动名 */
export const WECHAT_PAY_DRIVER = "wechatpay-v3";

/** 账单下载地址只认微信支付的主、备域名（以及配置的 baseUrl） */
const BILL_ORIGINS = [DEFAULT_BASE_URL, "https://api2.mch.weixin.qq.com"];

/** 没办成的结果，另带微信的错误码（如 ORDER_NOT_EXIST、NO_STATEMENT_EXIST），调用方可据此分支 */
export interface WechatPayFailure extends ProviderFailure {
  code?: string;
}

/** wx.requestPayment 的参数 */
export interface MiniProgramPayParams {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: "RSA";
  paySign: string;
}

export interface TradeBillTicket {
  /** 摘要算法，固定 SHA1 */
  hashType: string;
  hashValue: string;
  /** 5 分钟内有效 */
  downloadUrl: string;
}

export interface WechatPayDriver extends WechatPayProvider {
  /** 调起参数签名（本地） */
  signMiniProgramPay(input: { prepayId: string }): Promise<ProviderResult<MiniProgramPayParams>>;
  /** 退款查询 */
  queryRefund(input: { outRefundNo: string }): Promise<ProviderResult<WechatPayRefund>>;
  /** 申请交易账单（bill_type=ALL）。当日没有账单返回 null */
  applyTradeBill(input: { billDate: string }): Promise<ProviderResult<TradeBillTicket | null>>;
  /** 下载账单并校验摘要值；不符即拒收。hashType 给了就核对：只认 SHA1 */
  downloadBill(input: {
    downloadUrl: string;
    hashValue: string;
    hashType?: string;
  }): Promise<ProviderResult<{ text: string }>>;
  /** 回调入口：验签并解密，给出判别结果（实际所用的密钥版本、序列号、摘要） */
  verifyNotification(input: {
    headers: Record<string, string | undefined>;
    rawBody: Uint8Array | string;
  }): NotificationResult;
  /** 重处理：按收件行记下的密钥版本重新解密。解不开返回 null */
  reopenResource(resourceCipher: ResourceCipher, kid: string): Json | null;
}

export interface WechatPayDriverDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  nonce?: () => string;
  logger?: ProviderLogger;
  beforeCall?: BeforeProviderCall;
}

const toFailure = (outcome: Extract<HttpOutcome, { ok: false }>): WechatPayFailure => ({
  ...failed(outcome.reason, outcome.message),
  code: outcome.code,
});

/** 下载到的账单与申请时拿到的摘要值（SHA1，十六进制）是否一致 */
export function verifyBillDigest(bytes: Uint8Array, hashValue: string): boolean {
  const actual = createHash("sha1").update(bytes).digest();
  const expected = Buffer.from(hashValue.trim().toLowerCase(), "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

const positiveFen = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/** 时刻 → RFC 3339，写成北京时间 */
const rfc3339 = (at: Date): string =>
  `${new Date(at.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19)}+08:00`;

export function createWechatPayDriver(
  config: WechatPayConfig,
  deps: WechatPayDriverDeps = {},
): WechatPayDriver {
  const now = deps.now ?? (() => new Date());
  const nonce = deps.nonce ?? randomNonce;
  const verifiers = createVerifierTable(config.verifiers);
  const keyring = createApiV3Keyring(config.apiV3Keys.current, config.apiV3Keys.previous);
  const client = createClient(config, { ...deps, verifiers, now, nonce });
  const { mchid, appid } = config;
  type Method = ProviderMethodName<WechatPayDriver>;
  const hook = (method: Method) => deps.beforeCall?.({ provider: "wechatPay", method });

  async function query(outTradeNo: string): Promise<ProviderResult<WechatPayTransaction>> {
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}`;
    const out = await client.request({ method: "GET", path: `${path}?mchid=${mchid}` });
    if (!out.ok) return toFailure(out);
    const transaction = mapTransaction(out.json ?? {});
    return transaction ? ok(transaction) : failed("unavailable", "微信支付的查单应答不合规");
  }

  function refundOf(out: HttpOutcome): ProviderResult<WechatPayRefund> {
    if (!out.ok) return toFailure(out);
    const refund = mapRefund(out.json ?? {});
    return refund ? ok(refund) : failed("unavailable", "微信支付的退款应答不合规");
  }

  async function applyTradeBill(billDate: string): Promise<ProviderResult<TradeBillTicket | null>> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate)) return failed("rejected", "账单日要写 YYYY-MM-DD");
    const path = `/v3/bill/tradebill?bill_date=${billDate}&bill_type=ALL`;
    const out = await client.request({ method: "GET", path });
    if (!out.ok) {
      if (out.code === "NO_STATEMENT_EXIST") return ok(null);
      // 账单生成中：稍后重试
      const failure = toFailure(out);
      return out.code === "STATEMENT_CREATING" ? { ...failure, reason: "unavailable" } : failure;
    }
    const [hashType, hashValue, downloadUrl] = [
      out.json?.hash_type,
      out.json?.hash_value,
      out.json?.download_url,
    ].map(text);
    if (!hashType || !hashValue || !downloadUrl) {
      return failed("unavailable", "微信支付的账单申请应答不合规");
    }
    return ok({ hashType, hashValue, downloadUrl });
  }

  async function downloadBill(input: {
    downloadUrl: string;
    hashValue: string;
    hashType?: string;
  }): Promise<ProviderResult<{ text: string }>> {
    if (input.hashType !== undefined && input.hashType.toUpperCase() !== "SHA1") {
      return failed("rejected", "账单的摘要算法不是 SHA1，校验不了");
    }
    const url = URL.canParse(input.downloadUrl) ? new URL(input.downloadUrl) : null;
    if (!url || ![client.baseUrl, ...BILL_ORIGINS].includes(url.origin)) {
      return failed("rejected", "账单下载地址不在微信支付的域名下");
    }
    const path = `${url.pathname}${url.search}`;
    const out = await client.request({ method: "GET", origin: url.origin, path, unsigned: true });
    if (!out.ok) return toFailure(out);
    if (!verifyBillDigest(out.bytes, input.hashValue)) {
      return failed("unavailable", "账单的摘要值与申请时拿到的不一致，已拒收");
    }
    return ok({ text: out.bytes.toString("utf8") });
  }

  const verifyNotification: WechatPayDriver["verifyNotification"] = (input) =>
    verifyAndDecrypt({ verifiers, keyring, now }, input);

  return {
    status: WECHAT_PAY_DRIVER,
    configured: true,

    async createJsapiOrder(input) {
      hook("createJsapiOrder");
      if (!positiveFen(input.amountFen)) return failed("rejected", "金额要是正的整数分");
      const body: Json = {
        appid,
        mchid,
        description: input.description,
        out_trade_no: input.outTradeNo,
        notify_url: config.notifyUrl,
        amount: { total: input.amountFen, currency: "CNY" },
        payer: { openid: input.payerOpenid },
      };
      if (input.expireAt) body.time_expire = rfc3339(input.expireAt);
      if (input.attach !== undefined) body.attach = input.attach;
      const out = await client.request({
        method: "POST",
        path: "/v3/pay/transactions/jsapi",
        body,
      });
      if (!out.ok) return toFailure(out);
      const prepayId = text(out.json?.prepay_id);
      return prepayId
        ? ok({ prepayId })
        : failed("unavailable", "微信支付的下单应答里没有 prepay_id");
    },

    async signMiniProgramPay({ prepayId }) {
      const timeStamp = String(Math.floor(now().getTime() / 1000));
      const nonceStr = nonce();
      const message = miniProgramPaySignMessage({ appId: appid, timeStamp, nonceStr, prepayId });
      return ok({
        appId: appid,
        timeStamp,
        nonceStr,
        package: `prepay_id=${prepayId}`,
        signType: "RSA",
        paySign: rsaSign(message, config.merchantPrivateKey),
      });
    },

    async verifyAndDecryptNotification(input) {
      const result = verifyNotification(input);
      if (!result.ok) return failed("rejected", `回调没有通过（${result.kind}）：${result.detail}`);
      if (!result.notification) return failed("rejected", "不在登记清单内的通知类型");
      return ok(result.notification);
    },
    verifyNotification,
    reopenResource: (resourceCipher, kid) =>
      parseObject(keyring.decrypt(resourceCipher, kid)?.plaintext ?? ""),

    async queryByOutTradeNo({ outTradeNo }) {
      hook("queryByOutTradeNo");
      return query(outTradeNo);
    },

    // 关单的三态：已关、已支付、可重试（ADR-018：以关单结果为准）。
    // 204 是已关。连不上、超时、5xx 是可重试。其余 4xx：现行文档没有给“订单已支付”的专用错误码，
    // 回查一次订单，以订单的实际状态为准；回查也定不了的，按关单接口的拒绝原样返回。
    async closeOrder({ outTradeNo }) {
      hook("closeOrder");
      const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;
      const out = await client.request({ method: "POST", path, body: { mchid } });
      if (out.ok) return ok({ outcome: "closed" });
      if (out.reason === "unavailable") return toFailure(out);
      const current = await query(outTradeNo);
      if (!current.ok) return current.reason === "unavailable" ? current : toFailure(out);
      const { tradeState } = current.value;
      if (tradeState === "SUCCESS" || tradeState === "REFUND") return ok({ outcome: "paid" });
      return tradeState === "CLOSED" ? ok({ outcome: "closed" }) : toFailure(out);
    },

    async createRefund(input) {
      hook("createRefund");
      if (!positiveFen(input.refundFen) || !positiveFen(input.totalFen)) {
        return failed("rejected", "退款金额与订单金额要是正的整数分");
      }
      if (input.refundFen > input.totalFen) return failed("rejected", "退款金额不能超过订单金额");
      const body: Json = {
        out_trade_no: input.outTradeNo,
        out_refund_no: input.outRefundNo,
        amount: { refund: input.refundFen, total: input.totalFen, currency: "CNY" },
      };
      if (input.reason !== undefined) body.reason = input.reason;
      if (config.refundNotifyUrl) body.notify_url = config.refundNotifyUrl;
      const path = "/v3/refund/domestic/refunds";
      return refundOf(await client.request({ method: "POST", path, body }));
    },

    async queryRefund({ outRefundNo }) {
      hook("queryRefund");
      const path = `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`;
      return refundOf(await client.request({ method: "GET", path }));
    },

    async applyTradeBill({ billDate }) {
      hook("applyTradeBill");
      return applyTradeBill(billDate);
    },

    async downloadBill(input) {
      hook("downloadBill");
      return downloadBill(input);
    },

    // 申请加下载。当日没有账单时 text 是空串（真实的账单至少有表头），由调用方按“账单不存在”处理
    async fetchTradeBill({ billDate }) {
      hook("fetchTradeBill");
      const ticket = await applyTradeBill(billDate);
      if (!ticket.ok) return ticket;
      if (ticket.value === null) return ok({ billDate, text: "" });
      const bill = await downloadBill(ticket.value);
      return bill.ok ? ok({ billDate, text: bill.value.text }) : bill;
    },
  };
}

/**
 * 按设置给出微信支付的实现：五项全缺用 W0-19 的未配置实现（configured 为 false，调用即“未配置”）；
 * 半配或写错抛 WechatPayConfigError；齐全给真实驱动。
 */
export function createWechatPay(
  settings: WechatPaySettings,
  deps: WechatPayDriverDeps = {},
): WechatPayProvider {
  const resolved = resolveWechatPayConfig(settings);
  if (resolved.state === "unconfigured") return unconfiguredWechatPay;
  if (resolved.state === "invalid") {
    throw new WechatPayConfigError(resolved.missing, resolved.problems);
  }
  return createWechatPayDriver(resolved.config, deps);
}
