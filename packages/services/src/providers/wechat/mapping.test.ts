import { describe, expect, it } from "vitest";
import {
  mapWechatFailure,
  sessionResult,
  phoneResult,
  textResult,
  imageResult,
  subscribeResult,
} from "./mapping.js";
import type { WechatMethod } from "./mapping.js";

const water = { timestamp: 1_700_000_000, appid: "wxfake221" };
const phone = (countryCode = "86", purePhoneNumber = "13800138000") => ({
  errcode: 0,
  phone_info: {
    phoneNumber: countryCode === "86" ? purePhoneNumber : `+${countryCode}${purePhoneNumber}`,
    purePhoneNumber,
    countryCode,
    watermark: water,
  },
});

describe("六端点明确错误，不输出上游敏感原文", () => {
  it.each<[WechatMethod, number]>([
    ["code2Session", 40029],
    ["code2Session", 40226],
    ["getPhoneNumber", 40013],
    ["getPhoneNumber", 40029],
    ["sendSubscribeMessage", 40003],
    ["sendSubscribeMessage", 40037],
    ["sendSubscribeMessage", 43101],
    ["sendSubscribeMessage", 43107],
    ["sendSubscribeMessage", 45168],
    ["sendSubscribeMessage", 47003],
    ["createMiniProgramCode", 40129],
    ["createMiniProgramCode", 41030],
    ["createMiniProgramCode", 85096],
    ["checkText", 43104],
    ["checkText", 61010],
    ["checkText", 47001],
    ["checkImage", 40004],
    ["checkImage", 87020],
  ])("%s 明确拒绝 %i", (method, code) => {
    const result = mapWechatFailure(method, {
      ok: false,
      reason: "unavailable",
      message: "SECRET/OPENID/PHONE",
      code,
      status: 200,
    });
    expect(result).toMatchObject({ ok: false, reason: "rejected" });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|OPENID|PHONE|"code"|"status"/);
  });

  it.each([-1, 45009, 45011, 44991, 43108, 40001, 40014, 42001, 999999, 87014])(
    "未知、繁忙、失效token或旧v1码 %i 不假明确业务拒绝",
    (code) => {
      expect(
        mapWechatFailure("checkText", {
          ok: false,
          reason: "rejected",
          message: "raw",
          code,
          status: 200,
        }),
      ).toMatchObject({ reason: "unavailable" });
    },
  );

  it.each([undefined, 302, 429, 500])("HTTP %s 优先于body已知code", (status) => {
    expect(
      mapWechatFailure("code2Session", {
        ok: false,
        reason: "rejected",
        message: "raw",
        code: 40029,
        ...(status === undefined ? {} : { status }),
      }),
    ).toMatchObject({ reason: "unavailable" });
  });

  it("同一码不能跨端点套用，未知400也不猜code错", () => {
    expect(
      mapWechatFailure("checkText", {
        ok: false,
        reason: "rejected",
        message: "raw",
        status: 200,
        code: 40029,
      }),
    ).toMatchObject({ reason: "unavailable" });
    expect(
      mapWechatFailure("code2Session", {
        ok: false,
        reason: "rejected",
        message: "raw",
        status: 400,
      }),
    ).toMatchObject({ reason: "unavailable" });
  });
});

describe("成功投影只能来自真实字段", () => {
  it("登录保留openid/unionid，丢弃session_key和额外正文", () => {
    expect(sessionResult({ openid: "o-fake", unionid: "u-fake", session_key: "SECRET" })).toEqual({
      ok: true,
      value: { openid: "o-fake", unionid: "u-fake" },
    });
    for (const value of [null, {}, { openid: "" }, { openid: 1 }, { openid: "o", unionid: 1 }])
      expect(sessionResult(value)).toMatchObject({ reason: "unavailable" });
  });

  it("86大陆与非86纯11位事实均保留，foreign phone显式带+区号", () => {
    expect(phoneResult(phone(), "wxfake221")).toEqual({
      ok: true,
      value: { phone: "13800138000", countryCode: "86", purePhoneNumber: "13800138000" },
    });
    expect(phoneResult(phone("1", "13125550199"), "wxfake221")).toEqual({
      ok: true,
      value: { phone: "+113125550199", countryCode: "1", purePhoneNumber: "13125550199" },
    });
  });

  it("phone必须真实水印AppID与合法区号/纯号码，不猜归属", () => {
    const baseline = phone();
    const cases = [
      null,
      {},
      { errcode: 0, phone_info: {} },
      { ...baseline, phone_info: { ...baseline.phone_info, watermark: undefined } },
      {
        ...baseline,
        phone_info: { ...baseline.phone_info, watermark: { ...water, appid: "another-app" } },
      },
      {
        ...baseline,
        phone_info: { ...baseline.phone_info, watermark: { ...water, timestamp: "yesterday" } },
      },
      { ...baseline, phone_info: { ...baseline.phone_info, countryCode: "" } },
      { ...baseline, phone_info: { ...baseline.phone_info, purePhoneNumber: "not-phone" } },
      { ...baseline, phone_info: { ...baseline.phone_info, phoneNumber: "9999" } },
    ];
    for (const value of cases)
      expect(phoneResult(value, "wxfake221")).toMatchObject({ reason: "unavailable" });
  });

  it.each([
    ["pass", "pass"],
    ["review", "review"],
    ["risky", "block"],
  ])("text真实suggest %s→%s，不输出detail", (suggest, verdict) => {
    expect(
      textResult({ errcode: 0, result: { suggest }, trace_id: "trace-fake", detail: "PRIVATE" }),
    ).toEqual({ ok: true, value: { verdict, traceId: "trace-fake" } });
  });

  it("文本缺结论不放行、图片只pending、订阅仅明确零码accepted", () => {
    for (const value of [{}, { errcode: 0 }, { errcode: 0, result: { suggest: "unknown" } }])
      expect(textResult(value)).toMatchObject({ reason: "unavailable" });
    expect(
      imageResult({ errcode: 0, trace_id: "trace-fake", result: { suggest: "pass" } }),
    ).toEqual({ ok: true, value: { verdict: "pending", traceId: "trace-fake" } });
    expect(imageResult({ errcode: 0 })).toMatchObject({ reason: "unavailable" });
    expect(imageResult({ errcode: 0, trace_id: "" })).toMatchObject({ reason: "unavailable" });
    expect(subscribeResult({ errcode: 0 })).toEqual({ ok: true, value: undefined });
    expect(subscribeResult({})).toMatchObject({ reason: "unavailable" });
  });
});
