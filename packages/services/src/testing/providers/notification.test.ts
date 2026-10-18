import { getEventListeners } from "node:events";
import type { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import type { NotificationFailureDetail } from "../../providers/types.js";
import { createFakeCore } from "./base.js";
import { createFakeProviders, tickFakes } from "./index.js";

const clock = () => {
  let now = 0;
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const methods = [
  {
    provider: "wechat",
    method: "sendSubscribeMessage",
    input: { openid: "fake-openid", templateId: "fake-tpl", data: {} },
  },
  {
    provider: "sms",
    method: "sendActivationCode",
    input: { phone: "13800138000", code: "TEST1234" },
  },
  {
    provider: "sms",
    method: "sendSubscribeFallback",
    input: { phone: "13800138000", templateKey: "generic_todo", params: {} },
  },
  {
    provider: "sms",
    method: "sendOncallAlert",
    input: { phones: ["13800138000"], title: "假告警", content: "假内容" },
  },
  {
    provider: "wecom",
    method: "sendAppMessage",
    input: { toUser: "fake-user", title: "假待办", description: "假摘要" },
  },
  {
    provider: "mail",
    method: "send",
    input: { to: "test@example.invalid", subject: "假邮件", text: "假正文" },
  },
] as const;

function selected(fakes: ReturnType<typeof createFakeProviders>, item: (typeof methods)[number]) {
  const fake = fakes[item.provider];
  // 表驱动仅覆盖六个真实通知方法，生产接口签名另由typecheck验证。
  return {
    fake,
    send: (signal?: AbortSignal) =>
      Reflect.apply(
        Reflect.get(fake, item.method) as (...args: unknown[]) => Promise<unknown>,
        fake,
        [{ ...item.input, ...(signal === undefined ? {} : { signal }) }],
      ),
  };
}

function sentCount(fakes: ReturnType<typeof createFakeProviders>) {
  return (
    fakes.sms.sent.length +
    fakes.wechat.subscribeMessages.length +
    fakes.wecom.messages.length +
    fakes.mail.outbox.length
  );
}

describe("六个通知方法的取消与旧替身语义", () => {
  it.each(methods)("$provider.$method 预取消不执行action、监听和等待0", async (item) => {
    const fakes = createFakeProviders();
    const controller = new AbortController();
    controller.abort();
    const { fake, send } = selected(fakes, item);
    await expect(send(controller.signal)).resolves.toMatchObject({
      ok: false,
      notification: { acceptance: "not_accepted", code: "aborted" },
    });
    expect(sentCount(fakes)).toBe(0);
    expect(fake.pendingCalls()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it.each(methods)(
    "$provider.$method 已开始取消只能unknown，清held/listener且tick不能再次发",
    async (item) => {
      const c = clock();
      const fakes = createFakeProviders({ clock: c });
      const { fake, send } = selected(fakes, item);
      fake.delayNext(item.method as never, 10_000);
      const controller = new AbortController();
      const pending = send(controller.signal);
      // guard的async wrapper仍在同一调用栈进入真实action。
      expect(sentCount(fakes)).toBe(1);
      expect(fake.pendingCalls()).toBe(1);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      controller.abort();
      await expect(pending).resolves.toMatchObject({
        ok: false,
        notification: { acceptance: "unknown", code: "aborted" },
      });
      expect(fake.pendingCalls()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      c.advance(10_000);
      expect(tickFakes(fakes)).toBe(0);
      expect(sentCount(fakes)).toBe(1);
    },
  );

  it.each(methods)("$provider.$method 正常释放也回收listener、不伪providerMsgId", async (item) => {
    const c = clock();
    const fakes = createFakeProviders({ clock: c });
    const { fake, send } = selected(fakes, item);
    fake.delayNext(item.method as never, 5);
    const signal = new AbortController().signal;
    const pending = send(signal);
    c.advance(5);
    expect(fake.tick()).toBe(1);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(await pending).not.toHaveProperty("providerMsgId");
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(fake.pendingCalls()).toBe(0);
  });

  it("旧failNext不增加受理证明；显式失败保留unknown而非自动降为not_accepted", async () => {
    const fakes = createFakeProviders();
    fakes.sms.failNext("sendActivationCode");
    expect(await fakes.sms.sendActivationCode({ phone: "13800138000", code: "TEST1234" })).toEqual({
      ok: false,
      reason: "unavailable",
      message: "替身注入的失败",
    });
    fakes.sms.failNotificationNext("sendActivationCode", {
      acceptance: "unknown",
      code: "provider_rejected",
    });
    expect(
      await fakes.sms.sendActivationCode({ phone: "13800138000", code: "TEST1234" }),
    ).toMatchObject({ notification: { acceptance: "unknown", code: "provider_rejected" } });
    fakes.sms.failNotificationNext(
      "sendActivationCode",
      { acceptance: "not_accepted", code: "rate_limited" },
      { times: 2 },
    );
    for (let i = 0; i < 2; i++)
      expect(
        await fakes.sms.sendActivationCode({ phone: "13800138000", code: "TEST1234" }),
      ).toMatchObject({ notification: { acceptance: "not_accepted", code: "rate_limited" } });
    expect(fakes.sms.sent).toHaveLength(0);
  });

  it.each(methods)("$provider.$method 失败延迟取消不能增加未受理证明", async (item) => {
    for (const acceptance of ["unknown", "legacy", "not_accepted"] as const) {
      const c = clock();
      const fakes = createFakeProviders({ clock: c });
      const { fake, send } = selected(fakes, item);
      if (acceptance === "legacy") fake.failNext(item.method as never);
      else
        fake.failNotificationNext(item.method as never, {
          acceptance,
          code: acceptance === "unknown" ? "unknown_outcome" : "rate_limited",
        });
      fake.delayNext(item.method as never, 10_000);
      const controller = new AbortController();
      const pending = send(controller.signal);
      expect(fake.pendingCalls()).toBe(1);
      controller.abort();
      await expect(pending).resolves.toMatchObject({
        ok: false,
        notification: {
          acceptance: acceptance === "not_accepted" ? "not_accepted" : "unknown",
          code: "aborted",
        },
      });
      expect(fake.pendingCalls()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      c.advance(10_000);
      expect(tickFakes(fakes)).toBe(0);
      expect(sentCount(fakes)).toBe(0);
    }
  });

  it("仅通知方法允许注入、控制次数有界、reset沿旧语义", async () => {
    const fakes = createFakeProviders();
    expect(() =>
      fakes.wechat.failNotificationNext("code2Session" as "sendSubscribeMessage", {
        acceptance: "unknown",
        code: "unknown_outcome",
      }),
    ).toThrow("不是通知发送方法");
    for (const times of [0, -1, Infinity, 0.5, 1001])
      expect(() =>
        fakes.sms.failNotificationNext(
          "sendActivationCode",
          { acceptance: "unknown", code: "unknown_outcome" },
          { times },
        ),
      ).toThrow("通知失败注入次数不合法");
    expect(() =>
      fakes.sms.failNotificationNext("sendActivationCode", {
        acceptance: "yes",
        code: "constructor",
      } as unknown as NotificationFailureDetail),
    ).toThrow("通知失败分类不合法");
    expect(fakes.wechatPay).not.toHaveProperty("failNotificationNext");
    fakes.sms.failNotificationNext("sendActivationCode", {
      acceptance: "unknown",
      code: "unknown_outcome",
    });
    fakes.sms.resetCalls();
    await expect(
      fakes.sms.sendActivationCode({ phone: "13800138000", code: "TEST1234" }),
    ).resolves.toEqual({ ok: true, value: undefined });
  });

  it("action内同步触发取消/程序错误后的listener仍回收", async () => {
    const core = createFakeCore(clock(), ["send"]);
    const controller = new AbortController();
    await expect(
      core.runNotification(
        "send",
        {},
        () => {
          controller.abort();
          return { ok: true, value: undefined };
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({ notification: { acceptance: "unknown", code: "aborted" } });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const signal = new AbortController().signal;
    const boom = new Error("假程序错误");
    await expect(
      core.runNotification(
        "send",
        {},
        () => {
          throw boom;
        },
        signal,
      ),
    ).rejects.toBe(boom);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(core.control.pendingCalls()).toBe(0);
  });
});

describe("通知取消：实际本机HTTP资源", () => {
  it.each(["caller", "deadline"])("%s取消关闭自有在途socket，没有重试", async (mode) => {
    const { createServer } = await import("node:http");
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let closed!: Promise<void>;
    let requests = 0;
    const server = createServer((request) => {
      requests++;
      closed = new Promise<void>((resolve) => request.socket.once("close", resolve));
      enter();
      // 故意不发HTTP应答；取消必须真的关闭请求，不能靠清场掩盖。
    });
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("本机测试监听失败");
    const controller = new AbortController();
    const core = createFakeCore(clock(), ["send"]);
    let done!: () => void;
    const ioDone = new Promise<void>((resolve) => {
      done = resolve;
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = core.runNotification(
        "send",
        {},
        async () => {
          try {
            await fetch(`http://127.0.0.1:${address.port}/fake-notification`, {
              signal: controller.signal,
            });
            return { ok: true as const, value: undefined };
          } finally {
            done();
          }
        },
        controller.signal,
      );
      await entered;
      if (mode === "deadline")
        deadline = setTimeout(() => controller.abort("PRIVATE_DEADLINE_REASON"), 20);
      else controller.abort("PRIVATE_CANCEL_REASON");
      const result = await pending;
      expect(result).toMatchObject({ notification: { acceptance: "unknown", code: "aborted" } });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_");
      await Promise.race([
        Promise.all([closed!, ioDone]),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error("取消未及时关闭请求")), 2000);
        }),
      ]);
      expect(requests).toBe(1);
      expect(core.control.pendingCalls()).toBe(0);
    } finally {
      clearTimeout(deadline);
      clearTimeout(watchdog);
      controller.abort();
      const allClosed = [...sockets].map(
        (socket) => new Promise<void>((resolve) => socket.once("close", resolve)),
      );
      // 上述断言已在清场前证明在途socket关闭，这里仅回收undici闲置连接。
      server.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        ...allClosed,
      ]);
    }
    expect(sockets.size).toBe(0);
  });
});
