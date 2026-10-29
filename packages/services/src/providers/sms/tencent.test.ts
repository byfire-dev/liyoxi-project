import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviders, ProviderConfigError } from "../index.js";
import type { SmsProvider, SmsTemplateBinding } from "../types.js";
import { createSmsHttp } from "./http.js";
import { signSms } from "./sign.js";
import { createTencentSms } from "./tencent.js";

const config = {
  secretId: "AKIDEXAMPLE",
  secretKey: "SECRETKEYEXAMPLE",
  sdkAppId: "1400006666",
  region: "ap-guangzhou",
};
const template: SmsTemplateBinding = {
  templateKey: "generic_todo",
  kind: "notice",
  status: "active",
  providerTemplateId: "1234",
  signName: "测试平台",
  params: [{ name: "item", maxLen: 12 }],
};
const phone = "13800138000";
const input = { phone, template, params: { item: "样片确认" } };
const now = () => new Date("2019-02-25T16:17:45.000Z");
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let server: Server | undefined;
async function local(
  reply: (
    request: { headers: Record<string, unknown>; body: Record<string, unknown> },
    response: ServerResponse,
  ) => void,
) {
  let calls = 0;
  server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part as Buffer);
    calls++;
    reply(
      {
        headers: req.headers,
        body: JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>,
      },
      res,
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("本地测试服务未就绪");
  const forwarding: typeof fetch = (url, init) => {
    expect(url).toBe("https://sms.tencentcloudapi.com/");
    expect(new Headers(init?.headers).get("host")).toBe("sms.tencentcloudapi.com");
    return fetch(`http://127.0.0.1:${address.port}/`, init);
  };
  return { fetch: forwarding, calls: () => calls };
}
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  vi.clearAllMocks();
});
const success = {
  Response: {
    RequestId: "request-123",
    SendStatusSet: [{ Code: "Ok", SerialNo: "message-456", PhoneNumber: "+8613800138000", Fee: 1 }],
  },
};
const sendJson = (response: ServerResponse, json: unknown) => response.end(JSON.stringify(json));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// sendTemplate 到注入 fetch 同步执行；只接管该段创建的 Provider 截止计时器。
// 进入原生 fetch 前恢复全局函数，HTTP 客户端的所有内部计时器保持真实运行。
function captureDeadline(forward: typeof fetch, expectedMs: number) {
  const timer = vi.spyOn(globalThis, "setTimeout");
  let entered = false,
    restored = false,
    fire: (() => void) | undefined;
  const restore = () => {
    if (!restored) timer.mockRestore();
    restored = true;
  };
  return {
    fetch: ((url, init) => {
      entered = true;
      try {
        expect(timer).toHaveBeenCalledTimes(1);
        const call = timer.mock.calls[0]!;
        expect(call).toHaveLength(2);
        expect(call[1]).toBe(expectedMs);
        expect(timer.mock.results[0]?.type).toBe("return");
        clearTimeout(timer.mock.results[0]!.value as ReturnType<typeof setTimeout>);
        fire = call[0];
      } finally {
        restore();
      }
      return forward(url, init);
    }) satisfies typeof fetch,
    entered: () => entered,
    fire: () => {
      expect(fire).toBeTypeOf("function");
      fire!();
    },
    restore,
  };
}

describe("腾讯云短信：TC3 与真实本地 HTTP（公开虚构凭据，不发真实短信）", () => {
  it("官方 Node SMS demo 固定向量；期望值由独立 Python hashlib/hmac 计算", () => {
    // https://github.com/TencentCloud/signature-process-demo/blob/main/services/sms/signature-v3/nodejs/demo.js
    // 取官方同序 payload，固定时间和公开虚构凭据；期望值不由 signSms 计算。
    const payload =
      '{"SmsSdkAppId":"1400006666","SignName":"腾讯云","TemplateId":"1234","TemplateParamSet":["12345"],"PhoneNumberSet":["+8618511122266"],"SessionContext":"test"}';
    expect(signSms({ ...config, timestamp: 1551113065, payload })).toBe(
      "TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2019-02-25/sms/tc3_request, SignedHeaders=content-type;host, Signature=f21793f6e1c1ad8af04c5c4b94dde02fd16e6da2eb1d09481588907d2bb188f8",
    );
  });
  it("请求签名、版本、区域、E.164、有序变量与实际 SerialNo/RequestId", async () => {
    const http = await local(({ headers, body }, res) => {
      expect(headers["host"]).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(headers["x-tc-action"]).toBe("SendSms");
      expect(headers["x-tc-version"]).toBe("2021-01-11");
      expect(headers["x-tc-region"]).toBe("ap-guangzhou");
      expect(headers["authorization"]).toBe(
        signSms({
          ...config,
          timestamp: Number(headers["x-tc-timestamp"]),
          payload: JSON.stringify(body),
        }),
      );
      expect(body).toEqual({
        SmsSdkAppId: "1400006666",
        SignName: "测试平台",
        TemplateId: "1234",
        TemplateParamSet: ["样片确认"],
        PhoneNumberSet: ["+8613800138000"],
      });
      sendJson(res, success);
    });
    const sms = createTencentSms({ config, ...http, now, getTemplate: async () => template });
    expect(await sms.sendTemplate(input)).toEqual({
      ok: true,
      value: { requestId: "request-123", providerMsgId: "message-456" },
    });
    expect(http.calls()).toBe(1);
    expect(await sms.checkBalance()).toMatchObject({ ok: false, reason: "unsupported" });
    expect(http.calls()).toBe(1);
  });
  it.each([
    "RequestLimitExceeded",
    "FailedOperation.InsufficientBalanceInSmsPackage",
    "AuthFailure.SignatureFailure",
  ])("官方拒绝 %s：只发一次且不回显 message/号码", async (code) => {
    const http = await local((_req, res) =>
      sendJson(res, {
        Response: {
          RequestId: "request-failure",
          Error: { Code: code, Message: `sensitive-${phone}-${config.secretKey}` },
        },
      }),
    );
    const result = await createTencentSms({
      config,
      ...http,
      getTemplate: async () => template,
    }).sendTemplate(input);
    expect(result).toMatchObject({
      ok: false,
      reason: "rejected",
      providerCode: code,
      requestId: "request-failure",
      acceptance: "not_accepted",
    });
    expect(JSON.stringify(result)).not.toContain(phone);
    expect(JSON.stringify(result)).not.toContain(config.secretKey);
    expect(http.calls()).toBe(1);
  });
  it.each(["InternalError.Timeout", "InternalError.SendAndRecvFail", undefined])(
    "逐号码结果 %s 不确定受理，只调用一次",
    async (code) => {
      const http = await local((_req, res) =>
        sendJson(res, {
          Response: {
            RequestId: "request-uncertain",
            SendStatusSet: [{ Code: code, SerialNo: "", PhoneNumber: "+8613800138000" }],
          },
        }),
      );
      expect(
        await createTencentSms({ config, ...http, getTemplate: async () => template }).sendTemplate(
          input,
        ),
      ).toMatchObject({ ok: false, reason: "unavailable", acceptance: "unknown" });
      expect(http.calls()).toBe(1);
    },
  );
  it.each([
    [undefined, "FailedOperation.InsufficientBalanceInSmsPackage", "unknown"],
    ["FailedOperation.InsufficientBalanceInSmsPackage", undefined, "unknown"],
    ["InternalError.Timeout", "FailedOperation.InsufficientBalanceInSmsPackage", "unknown"],
    ["FailedOperation.InsufficientBalanceInSmsPackage", "InternalError.SendAndRecvFail", "unknown"],
    [
      "FailedOperation.InsufficientBalanceInSmsPackage",
      "InvalidParameterValue.IncorrectPhoneNumber",
      "not_accepted",
    ],
  ])("批量失败 %s / %s 保留整体受理事实 %s", async (first, second, acceptance) => {
    const http = await local((_req, res) =>
      sendJson(res, {
        Response: {
          RequestId: "request-batch-failure",
          SendStatusSet: [
            { Code: first, SerialNo: "", PhoneNumber: "+8613800138000" },
            { Code: second, SerialNo: "", PhoneNumber: "+8613900139000" },
          ],
        },
      }),
    );
    const sms = createTencentSms({
      config,
      ...http,
      getTemplate: async () => ({
        ...template,
        templateKey: "ops_alert",
        params: [{ name: "rule_name", maxLen: 64 }],
      }),
    });
    expect(
      await sms.sendOncallAlert({
        phones: [phone, "13900139000"],
        title: "短信保活",
        content: "私有上下文",
      }),
    ).toMatchObject({
      ok: false,
      reason: acceptance === "unknown" ? "unavailable" : "rejected",
      acceptance,
    });
    expect(http.calls()).toBe(1);
  });
  it("超出已登记模板字段长度时不外呼", async () => {
    const http = await local((_req, res) => sendJson(res, success));
    const sms = createTencentSms({ config, ...http, getTemplate: async () => template });
    expect(
      await sms.sendTemplate({
        ...input,
        template: { ...template, providerTemplateId: "1".repeat(33) },
      }),
    ).toMatchObject({ ok: false, reason: "unconfigured", acceptance: "not_accepted" });
    expect(http.calls()).toBe(0);
  });
  it.each(["serial", "request", "phone", "malformed"])("异常 %s 不造成功、不重试", async (mode) => {
    const copy = structuredClone(success);
    if (mode === "serial") copy.Response.SendStatusSet[0]!.SerialNo = "";
    if (mode === "request") copy.Response.RequestId = "";
    if (mode === "phone") copy.Response.SendStatusSet[0]!.PhoneNumber = "+8613900139000";
    const http = await local((_req, res) =>
      mode === "malformed" ? res.end("not-json") : sendJson(res, copy),
    );
    expect(
      await createTencentSms({ config, ...http, getTemplate: async () => template }).sendTemplate(
        input,
      ),
    ).toMatchObject({ ok: false, acceptance: "unknown" });
    expect(http.calls()).toBe(1);
  });
  it("5xx、网络断开、超时均不重发", async () => {
    let mode = "5xx",
      arrived = deferred();
    const http = await local((_req, res) => {
      arrived.resolve();
      if (mode === "5xx") {
        res.statusCode = 503;
        res.end("private");
      } else if (mode === "network") res.destroy();
    });
    const fetcher = vi.fn(http.fetch);
    for (mode of ["5xx", "network", "timeout"]) {
      arrived = deferred();
      const control = new AbortController(),
        beforeFetch = fetcher.mock.calls.length,
        beforeArrival = http.calls(),
        deadline = captureDeadline(fetcher, 25);
      let settled = false,
        pending: ReturnType<SmsProvider["sendTemplate"]> | undefined;
      try {
        const sms = createTencentSms({
          config,
          fetch: deadline.fetch,
          timeoutMs: 25,
          getTemplate: async () => template,
        });
        pending = sms.sendTemplate({ ...input, signal: control.signal }).then((result) => {
          settled = true;
          return result;
        });
        expect(deadline.entered()).toBe(true);
        await Promise.race([arrived.promise, pending]);
        expect(http.calls()).toBe(beforeArrival + 1);
        expect(fetcher).toHaveBeenCalledTimes(beforeFetch + 1);
        const sentSignal = fetcher.mock.calls[beforeFetch]?.[1]?.signal;
        expect(sentSignal).toBeInstanceOf(AbortSignal);
        if (mode === "timeout") {
          expect(settled).toBe(false);
          expect(sentSignal?.aborted).toBe(false);
          deadline.fire();
        }
        expect(await pending).toMatchObject({
          ok: false,
          reason: "unavailable",
          acceptance: "unknown",
        });
        expect(sentSignal?.aborted).toBe(mode === "timeout");
        expect(fetcher).toHaveBeenCalledTimes(beforeFetch + 1);
        expect(http.calls()).toBe(beforeArrival + 1);
      } finally {
        deadline.restore();
        control.abort();
        await pending?.catch(() => undefined);
      }
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(http.calls()).toBe(3);
  });
  it("取消响应头等待与响应流及时回收；超限响应拒绝", async () => {
    let mode = "wait",
      arrived = deferred(),
      reading = deferred();
    let readStarted: boolean;
    const http = await local((_req, res) => {
      if (mode === "stream") {
        res.writeHead(200);
        res.write('{"Response":');
      } else if (mode === "large") res.end("x".repeat(262145));
      arrived.resolve();
    });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const response = await http.fetch(url, init);
      if (mode === "stream" && response.body) {
        // 保留真实Response、正文和reader，只观测生产代码首次进入真实read。
        const reader = response.body.getReader(),
          read = reader.read.bind(reader),
          entered = reading;
        Object.defineProperty(reader, "read", {
          value: () => {
            const next = read();
            readStarted = true;
            entered.resolve();
            return next;
          },
        });
        Object.defineProperty(response.body, "getReader", { value: () => reader });
      }
      return response;
    });
    for (mode of ["wait", "stream", "large"]) {
      arrived = deferred();
      reading = deferred();
      readStarted = false;
      const control = new AbortController(),
        beforeFetch = fetcher.mock.calls.length,
        beforeArrival = http.calls(),
        deadline = captureDeadline(fetcher, 1000);
      let settled = false,
        pending: ReturnType<SmsProvider["sendTemplate"]> | undefined,
        timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const sms = createTencentSms({
          config,
          fetch: deadline.fetch,
          timeoutMs: 1000,
          getTemplate: async () => template,
        });
        pending = sms.sendTemplate({ ...input, signal: control.signal }).then((result) => {
          settled = true;
          return result;
        });
        expect(deadline.entered()).toBe(true);
        await Promise.race([arrived.promise, pending]);
        expect(http.calls()).toBe(beforeArrival + 1);
        expect(fetcher).toHaveBeenCalledTimes(beforeFetch + 1);
        if (mode === "stream") {
          await Promise.race([reading.promise, pending]);
          expect(readStarted).toBe(true);
        }
        const sentSignal = fetcher.mock.calls[beforeFetch]?.[1]?.signal;
        if (mode !== "large") {
          expect(settled).toBe(false);
          expect(control.signal.aborted).toBe(false);
          expect(sentSignal?.aborted).toBe(false);
          timer = setTimeout(() => control.abort(), 25);
        }
        expect(await pending).toMatchObject({ ok: false, acceptance: "unknown" });
        if (mode !== "large") {
          expect(control.signal.aborted).toBe(true);
          expect(sentSignal?.aborted).toBe(true);
        }
        expect(fetcher).toHaveBeenCalledTimes(beforeFetch + 1);
        expect(http.calls()).toBe(beforeArrival + 1);
      } finally {
        deadline.restore();
        if (timer !== undefined) clearTimeout(timer);
        control.abort();
        await pending?.catch(() => undefined);
      }
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(http.calls()).toBe(3);
  });
  it("已经取消、模板禁用、多余/缺失/超长变量、8位激活码，外呼前拒绝", async () => {
    const http = await local((_req, res) => sendJson(res, success));
    const sms = createTencentSms({
      config,
      ...http,
      getTemplate: async () => ({
        ...template,
        kind: "verify",
        templateKey: "verify_code",
        params: [{ name: "code", maxLen: 6 }],
      }),
    });
    const invalid: Parameters<SmsProvider["sendTemplate"]>[0][] = [
      { ...input, template: { ...template, status: "disabled" } },
      { ...input, params: {} },
      { ...input, params: { item: "x".repeat(13) } },
      { ...input, params: { item: "样片", extra: "x" } },
    ];
    for (const data of invalid)
      expect(await sms.sendTemplate(data)).toMatchObject({ ok: false, reason: "rejected" });
    expect(await sms.sendActivationCode({ phone, code: "AB23CD45" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(await sms.sendTemplate({ ...input, signal: AbortSignal.abort() })).toMatchObject({
      ok: false,
      acceptance: "not_accepted",
    });
    for (const templateKey of ["constructor", "__proto__", "toString"])
      expect(
        await sms.sendTemplate({ ...input, template: { ...template, templateKey } }),
      ).toMatchObject({ ok: false, reason: "rejected" });
    expect(http.calls()).toBe(0);
  });
  it("legacy多值班号码一次批量调用，不逐目标重发；部分受理不得假全成功", async () => {
    let partial = false;
    const http = await local(({ body }, res) => {
      expect(body["PhoneNumberSet"]).toEqual(["+8613800138000", "+8613900139000"]);
      sendJson(res, {
        Response: {
          RequestId: "request-oncall",
          SendStatusSet: [
            { Code: "Ok", SerialNo: "message-1", PhoneNumber: "+8613800138000" },
            {
              Code: partial ? "FailedOperation.InsufficientBalanceInSmsPackage" : "Ok",
              SerialNo: partial ? "" : "message-2",
              PhoneNumber: "+8613900139000",
            },
          ],
        },
      });
    });
    const sms = createTencentSms({
      config,
      ...http,
      getTemplate: async () => ({
        ...template,
        templateKey: "ops_alert",
        params: [{ name: "rule_name", maxLen: 64 }],
      }),
    });
    const data = {
      phones: ["13800138000", "13900139000"],
      title: "短信保活",
      content: "此详细上下文不进入固定短信变量",
    };
    expect(await sms.sendOncallAlert(data)).toEqual({ ok: true, value: undefined });
    partial = true;
    expect(await sms.sendOncallAlert(data)).toMatchObject({ ok: false, acceptance: "unknown" });
    expect(http.calls()).toBe(2);
  });
  it("内部错误受理不明、非固定事项与继承字段外呼前拒绝", async () => {
    const http = await local((_req, res) =>
      sendJson(res, {
        Response: {
          RequestId: "request-internal",
          Error: { Code: "InternalError", Message: "private" },
        },
      }),
    );
    const sms = createTencentSms({ config, ...http, getTemplate: async () => template });
    expect(await sms.sendTemplate({ ...input, params: { item: "自由营销正文" } })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    const inherited = Object.assign(Object.create({ item: "样片确认" }) as Record<string, string>, {
      extra: "x",
    });
    expect(await sms.sendTemplate({ ...input, params: inherited })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(await sms.sendTemplate(input)).toMatchObject({
      ok: false,
      reason: "unavailable",
      acceptance: "unknown",
    });
    expect(http.calls()).toBe(1);
  });
  it("成组工厂配置及生产禁止 console；构造不外呼", () => {
    const fetcher = vi.fn<typeof fetch>();
    const chosen = createProviders({
      appEnv: "prod",
      logger,
      settings: {
        sms: {
          driver: "tencent",
          tencent: { config, fetch: fetcher, getTemplate: async () => template },
        },
      },
    });
    expect(chosen.sms.status).toBe("tencent");
    expect(fetcher).not.toHaveBeenCalled();
    expect(() =>
      createProviders({ appEnv: "prod", logger, settings: { sms: { driver: "console" } } }),
    ).toThrow(ProviderConfigError);
    expect(() =>
      createProviders({ appEnv: "prod", logger, settings: { sms: { driver: "tencent" } } }),
    ).toThrow(ProviderConfigError);
  });
  it("私有统计请求使用真实 Action/版本，未装配成账号总余量", async () => {
    const http = await local(({ headers, body }, res) => {
      expect(headers["x-tc-action"]).toBe("SmsPackagesStatistics");
      expect(body).toMatchObject({
        BeginTime: "2026010100",
        EndTime: "2026100700",
        Limit: 500,
        Offset: 0,
      });
      sendJson(res, {
        Response: {
          RequestId: "stats-request",
          SmsPackagesStatisticsSet: [
            {
              PackageCreateTime: 1767225600,
              PackageEffectiveTime: 1767225600,
              PackageExpiredTime: 1798761600,
              PackageAmount: 100,
              CurrentUsage: 20,
              PackageId: 1000791745,
              PackageType: 1,
            },
          ],
        },
      });
    });
    expect(
      await createSmsHttp({ config, ...http })("SmsPackagesStatistics", {
        SmsSdkAppId: config.sdkAppId,
        BeginTime: "2026010100",
        EndTime: "2026100700",
        Limit: 500,
        Offset: 0,
      }),
    ).toMatchObject({ ok: true });
    expect(http.calls()).toBe(1);
  });
});
