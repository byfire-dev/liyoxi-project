import { describe, expect, expectTypeOf, it } from "vitest";

import {
  failed,
  notificationFailed,
  notificationOk,
  NOTIFICATION_FAILURE_CODES,
  ok,
} from "./types.js";
import type {
  NotificationFailureDetail,
  NotificationProviderResult,
  ProviderResult,
  WechatProvider,
} from "./types.js";

const detail = { acceptance: "not_accepted", code: "rate_limited" } as const;

describe("通知结果：旧协议兼容与显式受理事实", () => {
  it("旧 void success/通用失败仍直接是通知结果，不制造受理证明", () => {
    const legacy: ProviderResult<void>[] = [ok(undefined), failed("unavailable", "服务不可用")];
    for (const result of legacy) {
      const notification: NotificationProviderResult<void> = result;
      expect(notification).toBe(result);
      expect(notification).not.toHaveProperty("notification");
      expect(notification).not.toHaveProperty("providerMsgId");
    }
    expect(failed("rejected", "拒绝")).toEqual({ ok: false, reason: "rejected", message: "拒绝" });
    expectTypeOf<Awaited<ReturnType<WechatProvider["sendSubscribeMessage"]>>>().toEqualTypeOf<
      NotificationProviderResult<void>
    >();
  });

  it("分类和reason独立，不把unavailable自动当可重发", () => {
    expect(notificationFailed("unavailable", "明确未受理", detail)).toMatchObject({
      reason: "unavailable",
      notification: detail,
    });
    expect(
      notificationFailed("rejected", "受理结果未知", {
        acceptance: "unknown",
        code: "provider_rejected",
      }),
    ).toMatchObject({
      reason: "rejected",
      notification: { acceptance: "unknown", code: "provider_rejected" },
    });
    const result = notificationFailed("rejected", "有限摘要", detail);
    expect(result.notification).not.toBe(detail);
  });

  it.each(NOTIFICATION_FAILURE_CODES)("固定code %s", (code) => {
    expect(
      notificationFailed("rejected", "有限摘要", { acceptance: "not_accepted", code }).notification
        ?.code,
    ).toBe(code);
  });

  it.each([
    null,
    undefined,
    "rate_limited",
    {},
    { acceptance: "accepted", code: "rate_limited" },
    { acceptance: "unknown", code: "constructor" },
    { acceptance: "unknown", code: "__proto__" },
    { acceptance: "unknown", code: "toString" },
    { acceptance: "unknown", code: "47003" },
    { acceptance: "unknown", code: "rate_limited", response: "raw-sensitive-body" },
    Object.create(detail) as unknown,
    { ...detail, [Symbol("extra")]: true },
  ])("强转也拒绝非法/继承/额外分类，错误不回显输入 %#", (value) => {
    expect(() =>
      notificationFailed("rejected", "有限摘要", value as NotificationFailureDetail),
    ).toThrow("通知失败分类不合法");
  });

  it("成功ID仅可选、有界安全标识，没有真实ID就不造字段", () => {
    expect(notificationOk(undefined)).toEqual(ok(undefined));
    expect(notificationOk({ messageId: "mail-1" }, "A".repeat(64))).toEqual({
      ok: true,
      value: { messageId: "mail-1" },
      providerMsgId: "A".repeat(64),
    });
    expect(notificationOk(undefined, "sms-1.A:2_b").providerMsgId).toBe("sms-1.A:2_b");
  });

  it.each([
    "",
    "A".repeat(65),
    "https://example.invalid/1",
    "abc\n",
    "abc\r",
    "abc\u2028",
    "abc def",
    "商家",
    "-1",
    123,
    null,
  ])("拒绝不安全的ID %#", (id) => {
    expect(() => notificationOk(undefined, id as string)).toThrow("通知服务商标识不合法");
  });
});

describe("未配置与local通知：取消/成功不伪外部收据", () => {
  it("六个未配置通知方法明确未受理，非通知仍沿原通用失败", async () => {
    const { unconfiguredProviders } = await import("./unconfigured.js");
    const p = unconfiguredProviders;
    const results = await Promise.all([
      p.wechat.sendSubscribeMessage({ openid: "fake", templateId: "fake", data: {} }),
      p.sms.sendActivationCode({ phone: "13800138000", code: "TEST1234" }),
      p.sms.sendSubscribeFallback({
        phone: "13800138000",
        templateKey: "generic_todo",
        params: {},
      }),
      p.sms.sendOncallAlert({ phones: ["13800138000"], title: "假告警", content: "假摘要" }),
      p.wecom.sendAppMessage({ toUser: "fake", title: "假待办", description: "假摘要" }),
      p.mail.send({ to: "fake@example.invalid", subject: "假主题", text: "假正文" }),
    ]);
    for (const result of results)
      expect(result).toMatchObject({
        reason: "unconfigured",
        notification: { acceptance: "not_accepted", code: "unconfigured" },
      });
    expect(await p.wechat.code2Session({ code: "fake" })).not.toHaveProperty("notification");
    expect(await p.wechatPay.queryByOutTradeNo({ outTradeNo: "fake" })).not.toHaveProperty(
      "notification",
    );
    expect(await p.storage.head({ bucket: "pub", key: "fake" })).not.toHaveProperty("notification");
  });

  it("local微信与三个consoleSMS预取消无日志，不回显signal.reason", async () => {
    const { createLocalWechat, unconfiguredProviders } = await import("./unconfigured.js");
    const { createConsoleSms } = await import("./sms/console.js");
    const { createRecordingLogger } = await import("../testing/index.js");
    const logger = createRecordingLogger();
    const controller = new AbortController();
    controller.abort("PRIVATE_CANCEL_REASON");
    const signal = controller.signal;
    const sms = createConsoleSms({ logger });
    const results = await Promise.all([
      createLocalWechat({ logger }).sendSubscribeMessage({
        openid: "fake",
        templateId: "fake",
        data: {},
        signal,
      }),
      sms.sendActivationCode({ phone: "13800138000", code: "TEST1234", signal }),
      sms.sendSubscribeFallback({
        phone: "13800138000",
        templateKey: "generic_todo",
        params: {},
        signal,
      }),
      sms.sendOncallAlert({ phones: ["13800138000"], title: "假告警", content: "假摘要", signal }),
      unconfiguredProviders.mail.send({
        to: "fake@example.invalid",
        subject: "假主题",
        text: "假正文",
        signal,
      }),
    ]);
    for (const result of results)
      expect(result).toMatchObject({
        notification: { acceptance: "not_accepted", code: "aborted" },
      });
    expect(JSON.stringify(results)).not.toContain("PRIVATE_CANCEL_REASON");
    expect(logger.lines).toHaveLength(0);
  });
});
