import { describe, expect, it, vi } from "vitest";
import type { Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";
import { createDeliveryGuard } from "@/stores/delivery";
import { createTaskWriteApi } from "./api";
import {
  copyPublishList,
  mergeTakedownPages,
  moreTakedowns,
  readTakedowns,
  takedownBody,
  takedownItems,
  visibleTakedowns,
  type TakedownCard,
  type TakedownPage,
} from "./lifecycle";
const card: TakedownCard = {
  takedownTaskId: "task-1",
  status: "pending_merchant",
  triggerKind: "expiry",
  basis: "delivered_unverified",
  orderNo: "LYX1",
  orderItemId: "item-1",
  orderId: "order-1",
  dramaTitle: "作品",
  episodeCount: 2,
  usageEndDate: "2026-11-01",
  dueDate: "2026-11-01",
  isOverdue: true,
  merchantMethod: null,
  merchantConfirmedAt: null,
  checkedAt: null,
  stillOnlineCount: 0,
  escalatedAt: null,
  posterUrl: null,
  channelAccount: {
    channelAccountId: "account-1",
    platform: "douyin",
    accountName: "账号",
    accountUid: "uid",
    status: "available",
  },
  allowedMethods: ["delete", "private", "not_published"],
  actions: ["confirm"],
};
const page = (items: TakedownCard[] = [card], nextCursor: string | null = null): TakedownPage => ({
  items,
  nextCursor,
  hasMore: !!nextCursor,
});
describe("下架与发布任务独立资源", () => {
  it("列表/汇总使用同一订单筛选，确认仅发 method 与原意图键，清单使用真实订单项", async () => {
    const send = vi.fn(async () => null) as unknown as RequestLayer["request"],
      api = createTaskWriteApi(send);
    await api.summary({ orderId: "order 1", orderItemId: "item-1" });
    await api.takedowns({ orderId: "order 1", tab: "pending", limit: 20 });
    await api.takedownSummary("order 1");
    await api.confirmTakedown("task-1", { method: "private" }, "intent-1");
    await api.publishList("item-1");
    expect(vi.mocked(send).mock.calls).toEqual([
      ["/m/launch-tasks/summary?orderId=order%201&orderItemId=item-1"],
      ["/m/takedown-tasks?orderId=order%201&tab=pending&limit=20"],
      ["/m/takedown-tasks/summary?orderId=order%201"],
      [
        "/m/takedown-tasks/task-1/confirm",
        { method: "POST", data: { method: "private" }, idempotencyKey: "intent-1" },
      ],
      ["/m/order-items/item-1/publish-list"],
    ]);
  });
  it("一侧失败保留另一侧列表和官方计数，不把当前页拼成汇总", async () => {
    const api = {
      takedowns: vi.fn(async ({ tab }: { tab?: string }) => {
        if (tab === "pending") throw new Error("待下架读取失败");
        return page([{ ...card, status: "checked" }]);
      }),
      takedownSummary: vi.fn(async () => ({
        pending: 45,
        done: 81,
        overdue: 3,
        nextTakedown: null,
      })),
    };
    const state = await readTakedowns(api, "all", "order-1");
    expect(state.pending.error).toBe("待下架读取失败");
    expect(state.done.page?.items).toHaveLength(1);
    expect(state.summary?.done).toBe(81);
    expect(api.takedownSummary).toHaveBeenCalledWith("order-1");
    expect(api.takedowns).toHaveBeenCalledWith({ tab: "done", orderId: "order-1", limit: 20 });
  });
  it("平铺分页按任务 ID 更新去重，与 launch 分组和另一状态游标无关；重复游标停止请求", async () => {
    const next = page(
      [
        { ...card, stillOnlineCount: 2 },
        { ...card, takedownTaskId: "task-2" },
      ],
      "cursor-b",
    );
    expect(mergeTakedownPages(page([card], "cursor-a"), next).items).toHaveLength(2);
    const api = { takedowns: vi.fn(async () => next) },
      initial = { page: page([card], "cursor-a"), error: null, cursors: [] };
    const merged = await moreTakedowns(api, initial, "pending", "order-1");
    expect(merged.page?.items[0]?.stillOnlineCount).toBe(2);
    expect(merged.cursors).toEqual(["cursor-a"]);
    const repeated = await moreTakedowns(
      api,
      { ...merged, cursors: ["cursor-a", "cursor-b"] },
      "pending",
    );
    expect(repeated.error).toContain("分页已变化");
    expect(api.takedowns).toHaveBeenCalledTimes(1);
  });
  it("未发布方式仅允许 delivered_unverified，actions/method 变化强制重新选择", () => {
    expect(takedownBody(card, "not_published")).toEqual({ method: "not_published" });
    expect(takedownBody({ ...card, basis: "live" }, "not_published")).toBeNull();
    expect(takedownBody({ ...card, allowedMethods: ["delete"] }, "private")).toBeNull();
    expect(takedownBody({ ...card, actions: [] }, "delete")).toBeNull();
  });
  it("全部视图中跨页签状态迁移的同一任务只显示一次，保留已完成事实", () => {
    const state = {
      pending: { page: page(), error: null, cursors: [] },
      done: { page: page([{ ...card, status: "checked" }]), error: null, cursors: [] },
      summary: null,
      summaryError: null,
    };
    expect(takedownItems(state)).toHaveLength(1);
    expect(takedownItems(state)[0]?.status).toBe("checked");
    expect(visibleTakedowns(state, "pending")).toEqual([]);
    expect(visibleTakedowns(state, "done")).toHaveLength(1);
  });
  it("下架深链通过当前范围公开列表继续分页，未切到外店 GET", async () => {
    const api = {
      takedowns: vi.fn(async (query: { tab?: string; cursor?: string }) =>
        query.tab === "done"
          ? page([])
          : query.cursor
            ? page([{ ...card, takedownTaskId: "target" }])
            : page([card], "next"),
      ),
      takedownSummary: vi.fn(async () => ({ pending: 2, done: 0, overdue: 1, nextTakedown: null })),
    };
    const result = await readTakedowns(api, "all", "order-1", "target");
    expect(result.pending.page?.items.map((item) => item.takedownTaskId)).toEqual([
      "task-1",
      "target",
    ]);
    expect(api.takedowns).toHaveBeenCalledWith({
      tab: "pending",
      orderId: "order-1",
      limit: 20,
      cursor: "next",
    });
    expect(result.pending.cursors).toEqual(["next"]);
  });
  it("复制服务端原文；缺失文本、剪贴板拒绝和跨店迟到均不报告成功", async () => {
    const text = "合集：服务端原文\n第 1 集：保留空格  ",
      copy = vi.fn(async () => undefined);
    const api = {
      publishList: vi.fn(async () => ({ text }) as Data<"m.orderItem.publishList.get">),
    };
    expect(await copyPublishList(api, "item-1", () => true, copy)).toBe(true);
    expect(copy).toHaveBeenCalledWith(text);
    await expect(
      copyPublishList(
        api,
        "item-1",
        () => true,
        async () => {
          throw new Error("剪贴板拒绝");
        },
      ),
    ).rejects.toThrow("剪贴板拒绝");
    copy.mockClear();
    expect(await copyPublishList(api, "item-1", () => false, copy)).toBe(false);
    expect(copy).not.toHaveBeenCalled();
    api.publishList.mockResolvedValue({ text: null } as Data<"m.orderItem.publishList.get">);
    await expect(copyPublishList(api, "item-1", () => true, copy)).rejects.toThrow(
      "暂无可复制文本",
    );
  });
  it("角色/门店变化废弃订阅续行，同内容重试同键，方法重选换键", () => {
    let identity = "store:owner",
      serial = 0;
    const guard = createDeliveryGuard(
        () => identity,
        () => `k${++serial}`,
      ),
      current = guard.begin()!;
    expect(guard.begin()).toBeNull();
    const value = { id: card.takedownTaskId, method: "delete" };
    expect(guard.intent("confirm", value)).toBe(guard.intent("confirm", value));
    expect(guard.intent("confirm", { ...value, method: "private" })).not.toBe(
      guard.intent("confirm", value),
    );
    identity = "store:clerk";
    expect(current()).toBe(false);
    guard.finish(current);
  });
});
