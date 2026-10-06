import { describe, expect, it, vi } from "vitest";
import { ApiError, type RequestLayer, type RequestOptions } from "@/lib/request";
import {
  canSubmitOrder,
  createOrderIntent,
  createOrderLifetime,
  mergeOrders,
  quoteRefreshMessage,
} from "@/stores/order";
import { orderQuote, orderCard, CHANNEL_ID, AGREEMENT_ID } from "../../../../shots/order-fixtures";
vi.mock("@/lib/runtime", () => ({ request: vi.fn() }));
import { createOrderApi } from "./api";
describe("确认订购与订单读取", () => {
  it("同一意图网络重试同key；账号、重点或新报价改变后新key", () => {
    let seq = 0;
    const intent = createOrderIntent(() => `order:${++seq}`);
    expect(intent.current()).toBe("order:1");
    expect(intent.current()).toBe("order:1");
    for (const change of ["account", "focus", "quote"]) {
      expect(change).toBeTruthy();
      const before = intent.current();
      intent.changed();
      expect(intent.current()).not.toBe(before);
      expect(intent.current()).toBe(`order:${seq}`);
    }
    expect(seq).toBe(4);
  });
  it("服务端阻断、未同意当前协议与不可选账号均不能提交", () => {
    expect(canSubmitOrder(orderQuote, [CHANNEL_ID], ["product"], AGREEMENT_ID)).toBe(true);
    for (const code of ["POINTS_INSUFFICIENT", "STORE_NOT_QUALIFIED", "ORDER_ACCOUNT_INVALID"])
      expect(
        canSubmitOrder(
          { ...orderQuote, blockers: [{ code, message: "服务端阻断" }] },
          [CHANNEL_ID],
          ["product"],
          AGREEMENT_ID,
        ),
      ).toBe(false);
    expect(canSubmitOrder(orderQuote, [CHANNEL_ID], ["product"], "old-version")).toBe(false);
    expect(canSubmitOrder(orderQuote, [], ["product"], AGREEMENT_ID)).toBe(false);
    expect(canSubmitOrder(orderQuote, ["foreign"], ["product"], AGREEMENT_ID)).toBe(false);
    expect(
      canSubmitOrder(
        {
          ...orderQuote,
          channelAccounts: orderQuote.channelAccounts.map((a) => ({ ...a, isSelectable: false })),
        },
        [CHANNEL_ID],
        ["product"],
        AGREEMENT_ID,
      ),
    ).toBe(false);
    expect(canSubmitOrder(orderQuote, [CHANNEL_ID, CHANNEL_ID], ["product"], AGREEMENT_ID)).toBe(
      false,
    );
    expect(canSubmitOrder(orderQuote, [CHANNEL_ID], [], AGREEMENT_ID)).toBe(false);
  });
  it("QUOTE_CHANGED按符号刷新，code或中文文案不用于判定；协议更新同样需重新勾选", () => {
    const changed = new ApiError({
      error: "QUOTE_CHANGED",
      message: "unrelated",
      code: 1,
      status: 409,
      requestId: "test",
    });
    expect(quoteRefreshMessage(changed)).toBe("报价已更新，请重新核对并同意协议");
    expect(
      quoteRefreshMessage(
        new ApiError({
          error: "NETWORK_ERROR",
          message: "QUOTE_CHANGED",
          code: changed.code,
          status: 0,
          requestId: "test",
        }),
      ),
    ).toBeNull();
    expect(
      quoteRefreshMessage(
        new ApiError({
          error: "AGREEMENT_VERSION_STALE",
          message: "更新",
          status: 409,
          requestId: "test",
        }),
      ),
    ).toBe("协议已更新，请重新阅读并同意");
  });
  it("cursor拼接去重、保留前页快照并使用新页终止游标", () => {
    const first = { items: [orderCard], hasMore: true, nextCursor: "next" };
    const other = { ...orderCard, orderId: "other", orderNo: "other" };
    const next = {
      items: [{ ...orderCard, totalChargePoints: 999 }, other, other],
      hasMore: false,
      nextCursor: null,
    };
    const merged = mergeOrders(first, next);
    expect(merged.items).toEqual([orderCard, other]);
    expect(merged.hasMore).toBe(false);
    expect(merged.nextCursor).toBeNull();
    expect(mergeOrders(merged, next).items).toEqual(merged.items);
  });
  it("create发送当前服务端expect和原key；分页只传服务端cursor", async () => {
    const calls: [string, RequestOptions | undefined][] = [];
    const send: RequestLayer["request"] = async <T>(path: string, options?: RequestOptions) => {
      calls.push([path, options]);
      return null as T;
    };
    const api = createOrderApi(send),
      body = {
        dramaIds: orderQuote.expect.items.map((i) => i.dramaId),
        isTopModel: false,
        channelAccountIds: [CHANNEL_ID],
        focusCodes: ["product"],
        agreementVersionId: AGREEMENT_ID,
        expect: orderQuote.expect,
      };
    await api.create(body, "same-key");
    await api.create(body, "same-key");
    await api.list("producing", "opaque:cursor");
    expect(calls[0]).toEqual([
      "/m/orders",
      { method: "POST", data: body, idempotencyKey: "same-key" },
    ]);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]?.[0]).toBe("/m/orders?tab=producing&limit=20&cursor=opaque%3Acursor");
    expect(body).not.toHaveProperty("adIds");
    expect(body).not.toHaveProperty("referenceStoreAssetIds");
  });
  it("可用账号消耗全部游标，不遗漏第二页账号且合并去重", async () => {
    const seen: string[] = [];
    const send: RequestLayer["request"] = async <T>(path: string) => {
      seen.push(path);
      return (
        seen.length === 1
          ? { items: [{ channelAccountId: "a" }], hasMore: true, nextCursor: "next" }
          : {
              items: [{ channelAccountId: "a" }, { channelAccountId: "b" }],
              hasMore: false,
              nextCursor: null,
            }
      ) as T;
    };
    const data = await createOrderApi(send).accounts();
    expect(data.items.map((i) => i.channelAccountId)).toEqual(["a", "b"]);
    expect(seen[1]).toBe("/m/channel-accounts?status=available&limit=50&cursor=next");
  });
  it("旧读取、卸载、contextRev变化与退出均废弃晚到的成功和错误", () => {
    let scope = { storeId: "a", contextRev: 1, token: "fake" };
    const life = createOrderLifetime(() => scope);
    life.mount();
    const old = life.read(),
      mutation = life.capture(true);
    life.read();
    expect(old()).toBe(false);
    expect(mutation()).toBe(false);
    const current = life.capture();
    scope = { ...scope, contextRev: 2 };
    expect(current()).toBe(false);
    const after = life.capture();
    life.dispose();
    expect(after()).toBe(false);
    life.mount();
    const signed = life.capture();
    scope = { ...scope, token: "" };
    expect(signed()).toBe(false);
  });
});
