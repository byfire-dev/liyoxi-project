import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withBeforeCall } from "../types.js";
import type { SmsTemplateBinding } from "../types.js";
import { createTencentSms } from "./tencent.js";

const config = {
  secretId: "AKIDEXAMPLE",
  secretKey: "SECRETKEYEXAMPLE",
  sdkAppId: "1400006666",
  region: "ap-guangzhou",
};
const phone = "13800138000";
const template: SmsTemplateBinding = {
  templateKey: "generic_todo",
  kind: "notice",
  status: "active",
  providerTemplateId: "1234",
  signName: "测试平台",
  params: [{ name: "item", maxLen: 12 }],
};
const input = { phone, templateKey: "generic_todo", params: { item: "样片确认" } };
const response = (code = "Ok", serial = "message-fake") => ({
  Response: {
    RequestId: "request-fake",
    SendStatusSet: [{ PhoneNumber: `+86${phone}`, Code: code, SerialNo: serial }],
  },
});
const json = (value: unknown) => new Response(JSON.stringify(value));
let server: Server | undefined;
const sockets = new Set<Socket>();
afterEach(async () => {
  const connectionsClosed = Promise.all(
    [...sockets].map((socket) => new Promise<void>((resolve) => socket.once("close", resolve))),
  );
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await connectionsClosed;
  server = undefined;
  expect(sockets.size).toBe(0);
  vi.restoreAllMocks();
});

describe("旧腾讯短信方法接真实通知结果协议", () => {
  it("预取消先于模板读取/HTTP，并保持外层原guard先于预取消", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(response()));
    const reader = vi.fn(async () => template);
    const sms = createTencentSms({ config, fetch: fetcher, getTemplate: reader });
    const signal = AbortSignal.abort(new Error("PRIVATE_ABORT_REASON"));
    for (const call of [
      () => sms.sendSubscribeFallback({ ...input, signal }),
      () => sms.sendActivationCode({ phone, code: "123456", signal }),
      () => sms.sendOncallAlert({ phones: [phone], title: "测试", content: "私有内容", signal }),
    ])
      expect(await call()).toMatchObject({
        ok: false,
        notification: { acceptance: "not_accepted", code: "aborted" },
      });
    expect(reader).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    const failure = new Error("GUARD_PROGRAM_ERROR");
    const guarded = withBeforeCall("sms", sms, () => {
      throw failure;
    });
    await expect(guarded.sendSubscribeFallback({ ...input, signal })).rejects.toBe(failure);
  });

  it("单号码返回平台真实SerialNo，批量不能冒用首号码编号", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(response()));
    const sms = createTencentSms({
      config,
      fetch: fetcher,
      getTemplate: async (key) =>
        key === "ops_alert"
          ? { ...template, templateKey: key, params: [{ name: "rule_name", maxLen: 64 }] }
          : template,
    });
    expect(await sms.sendSubscribeFallback(input)).toEqual({
      ok: true,
      value: undefined,
      providerMsgId: "message-fake",
    });
    fetcher.mockResolvedValueOnce(
      json({
        Response: {
          RequestId: "request-batch",
          SendStatusSet: [
            { PhoneNumber: `+86${phone}`, Code: "Ok", SerialNo: "message-first" },
            { PhoneNumber: "+8613900139000", Code: "Ok", SerialNo: "message-second" },
          ],
        },
      }),
    );
    expect(
      await sms.sendOncallAlert({
        phones: [phone, "13900139000"],
        title: "测试",
        content: "私有内容",
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["FailedOperation.InsufficientBalanceInSmsPackage", "not_accepted", "provider_rejected"],
    ["InternalError.Timeout", "unknown", "unknown_outcome"],
    [undefined, "unknown", "unknown_outcome"],
  ])("完整逐号码结果%s保持受理事实%s", async (code, acceptance, mapped) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        Response: {
          RequestId: "request-fake",
          SendStatusSet: [{ PhoneNumber: `+86${phone}`, Code: code, Message: "RAW_PRIVATE" }],
        },
      }),
    );
    const sms = createTencentSms({ config, fetch: fetcher, getTemplate: async () => template });
    const result = await sms.sendSubscribeFallback(input);
    expect(result).toMatchObject({
      ok: false,
      acceptance,
      notification: { acceptance, code: mapped },
    });
    expect(JSON.stringify(result)).not.toMatch(/RAW_PRIVATE|13800138000|SECRETKEYEXAMPLE/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("缺模板、读失败和8位员工激活均证明目标未发送，保留原8位协议拒绝", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const reader of [
      async () => null,
      async () => {
        throw new Error("PRIVATE_REPO_FAILURE");
      },
    ]) {
      const sms = createTencentSms({ config, fetch: fetcher, getTemplate: reader });
      expect(await sms.sendSubscribeFallback(input)).toMatchObject({
        ok: false,
        notification: { acceptance: "not_accepted" },
      });
    }
    const sms = createTencentSms({ config, fetch: fetcher, getTemplate: async () => template });
    expect(await sms.sendActivationCode({ phone, code: "AB23CD45" })).toMatchObject({
      ok: false,
      reason: "rejected",
      notification: { acceptance: "not_accepted", code: "provider_rejected" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["FailedOperation.InsufficientBalanceInSmsPackage", "InternalError.Timeout"])(
    "已经完整解码%s后到来的取消不能覆盖明确/未知受理事实",
    async (code) => {
      const control = new AbortController();
      const wire = JSON.stringify(response(code, ""));
      const originalParse = JSON.parse;
      vi.spyOn(JSON, "parse").mockImplementation((raw: string) => {
        const value: unknown = originalParse(raw);
        if (raw === wire) control.abort(new Error("PRIVATE_LATE_ABORT"));
        return value;
      });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(wire));
      const sms = createTencentSms({ config, fetch: fetcher, getTemplate: async () => template });
      expect(await sms.sendSubscribeFallback({ ...input, signal: control.signal })).toMatchObject({
        ok: false,
        notification: {
          acceptance: code.startsWith("InternalError") ? "unknown" : "not_accepted",
          code: code.startsWith("InternalError") ? "unknown_outcome" : "provider_rejected",
        },
      });
      expect(control.signal.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("caller取消关闭自己的实际socket，另一调用继续受理；不重发", async () => {
    let arrived!: () => void;
    const started = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let calls = 0;
    let firstClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      firstClosed = resolve;
    });
    server = createServer(async (request, res) => {
      for await (const _chunk of request) {
        /* 消费测试请求体 */
      }
      calls++;
      if (calls === 1) {
        request.socket.once("close", firstClosed);
        arrived();
      } else res.end(JSON.stringify(response()));
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("测试HTTP未就绪");
    let fetchSignal: AbortSignal | undefined;
    const forwarding: typeof fetch = (url, init) => {
      expect(url).toBe("https://sms.tencentcloudapi.com/");
      fetchSignal ??= init?.signal ?? undefined;
      return fetch(`http://127.0.0.1:${address.port}/`, init);
    };
    const sms = createTencentSms({
      config,
      fetch: forwarding,
      getTemplate: async () => template,
      timeoutMs: 1000,
    });
    const controller = new AbortController();
    const pending = sms.sendSubscribeFallback({ ...input, signal: controller.signal });
    await started;
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    const forwardedImmediately = fetchSignal?.aborted;
    const second = await sms.sendSubscribeFallback(input);
    const first = await pending;
    await closed;
    expect(forwardedImmediately).toBe(true);
    expect(first).toMatchObject({
      notification: { acceptance: "unknown", code: "unknown_outcome" },
    });
    expect(second).toMatchObject({ ok: true, providerMsgId: "message-fake" });
    expect(calls).toBe(2);
  });
});
