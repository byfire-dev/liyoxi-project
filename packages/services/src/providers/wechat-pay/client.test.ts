import { createHash, createPublicKey } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestSetup } from "./__fixtures__/test-setup.js";
import type { TestSetup } from "./__fixtures__/test-setup.js";
import {
  generateCertificateIdentity,
  generateIdentity,
  notificationBody,
  refundResource,
  signedHeaders,
  transactionResource,
} from "./__fixtures__/wechatpay-server.js";
import { DEFAULT_TIMEOUT_MS } from "./client.js";
import type { WechatPayConfig } from "./config.js";
import { createWechatPayDriver } from "./driver.js";
import type { WechatPayDriver, WechatPayDriverDeps, WechatPayFailure } from "./driver.js";
import type { ResourceCipher } from "./keyring.js";
import { miniProgramPaySignMessage, requestSignMessage, rsaVerify } from "./sign.js";

// 八个方法的请求与应答（X-04 任务书 第 7 节第 4 条）。用注入的 fetchImpl 扮演微信支付：
// 每个请求都照微信一侧的做法验一遍签名（用商户公钥验 Authorization），应答由测试用的“微信支付私钥”签名。
// 写法借自参考工程的 providers/wechat/wechat.test.ts（用假 fetch 测驱动）。

const NOW = new Date("2026-10-04T02:00:00.000Z");
const NONCE = "593BEC0C930BF1AFEB40B4A08C8FB242";
const NO = "FK20261004000001a1b2";

interface Sent {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Reply = (sent: Sent) => Response | Promise<Response>;

let setup: TestSetup;
let sent: Sent[];
let replies: Reply[];
let hooked: string[];

beforeAll(() => {
  setup = createTestSetup();
});

beforeEach(() => {
  sent = [];
  replies = [];
  hooked = [];
});

function driver(
  config: Partial<WechatPayConfig> = {},
  deps: Partial<WechatPayDriverDeps> = {},
): WechatPayDriver {
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const record: Sent = {
      url,
      path: url.replace(/^https:\/\/[^/]+/, ""),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? init.body : "",
    };
    sent.push(record);
    const reply = replies.shift();
    if (!reply) throw new Error("用例没有给这次请求预置应答");
    return reply(record);
  };
  return createWechatPayDriver(
    { ...setup.config, ...config },
    {
      fetchImpl: fetchImpl as typeof fetch,
      now: () => NOW,
      nonce: () => NONCE,
      beforeCall: (call) => void hooked.push(call.method),
      ...deps,
    },
  );
}

/** 微信支付的一次应答：带签名的四个头与 Request-ID。204 没有包体 */
function signed(status: number, body: unknown = null, at: Date = NOW): Reply {
  return () => {
    const text = body === null ? "" : typeof body === "string" ? body : JSON.stringify(body);
    const headers = { ...signedHeaders(setup.platform, text, at), "Request-ID": "REQ-0001" };
    return new Response(status === 204 ? null : text, { status, headers });
  };
}

/** 微信支付的错误应答（非 2xx 不验签） */
const refused = (status: number, code: string): Reply =>
  signed(status, { code, message: `微信的说明里可能带着入参 ${NO}` });

/** 照微信一侧的做法验请求：Authorization 的五个字段，与对这次请求算出的签名 */
function expectSignedRequest(request: Sent): void {
  const authorization = request.headers.Authorization ?? "";
  expect(authorization.startsWith("WECHATPAY2-SHA256-RSA2048 ")).toBe(true);
  const fields = Object.fromEntries(
    [...authorization.matchAll(/([a-z_]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
  expect(Object.keys(fields).sort()).toEqual(
    ["mchid", "nonce_str", "serial_no", "signature", "timestamp"].sort(),
  );
  expect(fields).toMatchObject({
    mchid: setup.config.mchid,
    serial_no: setup.merchant.serial,
    nonce_str: NONCE,
    timestamp: String(NOW.getTime() / 1000),
  });
  const message = requestSignMessage({
    method: request.method,
    pathWithQuery: request.path,
    timestamp: fields.timestamp ?? "",
    nonce: fields.nonce_str ?? "",
    body: request.body,
  });
  const merchantKey = createPublicKey(setup.merchant.publicKeyPem);
  expect(rsaVerify(message, fields.signature ?? "", merchantKey)).toBe(true);
  expect(request.headers["Wechatpay-Serial"]).toBe(setup.platform.serial);
  expect(request.headers.Accept).toBe("application/json");
  expect(request.headers["Content-Type"]).toBe(
    request.body === "" ? undefined : "application/json",
  );
  expect(request.url.startsWith("https://api.mch.weixin.qq.com/v3/")).toBe(true);
}

const last = (): Sent => {
  const request = sent.at(-1);
  if (!request) throw new Error("没有发出请求");
  return request;
};

describe("预下单 createJsapiOrder", () => {
  const input = {
    outTradeNo: NO,
    description: "狸有戏·标准版套餐",
    amountFen: 19900,
    payerOpenid: "o-test-openid-0001",
    attach: "v1.e.o.N.r.12",
    expireAt: new Date("2026-10-04T02:30:00.000Z"),
  };

  it("POST /v3/pay/transactions/jsapi：请求头与请求体符合官方文档，返回 prepay_id", async () => {
    replies.push(signed(200, { prepay_id: "wx201410272009395522657a690389285100" }));
    const result = await driver().createJsapiOrder(input);
    expect(result).toEqual({
      ok: true,
      value: { prepayId: "wx201410272009395522657a690389285100" },
    });
    expect(sent).toHaveLength(1);
    expect(last()).toMatchObject({ method: "POST", path: "/v3/pay/transactions/jsapi" });
    expectSignedRequest(last());
    expect(JSON.parse(last().body)).toEqual({
      appid: "wx0000000000000000",
      mchid: "1900000109",
      description: "狸有戏·标准版套餐",
      out_trade_no: NO,
      notify_url: "https://api.example.invalid/api/v1/hooks/wechatpay/transactions",
      amount: { total: 19900, currency: "CNY" },
      payer: { openid: "o-test-openid-0001" },
      time_expire: "2026-10-04T10:30:00+08:00",
      attach: "v1.e.o.N.r.12",
    });
    expect(hooked).toEqual(["createJsapiOrder"]);
  });

  it("不带回传数据与过期时间：请求体里没有这两个键", async () => {
    replies.push(signed(200, { prepay_id: "wx1" }));
    await driver().createJsapiOrder({ ...input, attach: undefined, expireAt: undefined });
    expect(Object.keys(JSON.parse(last().body) as object).sort()).toEqual(
      ["amount", "appid", "description", "mchid", "notify_url", "out_trade_no", "payer"].sort(),
    );
  });

  it("金额不是正的整数分：不发请求，直接拒绝", async () => {
    for (const amountFen of [0, -1, 199.5, Number.NaN, 2 ** 60]) {
      expect(await driver().createJsapiOrder({ ...input, amountFen })).toMatchObject({
        ok: false,
        reason: "rejected",
      });
    }
    expect(sent).toHaveLength(0);
  });

  it("应答里没有 prepay_id：不可用", async () => {
    replies.push(signed(200, { something: "else" }));
    expect(await driver().createJsapiOrder(input)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("默认超时是 8 秒", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(8000);
  });
});

describe("调起参数签名 signMiniProgramPay", () => {
  it("本地签名：给出 wx.requestPayment 的参数，签名能用商户公钥验过；不发请求、不调外呼前钩子", async () => {
    const result = await driver().signMiniProgramPay({ prepayId: "wx2014" });
    if (!result.ok) throw new Error(result.message);
    expect(result.value).toMatchObject({
      appId: "wx0000000000000000",
      timeStamp: String(NOW.getTime() / 1000),
      nonceStr: NONCE,
      package: "prepay_id=wx2014",
      signType: "RSA",
    });
    const message = miniProgramPaySignMessage({ ...result.value, prepayId: "wx2014" });
    const merchantKey = createPublicKey(setup.merchant.publicKeyPem);
    expect(rsaVerify(message, result.value.paySign, merchantKey)).toBe(true);
    expect(sent).toHaveLength(0);
    expect(hooked).toEqual([]);
  });
});

describe("查单 queryByOutTradeNo", () => {
  it("GET /v3/pay/transactions/out-trade-no/{no}?mchid=…：返回状态、回传数据、付款人、金额", async () => {
    replies.push(signed(200, transactionResource()));
    const result = await driver().queryByOutTradeNo({ outTradeNo: NO });
    expect(result).toEqual({
      ok: true,
      value: {
        appid: "wx0000000000000000",
        mchid: "1900000109",
        outTradeNo: NO,
        tradeState: "SUCCESS",
        transactionId: "4200000000202610040000000001",
        amountFen: 19900,
        payerOpenid: "o-test-openid-0001",
        attach: "v1.e.o.N.r.12",
        bankType: "OTHERS",
        successAt: new Date("2026-10-04T02:00:00.000Z"),
      },
    });
    expect(last()).toMatchObject({
      method: "GET",
      path: `/v3/pay/transactions/out-trade-no/${NO}?mchid=1900000109`,
      body: "",
    });
    expectSignedRequest(last());
    expect(hooked).toEqual(["queryByOutTradeNo"]);
  });

  it.each(["NOTPAY", "CLOSED", "REFUND", "USERPAYING", "PAYERROR", "REVOKED"] as const)(
    "各状态 %s：未支付的没有金额、付款人与成功时间",
    async (tradeState) => {
      replies.push(
        signed(200, {
          appid: "wx0000000000000000",
          mchid: "1900000109",
          out_trade_no: NO,
          trade_state: tradeState,
          trade_state_desc: "…",
        }),
      );
      expect(await driver().queryByOutTradeNo({ outTradeNo: NO })).toEqual({
        ok: true,
        value: {
          appid: "wx0000000000000000",
          mchid: "1900000109",
          outTradeNo: NO,
          tradeState,
          transactionId: undefined,
          amountFen: undefined,
          payerOpenid: undefined,
          attach: undefined,
          successAt: undefined,
        },
      });
    },
  );

  it("单号里的特殊字符按地址编码，签名用的与发出去的是同一个地址", async () => {
    replies.push(signed(200, { out_trade_no: "FK|1*2", trade_state: "NOTPAY" }));
    await driver().queryByOutTradeNo({ outTradeNo: "FK|1*2" });
    expect(last().path).toBe("/v3/pay/transactions/out-trade-no/FK%7C1*2?mchid=1900000109");
    expectSignedRequest(last());
  });

  it("订单不存在（404 ORDER_NOT_EXIST）：拒绝，带微信的错误码", async () => {
    replies.push(refused(404, "ORDER_NOT_EXIST"));
    const result = (await driver().queryByOutTradeNo({ outTradeNo: NO })) as WechatPayFailure;
    expect(result).toMatchObject({ ok: false, reason: "rejected", code: "ORDER_NOT_EXIST" });
  });

  it.each([
    ["AppID不是本小程序", { appid: "wx0000000000000001" }],
    ["商户号不是本商户", { mchid: "1900000110" }],
    ["币种不是人民币", { amount: { total: 19900, currency: "USD" } }],
    ["金额是小数", { amount: { total: 199.5 } }],
    ["金额是字符串", { amount: { total: "19900" } }],
    ["金额是负数", { amount: { total: -1 } }],
    ["状态不认识", { trade_state: "DONE" }],
    ["缺商户单号", { out_trade_no: undefined }],
    ["成功时间写错", { success_time: "昨天" }],
  ])("应答不合规 · %s：不可用，不把坏数据交给调用方", async (_name, overrides) => {
    replies.push(signed(200, transactionResource(overrides)));
    expect(await driver().queryByOutTradeNo({ outTradeNo: NO })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("应答里的单号要与请求的是同一个（复审补的）", () => {
  it("查单：应答验签通过但写的是别的商户单号，丢弃应答，不可用", async () => {
    replies.push(signed(200, transactionResource({ out_trade_no: "FK20261004000002c3d4" })));
    const result = await driver().queryByOutTradeNo({ outTradeNo: NO });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(result)).toContain("不是同一个");
    expect(JSON.stringify(result)).not.toContain("FK20261004000002c3d4");
  });

  it("关单被拒后的回查：回查到的是别的单的“已支付”，不当作本单已支付", async () => {
    replies.push(
      refused(400, "INVALID_REQUEST"),
      signed(200, transactionResource({ out_trade_no: "FK20261004000002c3d4" })),
    );
    expect(await driver().closeOrder({ outTradeNo: NO })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("退款：应答里的退款单号或商户单号不是请求的，丢弃应答；退款查询只核对退款单号", async () => {
    const accepted = {
      refund_id: "50000000002026100400000000001",
      out_refund_no: "TK20261004000001",
      out_trade_no: NO,
      status: "PROCESSING",
      amount: { total: 19900, refund: 19900 },
    };
    const input = {
      outTradeNo: NO,
      outRefundNo: "TK20261004000001",
      refundFen: 19900,
      totalFen: 19900,
    };
    replies.push(
      signed(200, { ...accepted, out_refund_no: "TK20261004000002" }),
      signed(200, { ...accepted, out_trade_no: "FK20261004000002c3d4" }),
      signed(200, { ...accepted, out_refund_no: "TK20261004000002" }),
      signed(200, { ...accepted, out_trade_no: "FK20261004000002c3d4" }),
    );
    for (const call of [
      () => driver().createRefund(input),
      () => driver().createRefund(input),
      () => driver().queryRefund({ outRefundNo: "TK20261004000001" }),
    ]) {
      const result = await call();
      expect(result).toMatchObject({ ok: false, reason: "unavailable" });
      expect(JSON.stringify(result)).toContain("不是同一个");
    }
    // 退款查询的入参只有退款单号：商户单号不同照常返回，由调用方与退款交易所指的收款核对
    expect(await driver().queryRefund({ outRefundNo: "TK20261004000001" })).toMatchObject({
      ok: true,
      value: { outRefundNo: "TK20261004000001", outTradeNo: "FK20261004000002c3d4" },
    });
  });
});

describe("关单 closeOrder：已关、已支付、可重试三态", () => {
  const close = () => driver().closeOrder({ outTradeNo: NO });

  it("204：已关。POST …/close，请求体只有商户号", async () => {
    replies.push(signed(204));
    expect(await close()).toEqual({ ok: true, value: { outcome: "closed" } });
    expect(last()).toMatchObject({
      method: "POST",
      path: `/v3/pay/transactions/out-trade-no/${NO}/close`,
      body: '{"mchid":"1900000109"}',
    });
    expectSignedRequest(last());
    expect(hooked).toEqual(["closeOrder"]);
  });

  it("5xx、429、连不上：可重试，不回查", async () => {
    replies.push(refused(500, "SYSTEM_ERROR"), refused(429, "FREQUENCY_LIMITED"), () => {
      throw new TypeError("fetch failed");
    });
    for (let round = 0; round < 3; round += 1) {
      expect(await close()).toMatchObject({ ok: false, reason: "unavailable" });
    }
    expect(sent).toHaveLength(3);
  });

  it("关单被拒、回查是已支付：已支付", async () => {
    replies.push(refused(400, "ORDERPAID"), signed(200, transactionResource()));
    expect(await close()).toEqual({ ok: true, value: { outcome: "paid" } });
    expect(sent.map((request) => request.method)).toEqual(["POST", "GET"]);
    expectSignedRequest(last());
    // 回查是关单这一次调用的一部分，外呼前钩子只调一次
    expect(hooked).toEqual(["closeOrder"]);
  });

  it("关单被拒、回查是转入退款：已支付", async () => {
    replies.push(
      refused(400, "INVALID_REQUEST"),
      signed(200, transactionResource({ trade_state: "REFUND" })),
    );
    expect(await close()).toEqual({ ok: true, value: { outcome: "paid" } });
  });

  it("关单被拒、回查是已关闭：已关", async () => {
    replies.push(
      refused(400, "ORDER_CLOSED"),
      signed(200, {
        appid: "wx0000000000000000",
        mchid: "1900000109",
        out_trade_no: NO,
        trade_state: "CLOSED",
      }),
    );
    expect(await close()).toEqual({ ok: true, value: { outcome: "closed" } });
  });

  it("关单被拒、回查仍未支付：照关单接口的拒绝返回", async () => {
    replies.push(
      refused(400, "PARAM_ERROR"),
      signed(200, {
        appid: "wx0000000000000000",
        mchid: "1900000109",
        out_trade_no: NO,
        trade_state: "NOTPAY",
      }),
    );
    expect(await close()).toMatchObject({ ok: false, reason: "rejected", code: "PARAM_ERROR" });
  });

  it("关单被拒、回查不可用：可重试", async () => {
    replies.push(refused(400, "INVALID_REQUEST"), refused(503, "SYSTEM_ERROR"));
    expect(await close()).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("订单不存在：拒绝", async () => {
    replies.push(refused(404, "ORDER_NOT_EXIST"), refused(404, "ORDER_NOT_EXIST"));
    expect(await close()).toMatchObject({ ok: false, reason: "rejected", code: "ORDER_NOT_EXIST" });
  });
});

describe("退款 createRefund 与退款查询 queryRefund", () => {
  const input = {
    outTradeNo: NO,
    outRefundNo: "TK20261004000001",
    refundFen: 19900,
    totalFen: 19900,
  };
  const accepted = {
    refund_id: "50000000002026100400000000001",
    out_refund_no: "TK20261004000001",
    transaction_id: "4200000000202610040000000001",
    out_trade_no: NO,
    channel: "ORIGINAL",
    user_received_account: "支付用户零钱",
    create_time: "2026-10-04T10:05:00+08:00",
    status: "PROCESSING",
    amount: {
      total: 19900,
      refund: 19900,
      payer_total: 19900,
      payer_refund: 19900,
      currency: "CNY",
    },
  };

  it("POST /v3/refund/domestic/refunds：请求体符合官方文档，返回处理中", async () => {
    replies.push(signed(200, accepted));
    const result = await driver().createRefund({ ...input, reason: "开通 7 天内全额退款" });
    expect(result).toEqual({
      ok: true,
      value: {
        outRefundNo: "TK20261004000001",
        outTradeNo: NO,
        refundId: "50000000002026100400000000001",
        status: "PROCESSING",
        refundFen: 19900,
      },
    });
    expect(last()).toMatchObject({ method: "POST", path: "/v3/refund/domestic/refunds" });
    expectSignedRequest(last());
    expect(JSON.parse(last().body)).toEqual({
      out_trade_no: NO,
      out_refund_no: "TK20261004000001",
      reason: "开通 7 天内全额退款",
      notify_url: "https://api.example.invalid/api/v1/hooks/wechatpay/refunds",
      amount: { refund: 19900, total: 19900, currency: "CNY" },
    });
    expect(hooked).toEqual(["createRefund"]);
  });

  it("没配退款回调地址、没给原因：请求体里没有这两个键", async () => {
    replies.push(signed(200, accepted));
    await driver({ refundNotifyUrl: undefined }).createRefund(input);
    expect(Object.keys(JSON.parse(last().body) as object).sort()).toEqual(
      ["amount", "out_refund_no", "out_trade_no"].sort(),
    );
  });

  it("金额不是正的整数分、退款超过订单金额：不发请求，直接拒绝", async () => {
    const bad = [
      { refundFen: 0 },
      { refundFen: 1.5 },
      { totalFen: 0 },
      { totalFen: 199.01 },
      { refundFen: 19901 },
    ];
    for (const overrides of bad) {
      expect(await driver().createRefund({ ...input, ...overrides })).toMatchObject({
        ok: false,
        reason: "rejected",
      });
    }
    expect(sent).toHaveLength(0);
  });

  it("业务错误（403 NOT_ENOUGH）：拒绝，带错误码", async () => {
    replies.push(refused(403, "NOT_ENOUGH"));
    expect(await driver().createRefund(input)).toMatchObject({
      ok: false,
      reason: "rejected",
      code: "NOT_ENOUGH",
    });
  });

  it("退款查询 GET /v3/refund/domestic/refunds/{out_refund_no}：各状态", async () => {
    for (const status of ["SUCCESS", "CLOSED", "PROCESSING", "ABNORMAL"] as const) {
      replies.push(signed(200, { ...accepted, status }));
      expect(await driver().queryRefund({ outRefundNo: "TK20261004000001" })).toMatchObject({
        ok: true,
        value: { outRefundNo: "TK20261004000001", status, refundFen: 19900 },
      });
      expect(last()).toMatchObject({
        method: "GET",
        path: "/v3/refund/domestic/refunds/TK20261004000001",
        body: "",
      });
      expectSignedRequest(last());
    }
    expect(hooked).toEqual(["queryRefund", "queryRefund", "queryRefund", "queryRefund"]);
  });

  it("退款单不存在须可信签名的精确404；应答金额不是整数分：不可用", async () => {
    replies.push(signed(404, { code: "RESOURCE_NOT_EXISTS" }));
    expect(await driver().queryRefund({ outRefundNo: "TK-NONE" })).toMatchObject({
      ok: false,
      reason: "rejected",
      code: "RESOURCE_NOT_EXISTS",
      refundNotFound: true,
    });
    replies.push(signed(200, { ...accepted, amount: { total: 19900, refund: 199.5 } }));
    expect(await driver().queryRefund({ outRefundNo: "TK20261004000001" })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("普通404、伪签名、过期签名及非精确错误码不能证明退款未受理", async () => {
    replies.push(
      () => new Response(JSON.stringify({ code: "RESOURCE_NOT_EXISTS" }), { status: 404 }),
    );
    expect(await driver().queryRefund({ outRefundNo: "TK-NONE" })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    const invalid = signed(404, { code: "RESOURCE_NOT_EXISTS" });
    replies.push(async (sent) => {
      const response = await invalid(sent);
      response.headers.set("Wechatpay-Signature", "invalid");
      return response;
    });
    expect(await driver().queryRefund({ outRefundNo: "TK-NONE" })).not.toHaveProperty(
      "refundNotFound",
    );
    replies.push(signed(404, { code: "RESOURCE_NOT_EXISTS" }, new Date(NOW.getTime() - 301_000)));
    expect(await driver().queryRefund({ outRefundNo: "TK-NONE" })).not.toHaveProperty(
      "refundNotFound",
    );
    replies.push(signed(404, { code: "ORDER_NOT_EXIST" }));
    expect(await driver().queryRefund({ outRefundNo: "TK-NONE" })).not.toHaveProperty(
      "refundNotFound",
    );
    replies.push(signed(500, { code: "RESOURCE_NOT_EXISTS" }));
    expect(await driver().queryRefund({ outRefundNo: "TK-NONE" })).not.toHaveProperty(
      "refundNotFound",
    );
  });
});

describe("账单：申请与下载", () => {
  const bill = "交易时间,公众账号ID\n`2026-10-03 10:00:00,`wx0000000000000000\n";
  const sha1 = createHash("sha1").update(bill).digest("hex");
  const downloadUrl = "https://api.mch.weixin.qq.com/v3/billdownload/file?token=TOKEN-0001";
  const ticket = { hash_type: "SHA1", hash_value: sha1, download_url: downloadUrl };
  /** 下载账单的应答不带签名 */
  const file =
    (content: string): Reply =>
    () =>
      new Response(content, { status: 200 });

  it("申请 GET /v3/bill/tradebill?bill_date=…&bill_type=ALL：返回摘要值与下载地址", async () => {
    replies.push(signed(200, ticket));
    expect(await driver().applyTradeBill({ billDate: "2026-10-03" })).toEqual({
      ok: true,
      value: { hashType: "SHA1", hashValue: sha1, downloadUrl },
    });
    expect(last()).toMatchObject({
      method: "GET",
      path: "/v3/bill/tradebill?bill_date=2026-10-03&bill_type=ALL",
    });
    expectSignedRequest(last());
    expect(hooked).toEqual(["applyTradeBill"]);
  });

  it("当日没有账单（NO_STATEMENT_EXIST）：返回 null；账单生成中：可重试；账单日写错：拒绝", async () => {
    replies.push(refused(400, "NO_STATEMENT_EXIST"), refused(400, "STATEMENT_CREATING"));
    expect(await driver().applyTradeBill({ billDate: "2026-10-03" })).toEqual({
      ok: true,
      value: null,
    });
    expect(await driver().applyTradeBill({ billDate: "2026-10-03" })).toMatchObject({
      ok: false,
      reason: "unavailable",
      code: "STATEMENT_CREATING",
    });
    expect(await driver().applyTradeBill({ billDate: "20261003" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(sent).toHaveLength(2);
  });

  it("下载：对下载地址签名后请求；应答不带签名，靠摘要值校验", async () => {
    replies.push(file(bill));
    expect(await driver().downloadBill({ downloadUrl, hashValue: sha1.toUpperCase() })).toEqual({
      ok: true,
      value: { text: bill },
    });
    expect(last()).toMatchObject({ method: "GET", path: "/v3/billdownload/file?token=TOKEN-0001" });
    expectSignedRequest(last());
    expect(hooked).toEqual(["downloadBill"]);
  });

  it("摘要值不符：拒收", async () => {
    replies.push(file(`${bill} `));
    const result = await driver().downloadBill({ downloadUrl, hashValue: sha1 });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(result)).toContain("拒收");
  });

  it("摘要算法不是 SHA1：不发请求，直接拒绝", async () => {
    expect(
      await driver().downloadBill({ downloadUrl, hashValue: sha1, hashType: "SHA256" }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    replies.push(file(bill));
    expect(
      await driver().downloadBill({ downloadUrl, hashValue: sha1, hashType: "sha1" }),
    ).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
  });

  it("下载地址不在微信支付的域名下：不发请求，直接拒绝", async () => {
    for (const url of [
      "https://evil.example.invalid/v3/billdownload/file?token=x",
      "http://api.mch.weixin.qq.com/a",
      "不是地址",
    ]) {
      expect(await driver().downloadBill({ downloadUrl: url, hashValue: sha1 })).toMatchObject({
        ok: false,
        reason: "rejected",
      });
    }
    expect(sent).toHaveLength(0);
  });

  it("备域名的下载地址：照它的域名请求", async () => {
    replies.push(file(bill));
    const url = "https://api2.mch.weixin.qq.com/v3/billdownload/file?token=T2";
    expect(await driver().downloadBill({ downloadUrl: url, hashValue: sha1 })).toMatchObject({
      ok: true,
    });
    expect(last().url).toBe(url);
  });

  it("可信原件绑定请求日/商户与摘要并隔离字节；仅验签400精确缺账作为missing", async () => {
    replies.push(signed(200, ticket), file(bill));
    const value = await driver().fetchVerifiedTradeBill({ billDate: "2026-10-03" });
    expect(value).toMatchObject({
      ok: true,
      value: {
        kind: "verified",
        billDate: "2026-10-03",
        appid: setup.config.appid,
        mchid: setup.config.mchid,
        sha1,
      },
    });
    if (!value.ok || value.value.kind !== "verified") throw new Error("未取得可信原件");
    const first = value.value.bytes;
    first[0] = first[0]! ^ 1;
    expect(new TextDecoder().decode(value.value.bytes)).toBe(bill);
    replies.push(signed(400, { code: "NO_STATEMENT_EXIST" }));
    expect(await driver().fetchVerifiedTradeBill({ billDate: "2026-10-04" })).toMatchObject({
      ok: true,
      value: { kind: "missing", billDate: "2026-10-04" },
    });
    expect(hooked).toEqual(["fetchVerifiedTradeBill", "fetchVerifiedTradeBill"]);
    for (const response of [
      () => new Response(JSON.stringify({ code: "NO_STATEMENT_EXIST" }), { status: 400 }),
      signed(404, { code: "NO_STATEMENT_EXIST" }),
      signed(400, { code: "STATEMENT_CREATING" }),
    ]) {
      replies.push(response);
      expect(await driver().fetchVerifiedTradeBill({ billDate: "2026-10-03" })).toMatchObject({
        ok: false,
      });
    }
  });
  it("可信原件拒绝坏签名ticket/外域/坏摘要/非法日期而不交原件", async () => {
    replies.push(() => new Response(JSON.stringify(ticket), { status: 200 }));
    expect(await driver().fetchVerifiedTradeBill({ billDate: "2026-10-03" })).toMatchObject({
      ok: false,
    });
    replies.push(signed(200, { ...ticket, download_url: "https://outside.example.invalid/bill" }));
    expect(await driver().fetchVerifiedTradeBill({ billDate: "2026-10-03" })).toMatchObject({
      ok: false,
    });
    replies.push(signed(200, ticket), file(`${bill} `));
    expect(await driver().fetchVerifiedTradeBill({ billDate: "2026-10-03" })).toMatchObject({
      ok: false,
    });
    const count = sent.length;
    expect(await driver().fetchVerifiedTradeBill({ billDate: "2026-02-30" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(sent).toHaveLength(count);
  });

  it("fetchTradeBill：申请加下载，返回账单原文；当日没有账单返回空文本", async () => {
    replies.push(signed(200, ticket), file(bill), refused(400, "NO_STATEMENT_EXIST"));
    expect(await driver().fetchTradeBill({ billDate: "2026-10-03" })).toEqual({
      ok: true,
      value: { billDate: "2026-10-03", text: bill },
    });
    expect(await driver().fetchTradeBill({ billDate: "2026-10-04" })).toEqual({
      ok: true,
      value: { billDate: "2026-10-04", text: "" },
    });
    expect(hooked).toEqual(["fetchTradeBill", "fetchTradeBill"]);
  });
});

describe("应答验签、超时与错误归一", () => {
  const query = (config: Partial<WechatPayConfig> = {}) =>
    driver(config).queryByOutTradeNo({ outTradeNo: NO });
  const body = JSON.stringify(transactionResource());

  it.each([
    ["没有签名头", () => new Response(body, { status: 200 })],
    [
      "签名对不上",
      () =>
        new Response(body, {
          status: 200,
          headers: signedHeaders(setup.platform, `${body} `, NOW),
        }),
    ],
    [
      "探测签名",
      () => {
        const headers = signedHeaders(setup.platform, body, NOW);
        const probe = `WECHATPAY/SIGNTEST/${headers["Wechatpay-Signature"]}`;
        return new Response(body, {
          status: 200,
          headers: { ...headers, "Wechatpay-Signature": probe },
        });
      },
    ],
    [
      "别人的私钥签的",
      () => {
        const stranger = generateIdentity(setup.platform.serial);
        return new Response(body, { status: 200, headers: signedHeaders(stranger, body, NOW) });
      },
    ],
    [
      "序列号不认识",
      () => {
        const other = generateIdentity("PUB_KEY_ID_0000000000000000000000000000000099");
        return new Response(body, { status: 200, headers: signedHeaders(other, body, NOW) });
      },
    ],
    [
      "时间戳超过 5 分钟",
      () => {
        const stale = new Date(NOW.getTime() - 5 * 60_000 - 1000);
        return new Response(body, {
          status: 200,
          headers: signedHeaders(setup.platform, body, stale),
        });
      },
    ],
  ] as Array<[string, Reply]>)("应答验签失败 · %s：报错，应答丢弃", async (_name, reply) => {
    replies.push(reply);
    const result = await query();
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(result)).toContain("应答验签失败");
  });

  it("应答验签按 Wechatpay-Serial 选公钥：公钥与平台证书并存时，谁的序列号就用谁的公钥验", async () => {
    const certificate = generateCertificateIdentity();
    const both: Partial<WechatPayConfig> = {
      verifiers: [
        ...setup.config.verifiers,
        { serial: certificate.serial, pem: certificate.certificatePem },
      ],
    };
    const reply =
      (signer: typeof setup.platform, serial: string): Reply =>
      () =>
        new Response(body, {
          status: 200,
          headers: { ...signedHeaders(signer, body, NOW), "Wechatpay-Serial": serial },
        });
    // 各用各的：都通过
    replies.push(
      reply(setup.platform, setup.platform.serial),
      reply(certificate, certificate.serial),
    );
    expect(await query(both)).toMatchObject({ ok: true });
    expect(await query(both)).toMatchObject({ ok: true });
    // 互相冒用：签名是表里另一把密钥签的，序列号写的是这一把，不通过（“表里有一把验得过就算过”拦不住这两例）
    replies.push(
      reply(certificate, setup.platform.serial),
      reply(setup.platform, certificate.serial),
    );
    for (let round = 0; round < 2; round += 1) {
      const result = await query(both);
      expect(result).toMatchObject({ ok: false, reason: "unavailable" });
      expect(JSON.stringify(result)).toContain("应答验签失败");
    }
  });

  it.each([
    ["小写", "order_not_exist"],
    ["带空格与说明", "ORDER_NOT_EXIST 订单不存在"],
    ["带换行", "PARAM_ERROR\nlevel=error msg=伪造的日志行"],
    ["带入参", `ORDER:${NO}`],
    ["太长", "A".repeat(65)],
    ["不是字符串", 40401],
  ])("错误码取自没验签的应答体，写法不认（%s）：不带进结果、信息与日志", async (_name, code) => {
    const logged: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => void logged.push(args) };
    replies.push(() => new Response(JSON.stringify({ code, message: "x" }), { status: 400 }));
    const result = (await driver(
      {},
      { logger: logger as WechatPayDriverDeps["logger"] },
    ).queryByOutTradeNo({ outTradeNo: NO })) as WechatPayFailure;
    expect(result).toMatchObject({ ok: false, reason: "rejected" });
    expect(result.code).toBeUndefined();
    expect(result.message).toBe("微信支付拒绝了请求（HTTP 400）");
    expect(JSON.stringify(logged)).not.toContain(String(code).slice(0, 8));
  });

  it("Request-ID 同样取自没验签的应答：写法不认的不带进信息与日志", async () => {
    replies.push(
      () =>
        new Response(JSON.stringify({ code: "PARAM_ERROR" }), {
          status: 400,
          headers: { "Request-ID": "REQ 1 level=error msg=forged" },
        }),
    );
    const result = (await query()) as WechatPayFailure;
    expect(result).toMatchObject({ ok: false, reason: "rejected", code: "PARAM_ERROR" });
    expect(result.message).toBe("微信支付拒绝了请求（HTTP 400，PARAM_ERROR）");
  });

  it("204 的空应答同样要验签", async () => {
    replies.push(() => new Response(null, { status: 204 }));
    expect(await driver().closeOrder({ outTradeNo: NO })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("超时：到点中止，不可用", async () => {
    replies.push(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          void request;
          setTimeout(() => reject(new DOMException("超时", "TimeoutError")), 30);
        }),
    );
    expect(await query({ timeoutMs: 10 })).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("超时：请求带着中止信号，时限取配置", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal?.reason as Error));
      });
    }) as typeof fetch;
    const result = await driver({ timeoutMs: 20 }, { fetchImpl }).queryByOutTradeNo({
      outTradeNo: NO,
    });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(signal?.aborted).toBe(true);
  });

  it.each([500, 502, 503, 429])("HTTP %i：不可用（可重试）", async (status) => {
    replies.push(refused(status, "SYSTEM_ERROR"));
    expect(await query()).toMatchObject({ ok: false, reason: "unavailable", code: "SYSTEM_ERROR" });
  });

  it.each([
    [400, "PARAM_ERROR"],
    [401, "SIGN_ERROR"],
    [403, "NO_AUTH"],
  ])("业务错误 HTTP %i %s：拒绝，带错误码与 Request-ID", async (status, code) => {
    replies.push(refused(status, code));
    const result = await query();
    expect(result).toMatchObject({ ok: false, reason: "rejected", code });
    expect(JSON.stringify(result)).toContain("REQ-0001");
  });

  it("错误应答不是 JSON（网关的错误页）：照状态码归一", async () => {
    replies.push(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    expect(await query()).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("2xx 的应答不是 JSON 对象：不可用", async () => {
    replies.push(signed(200, "[]"));
    expect(await query()).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("3xx：不跟随重定向，按被拒绝归一", async () => {
    let redirect: RequestInit["redirect"];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://elsewhere.example.invalid/" },
      });
    }) as typeof fetch;
    const result = await driver({}, { fetchImpl }).queryByOutTradeNo({ outTradeNo: NO });
    expect(result).toMatchObject({ ok: false, reason: "rejected" });
    expect(redirect).toBe("manual");
  });

  it("可以换接入点：baseUrl 用备域名", async () => {
    replies.push(signed(200, transactionResource()));
    await query({ baseUrl: "https://api2.mch.weixin.qq.com" });
    expect(last().url.startsWith("https://api2.mch.weixin.qq.com/v3/pay/")).toBe(true);
  });
});

describe("外呼前钩子", () => {
  it("每个发请求的方法入口调一次；钩子抛的错原样抛给调用方，不发请求", async () => {
    const guarded = driver(
      {},
      {
        beforeCall: (call) => {
          throw new Error(`事务里不许外呼：${call.provider}.${call.method}`);
        },
      },
    );
    await expect(
      guarded.createJsapiOrder({
        outTradeNo: NO,
        description: "x",
        amountFen: 1,
        payerOpenid: "o",
      }),
    ).rejects.toThrow("wechatPay.createJsapiOrder");
    await expect(guarded.queryByOutTradeNo({ outTradeNo: NO })).rejects.toThrow(
      "queryByOutTradeNo",
    );
    await expect(guarded.closeOrder({ outTradeNo: NO })).rejects.toThrow("closeOrder");
    await expect(
      guarded.createRefund({ outTradeNo: NO, outRefundNo: "TK1", refundFen: 1, totalFen: 1 }),
    ).rejects.toThrow("createRefund");
    await expect(guarded.queryRefund({ outRefundNo: "TK1" })).rejects.toThrow("queryRefund");
    await expect(guarded.applyTradeBill({ billDate: "2026-10-03" })).rejects.toThrow(
      "applyTradeBill",
    );
    await expect(
      guarded.downloadBill({ downloadUrl: "https://api.mch.weixin.qq.com/x", hashValue: "00" }),
    ).rejects.toThrow("downloadBill");
    await expect(guarded.fetchTradeBill({ billDate: "2026-10-03" })).rejects.toThrow(
      "fetchTradeBill",
    );
    expect(sent).toHaveLength(0);
  });
});

describe("回调入口（驱动上的两个写法）与重处理", () => {
  const paid = { id: "EV-0001", eventType: "TRANSACTION.SUCCESS", resource: transactionResource() };

  it("verifyAndDecryptNotification：通过的给出归一的通知；没通过的一律 rejected", async () => {
    const rawBody = notificationBody(setup.apiV3Key, paid);
    const headers = signedHeaders(setup.platform, rawBody, NOW);
    expect(await driver().verifyAndDecryptNotification({ headers, rawBody })).toMatchObject({
      ok: true,
      value: {
        kind: "transaction",
        id: "EV-0001",
        transaction: { outTradeNo: NO, amountFen: 19900 },
      },
    });
    const refund = notificationBody(setup.apiV3Key, {
      id: "EV-0002",
      eventType: "REFUND.SUCCESS",
      resource: refundResource(),
    });
    expect(
      await driver().verifyAndDecryptNotification({
        headers: signedHeaders(setup.platform, refund, NOW),
        rawBody: refund,
      }),
    ).toMatchObject({ ok: true, value: { kind: "refund", id: "EV-0002" } });
    expect(
      await driver().verifyAndDecryptNotification({ headers, rawBody: `${rawBody} ` }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    const other = notificationBody(setup.apiV3Key, {
      id: "EV-3",
      eventType: "PAYSCORE.X",
      resource: {},
    });
    expect(
      await driver().verifyAndDecryptNotification({
        headers: signedHeaders(setup.platform, other, NOW),
        rawBody: other,
      }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    expect(sent).toHaveLength(0);
  });

  it("verifyNotification 给判别结果；reopenResource 按指定的密钥版本重新解密", () => {
    const rawBody = notificationBody(setup.apiV3Key, paid);
    const headers = signedHeaders(setup.platform, rawBody, NOW);
    const subject = driver();
    const result = subject.verifyNotification({ headers, rawBody: Buffer.from(rawBody) });
    if (!result.ok) throw new Error(result.detail);
    expect(result).toMatchObject({ id: "EV-0001", kid: "v2", serial: setup.platform.serial });
    expect(subject.reopenResource(result.resourceCipher, "v2")).toEqual(result.resource);
    expect(subject.reopenResource(result.resourceCipher, "v1")).toBeNull();
  });

  it("reopenResource：收件行里的 resourceCipher 已清除或存坏了，返回 null，不抛错", () => {
    const subject = driver();
    const broken = [null, undefined, {}, { algorithm: "AEAD_AES_256_GCM", nonce: "n" }];
    for (const cipher of broken as unknown as ResourceCipher[]) {
      expect(subject.reopenResource(cipher, "v2")).toBeNull();
    }
  });

  it("生效状态是驱动名，configured 为 true", () => {
    expect(driver()).toMatchObject({ status: "wechatpay-v3", configured: true });
  });
});
