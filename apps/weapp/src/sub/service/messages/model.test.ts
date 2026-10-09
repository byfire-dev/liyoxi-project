import { describe, expect, it, vi } from "vitest";
import type { MessagesApi, Message, Summary } from "./api";
import { createMessagesController } from "./model";

const message = (id = "one"): Message => ({
  messageId: id,
  category: "order",
  title: "订单消息",
  body: "订单已开始",
  ctaText: "查看",
  link: { route: "messages.list", params: {} },
  storeId: null,
  isRead: false,
  readAt: null,
  createdAt: "2026-10-08T00:00:00Z",
  createdDate: "2026-10-08",
});
const summary = (total = 2): Summary => ({
  total,
  byTab: (
    ["all", "order", "delivery", "launch", "plan_points", "review", "store", "service"] as const
  ).map((tab) => ({ tab, unreadCount: total })),
  byStore: [],
});
function setup() {
  let scope = "owner",
    n = 0;
  const api: MessagesApi = {
    list: vi.fn(async () => ({ items: [message()], nextCursor: null, hasMore: false })),
    summary: vi.fn(async () => summary()),
    settings: vi.fn(async () => ({ items: [], cooldownDays: 7, maxPerAsk: 3 })),
    agreement: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    read: vi.fn(async (messageId) => ({ messageId, readAt: "2026-10-08T01:00:00Z" })),
    batchRead: vi.fn(async () => ({ markedCount: 1, summary: summary(1) })),
  };
  const publish = vi.fn();
  const controller = createMessagesController({
    api,
    scope: () => scope,
    key: () => `key-${++n}`,
    publish,
  });
  return {
    api,
    controller,
    publish,
    changeScope: () => {
      scope = "clerk";
    },
  };
}
describe("消息意图与上下文", () => {
  it("在途单读确认后，迟到刷新快照不能覆盖服务端已读时刻", async () => {
    const { api, controller } = setup();
    await controller.refresh();
    let finishRead!: (value: Awaited<ReturnType<MessagesApi["read"]>>) => void;
    let finishList!: (value: Awaited<ReturnType<MessagesApi["list"]>>) => void;
    vi.mocked(api.read).mockImplementationOnce(
      () =>
        new Promise((done) => {
          finishRead = done;
        }),
    );
    const read = controller.read(message());
    vi.mocked(api.list).mockImplementationOnce(
      () =>
        new Promise((done) => {
          finishList = done;
        }),
    );
    const refresh = controller.refresh();
    finishRead({ messageId: "one", readAt: "2026-10-08T01:00:00Z" });
    await read;
    finishList({ items: [message()], nextCursor: null, hasMore: false });
    await refresh;
    expect(controller.snapshot().items[0]).toMatchObject({
      isRead: true,
      readAt: "2026-10-08T01:00:00Z",
    });
  });
  it("默认 all/20 页，追加去重，hasMore=false 不发请求", async () => {
    const { api, controller } = setup();
    vi.mocked(api.list)
      .mockResolvedValueOnce({ items: [message()], nextCursor: "opaque+/=", hasMore: true })
      .mockResolvedValueOnce({
        items: [message(), message("two")],
        nextCursor: null,
        hasMore: false,
      });
    await controller.refresh();
    await controller.more();
    await controller.more();
    expect(api.list).toHaveBeenNthCalledWith(1, "all", null);
    expect(api.list).toHaveBeenNthCalledWith(2, "all", "opaque+/=");
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().items.map((item) => item.messageId)).toEqual(["one", "two"]);
  });
  it("切换上下文丢弃旧成功与旧错误，不发布旧角标", async () => {
    const { api, controller, changeScope, publish } = setup();
    let resolve!: (value: Awaited<ReturnType<MessagesApi["list"]>>) => void;
    vi.mocked(api.list).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = controller.refresh();
    changeScope();
    resolve({ items: [message()], nextCursor: null, hasMore: false });
    await pending;
    expect(controller.snapshot().items).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    const other = setup();
    let reject!: (error: Error) => void;
    vi.mocked(other.api.list).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const failure = other.controller.refresh();
    other.changeScope();
    reject(new Error("旧错误"));
    await failure;
    expect(other.controller.snapshot().error).toBeNull();
  });
  it("单读失败不改本地已读或角标，再点击复用同一个键", async () => {
    const { api, controller, publish } = setup();
    await controller.refresh();
    publish.mockClear();
    vi.mocked(api.read).mockRejectedValueOnce(new Error("网络异常"));
    expect(await controller.read(message())).toBe(false);
    expect(controller.snapshot().items[0]?.isRead).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(await controller.read(message())).toBe(true);
    expect(vi.mocked(api.read).mock.calls.map((call) => call[1])).toEqual(["key-1", "key-1"]);
    expect(controller.snapshot().items[0]?.readAt).toBe("2026-10-08T01:00:00Z");
  });
  it("全读失败重试保持首次顶部边界与键，新到消息不被标读", async () => {
    const { api, controller } = setup();
    await controller.refresh();
    vi.mocked(api.batchRead).mockRejectedValueOnce(new Error("断线"));
    await controller.batchRead();
    vi.mocked(api.list).mockResolvedValueOnce({
      items: [message("new"), message()],
      nextCursor: null,
      hasMore: false,
    });
    await controller.refresh();
    await controller.batchRead();
    expect(vi.mocked(api.batchRead).mock.calls).toEqual([
      [{ tab: "all", upToMessageId: "one" }, "key-1"],
      [{ tab: "all", upToMessageId: "one" }, "key-1"],
    ]);
    expect(controller.snapshot().items[0]?.isRead).toBe(false);
  });
  it("快速分类切换和 dispose 不泄露旧列表、设置或导航结果", async () => {
    const { api, controller } = setup();
    let complete!: (value: Awaited<ReturnType<MessagesApi["list"]>>) => void;
    vi.mocked(api.list).mockImplementationOnce(
      () =>
        new Promise((done) => {
          complete = done;
        }),
    );
    const pending = controller.refresh();
    await controller.select("service");
    complete({ items: [message("old")], nextCursor: null, hasMore: false });
    await pending;
    expect(controller.snapshot().items.map((item) => item.messageId)).toEqual(["one"]);
    controller.dispose();
    expect(await controller.read(message())).toBe(false);
  });
});
