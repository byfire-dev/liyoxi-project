import { describe, expect, it, vi } from "vitest";
import { messageScope } from "@/stores/messages-scope";
import { makeMe } from "../../../../shots/account-fixtures";
import { createSubscribe } from "@/lib/subscribe";
import { createClientReporting } from "@/lib/client-reporting";
import { createRequestLayer } from "@/lib/request";
import { createPurchaseApi } from "../../billing/plan-pick/api";
import { billingPayment } from "../../../../shots/billing-fixtures";
import { createMessagesApi, type Settings } from "./api";
import { createMessagesController } from "./model";
import { settingsSubscription } from "./model";
import { messageTarget } from "./target";

describe("消息上下文和已落地目标", () => {
  it("角色/成员范围/登录用户/token/contextRev 的任一变化都使旧缓存失效", () => {
    const input = { token: "fake", storeId: null, contextRev: 1, me: makeMe() },
      key = messageScope(input);
    expect(messageScope({ ...input, me: makeMe(true) })).not.toBe(key);
    expect(messageScope({ ...input, me: { ...input.me, memberships: [] } })).not.toBe(key);
    expect(
      messageScope({
        ...input,
        me: { ...input.me, user: { ...input.me.user, merchantUserId: "other" } },
      }),
    ).not.toBe(key);
    expect(messageScope({ ...input, token: "new" })).not.toBe(key);
    expect(messageScope({ ...input, contextRev: 2 })).not.toBe(key);
    expect(messageScope({ ...input, storeId: "another" })).not.toBe(key);
  });
  it("跨店与店员 owner 目标受控；未来目标不伪造 URL；参数只取固定键", () => {
    expect(
      messageTarget(
        { route: "order.detail", params: { orderId: "order", storeId: "store" } },
        { storeId: "other", owner: true },
      ),
    ).toHaveProperty("notice");
    expect(
      messageTarget({ route: "wallet.home", params: {} }, { storeId: "store", owner: false }),
    ).toHaveProperty("notice");
    expect(
      messageTarget({ route: "points.ledger", params: {} }, { storeId: null, owner: true }),
    ).toHaveProperty("notice");
    expect(
      messageTarget(
        { route: "ticket.detail", params: { serviceTicketId: "ticket", storeId: "store" } },
        { storeId: "store", owner: true },
      ),
    ).toHaveProperty("notice");
    expect(
      messageTarget(
        { route: "payment.result", params: { paymentOrderId: "a/b" } },
        { storeId: "store", owner: true },
      ),
    ).toEqual({ url: "/sub/order/result/index?type=payment&paymentOrderId=a%2Fb", tab: false });
    expect(
      messageTarget(
        { route: "agreement.view", params: { key: "privacy" } },
        { storeId: null, owner: false },
      ),
    ).toEqual({ agreementKey: "privacy" });
  });
  it("transfer.rejected 的 payment.detail 进入已有付款页，资源 GET仍带真实授权", async () => {
    const id = "00000000-0000-4000-8000-000000000077";
    expect(
      messageTarget(
        { route: "payment.detail", params: { paymentOrderId: id } },
        { storeId: null, owner: true },
      ),
    ).toEqual({ url: `/sub/order/result/index?type=payment&paymentOrderId=${id}`, tab: false });
    expect(
      messageTarget(
        { route: "payment.detail", params: { paymentOrderId: id } },
        { storeId: null, owner: false },
      ),
    ).toHaveProperty("notice");
    expect(
      messageTarget(
        { route: "payment.detail", params: { paymentOrderId: "a/b" } },
        { storeId: null, owner: true },
      ),
    ).toEqual({ url: "/sub/order/result/index?type=payment&paymentOrderId=a%2Fb", tab: false });
    const send = vi.fn(async () => ({
      statusCode: 200,
      header: {},
      data: { code: 0, data: billingPayment("payment-rejected") },
    }));
    const layer = createRequestLayer({
      baseUrl: "https://fictional.payment.test",
      send,
      getToken: () => "fictional-token",
      getStoreId: () => null,
      clock: { now: () => 0, sleep: async () => {} },
      uuid: () => "request-id",
      client: () => ({ platform: "ios", version: "0.1.0", envVersion: "trial" }),
    });
    expect(await createPurchaseApi(layer.request).detail(id)).toMatchObject({
      transferState: "proof_rejected",
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://fictional.payment.test/api/v1/m/payment-orders/${id}`,
        method: "GET",
        header: expect.objectContaining({ Authorization: "Bearer fictional-token" }),
      }),
    );
  });
});
const offSettings: Settings = {
  items: [
    {
      slotKey: "order_progress",
      title: "订单进度",
      sceneNames: ["订单开始"],
      tmplId: "T1",
      state: "off",
      estRemaining: 0,
      lastAcceptAt: null,
    },
  ],
  cooldownDays: 7,
  maxPerAsk: 3,
};
const confirmedSettings: Settings = {
  ...offSettings,
  items: offSettings.items.map((item) => ({
    ...item,
    state: "on" as const,
    estRemaining: 1,
    lastAcceptAt: "2026-10-09T02:00:00Z",
  })),
};
function slowReportSettings(delayFirstGet = false) {
  let finishReport!: () => void, failReport!: (error: Error) => void;
  const reported = new Promise<null>((resolve, reject) => {
    finishReport = () => {
      server = confirmedSettings;
      resolve(null);
    };
    failReport = reject;
  });
  let finishOldGet!: () => void;
  const oldGet = new Promise<Settings>((resolve) => {
    finishOldGet = () => resolve(offSettings);
  });
  let server = offSettings,
    reads = 0,
    scope = "current";
  const request = async <T>(path: string): Promise<T> => {
    if (path === "/m/subscribe-results") return reported as Promise<T>;
    if (path === "/m/notify-settings") {
      reads++;
      return (delayFirstGet && reads === 1 ? oldGet : server) as T;
    }
    throw new Error("Unexpected test request");
  };
  const controller = createMessagesController({
    api: createMessagesApi(request),
    scope: () => scope,
    key: () => "read-key",
    publish: () => {},
  });
  const client = createClientReporting(request);
  const requestSubscribe = vi.fn(async () => ({ T1: "accept" }));
  const afterReport = vi.fn();
  const subscribe = createSubscribe({
    requestSubscribe,
    getPlan: () => ({
      enabled: true,
      maxPerAsk: 3,
      cooldownDays: 7,
      plan: [{ point: "notify_settings", slots: [{ slotKey: "order_progress", tmplId: "T1" }] }],
    }),
    clock: { now: () => 0, sleep: async () => {} },
    uuid: () => "report-id",
    storage: { get: () => null, set: () => {}, remove: () => {} },
    report: () => client.reportSubscribeResult,
    afterReport,
  });
  const click = settingsSubscription(
    subscribe.withSubscribe,
    controller.settings,
    controller.settings,
  );
  return {
    controller,
    request,
    requestSubscribe,
    afterReport,
    click,
    finishReport,
    failReport,
    finishOldGet,
    reads: () => reads,
    changeScope: () => {
      scope = "other";
    },
  };
}

describe("真实订阅封装点击接线", () => {
  it("同步请求 bootstrap 模板，accept/reject/ban/filter 原样上报，页面只在回调后刷新", async () => {
    const sent: { path: string; data: unknown; key?: string }[] = [],
      refresh = vi.fn(async () => {});
    const client = createClientReporting(
      async <T>(path: string, options?: { data?: unknown; idempotencyKey?: string }) => {
        sent.push({ path, data: options?.data, key: options?.idempotencyKey });
        return null as T;
      },
    );
    const requestSubscribe = vi.fn(async () => ({
      T1: "accept",
      T2: "reject",
      T3: "ban",
      T4: "filter",
    }));
    const subscribe = createSubscribe({
      requestSubscribe,
      getPlan: () => ({
        enabled: true,
        maxPerAsk: 4,
        cooldownDays: 7,
        plan: [
          {
            point: "notify_settings",
            slots: [1, 2, 3, 4].map((n) => ({ slotKey: `slot${n}`, tmplId: `T${n}` })),
          },
        ],
      }),
      clock: { now: () => 0, sleep: async () => {} },
      uuid: () => "report-id",
      storage: { get: () => null, set: () => {}, remove: () => {} },
      report: () => client.reportSubscribeResult,
    });
    const click = settingsSubscription(subscribe.withSubscribe, refresh);
    expect(requestSubscribe).not.toHaveBeenCalled();
    click();
    expect(requestSubscribe).toHaveBeenCalledWith(["T1", "T2", "T3", "T4"]);
    expect(refresh).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(sent).toEqual([
      {
        path: "/m/subscribe-results",
        key: "subscribeReport:report-id",
        data: {
          point: "notify_settings",
          reportId: "report-id",
          results: [
            { tmplId: "T1", result: "accept" },
            { tmplId: "T2", result: "reject" },
            { tmplId: "T3", result: "ban" },
            { tmplId: "T4", result: "filter" },
          ],
        },
      },
    ]);
  });
  it("未配置模板/关闭能力仍刷新设置，不创建授权结果", async () => {
    const requestSubscribe = vi.fn(),
      report = vi.fn(),
      refresh = vi.fn(async () => {});
    const subscribe = createSubscribe({
      requestSubscribe,
      getPlan: () => ({ enabled: false, plan: null, maxPerAsk: 3, cooldownDays: 7 }),
      clock: { now: () => 0, sleep: async () => {} },
      uuid: () => "report-id",
      storage: { get: () => null, set: () => {}, remove: () => {} },
      report: () => report,
    });
    settingsSubscription(subscribe.withSubscribe, refresh)();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(requestSubscribe).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });
  it("平台先返回accept，慢报告提交后当前Sheet再次GET真实quota", async () => {
    const env = slowReportSettings();
    env.click();
    expect(env.requestSubscribe).toHaveBeenCalledExactlyOnceWith(["T1"]);
    await vi.waitFor(() => expect(env.controller.snapshot().settings?.items[0]?.state).toBe("off"));
    expect(env.afterReport).not.toHaveBeenCalled();
    env.finishReport();
    await vi.waitFor(() => expect(env.afterReport).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(env.controller.snapshot().settings?.items[0]).toMatchObject({
        state: "on",
        estRemaining: 1,
      }),
    );
    expect(env.reads()).toBe(2);
    env.controller.dispose();
  });
  it("报告完成穿过旧GET loading，迟到off不能覆盖fresh confirmed quota", async () => {
    const env = slowReportSettings(true);
    env.click();
    await vi.waitFor(() => expect(env.reads()).toBe(1));
    expect(env.controller.snapshot().settingsLoading).toBe(true);
    env.finishReport();
    await vi.waitFor(() => expect(env.afterReport).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(env.controller.snapshot().settings?.items[0]).toMatchObject({
        state: "on",
        estRemaining: 1,
      }),
    );
    env.finishOldGet();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(env.controller.snapshot().settings?.items[0]).toMatchObject({
      state: "on",
      estRemaining: 1,
    });
    expect(env.reads()).toBe(2);
    env.controller.dispose();
  });
  it.each(["failure", "scope"] as const)("报告%s不乐观额度或旧scope回写", async (kind) => {
    const env = slowReportSettings();
    env.click();
    await vi.waitFor(() => expect(env.controller.snapshot().settings?.items[0]?.state).toBe("off"));
    const changed = vi.fn();
    const unsubscribe = env.controller.subscribe(changed);
    if (kind === "failure") env.failReport(new Error("report failed"));
    else {
      env.changeScope();
      env.finishReport();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(env.controller.snapshot().settings?.items[0]).toMatchObject({
      state: "off",
      estRemaining: 0,
    });
    expect(changed).not.toHaveBeenCalled();
    expect(env.reads()).toBe(1);
    if (kind === "failure") expect(env.afterReport).not.toHaveBeenCalled();
    unsubscribe();
    env.controller.dispose();
  });
});
