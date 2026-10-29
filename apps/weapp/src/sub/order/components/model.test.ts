import { describe, it, expect, vi } from "vitest";
import { ApiError, type RequestLayer } from "@/lib/request";
import { createDeliveryGuard } from "@/stores/delivery";
import { deliveryError } from "./model";
import { changeBody } from "../plan/model";
import { sampleConfirmation } from "../sample/model";
import { submitBody, mergeTaskPages } from "../../publish/tasks/model";
import { readLaunchRecord } from "../launch-record/model";
import { createDeliveryApi } from "./delivery-api";
import { plan, sample, tasks, task } from "../../../../shots/delivery-fixtures";
import { orderDetail } from "../../../../shots/order-fixtures";
import { deliveryEntry, deliveryItemEntries } from "./navigation";
describe("交付页面上下文与意图", () => {
  it("同步互斥先于任何异步，并拒绝迟到结果/错误", () => {
    let scope = "token:store:1";
    const key = vi.fn(() => "key");
    const g = createDeliveryGuard(() => scope, key);
    const old = g.nextRead();
    const operation = g.begin();
    expect(operation).not.toBeNull();
    expect(g.begin()).toBeNull();
    g.finish(operation!);
    expect(g.begin()).not.toBeNull();
    scope = "token:store2:2";
    expect(old()).toBe(false);
    const read = g.nextRead();
    g.invalidate();
    expect(read()).toBe(false);
    const mutation = g.capture();
    g.dispose();
    expect(mutation()).toBe(false);
  });
  it("同一版本和内容重试同键，新版本或内容新键", () => {
    const key = vi.fn(() => String(Math.random()));
    const g = createDeliveryGuard(() => "scope", key);
    const body = { id: "p", version: 2 };
    expect(g.intent("planConfirm", body)).toBe(g.intent("planConfirm", body));
    g.intent("planConfirm", { ...body, version: 3 });
    g.intent("planChange", { note: "第一次" });
    g.intent("planChange", { note: "第二次" });
    expect(key).toHaveBeenCalledTimes(4);
  });
});
describe("已合DTO与页面提交", () => {
  it("订单入口只用本单真实 id，多剧必须选项且拒绝未知项", () => {
    expect(deliveryEntry(orderDetail, "view-plan")).toBe(
      `/sub/order/plan/index?deliveryPlanId=${orderDetail.deliveryPlan!.deliveryPlanId}`,
    );
    expect(deliveryEntry(orderDetail, "view-launch")).toBe(
      `/sub/publish/tasks/index?orderId=${orderDetail.orderId}`,
    );
    const second = { ...orderDetail.items[0]!, orderItemId: "second-item" };
    const multi = { ...orderDetail, items: [...orderDetail.items, second] };
    expect(deliveryEntry(multi, "view-sample")).toBeNull();
    expect(deliveryEntry(multi, "view-delivery", "second-item")).toBe(
      "/sub/publish/downloads/index?orderItemId=second-item",
    );
    expect(deliveryEntry(multi, "view-launch-record", "outside-item")).toBeNull();
    expect(deliveryEntry({ ...orderDetail, deliveryPlan: null }, "view-plan")).toBeNull();
  });
  it("只读剧目入口随真实里程碑开放，店员与取消项均不开放", () => {
    const item = orderDetail.items[0]!;
    expect(deliveryItemEntries(item, true)).toEqual(["view-sample"]);
    const delivered = {
      ...item,
      timeline: [...item.timeline, { key: "delivered", state: "done", at: null } as const],
    };
    expect(deliveryItemEntries(delivered, true)).toEqual([
      "view-sample",
      "view-delivery",
      "view-launch",
    ]);
    expect(deliveryItemEntries({ ...delivered, liveEpisodeCount: 1 }, true)).toContain(
      "view-launch-record",
    );
    expect(deliveryItemEntries(delivered, false)).toEqual([]);
    for (const phase of ["pending_start", "cancelled", "refunded", "terminated"])
      expect(deliveryItemEntries({ ...delivered, phase }, true)).toEqual([]);
  });
  const makeApi = () => {
    const send = vi.fn(async () => null) as unknown as RequestLayer["request"];
    return { api: createDeliveryApi(send), send: vi.mocked(send) };
  };
  it("确认方案发送看到的版本；修改说明trim且1–6项不重复", async () => {
    const { api, send } = makeApi();
    await api.confirmPlan(plan.deliveryPlanId, plan.version!.versionNo, "intent");
    expect(send).toHaveBeenCalledWith(expect.stringContaining("/confirm"), {
      method: "POST",
      data: { versionNo: 2 },
      idempotencyKey: "intent",
    });
    expect(changeBody(["account"], "  调整账号  ")).toEqual({
      kinds: ["account"],
      note: "调整账号",
    });
    expect(() => changeBody([], "note")).toThrow();
    expect(() => changeBody(["ad", "ad"], "note")).toThrow();
    expect(() => changeBody(["ad"], " ")).toThrow();
  });
  it("样片只提交weapp并强制勾选；拒绝旧相册渠道与关闭开关", () => {
    expect(() => sampleConfirmation(sample, false)).toThrow("我已查看");
    expect(() => sampleConfirmation(sample, true, false)).toThrow("联系服务经理");
    expect(() => sampleConfirmation({ ...sample, confirmableVia: ["album"] }, true)).toThrow();
    expect(sampleConfirmation(sample, true)).toEqual({
      versionNo: 2,
      viewedVia: "weapp",
      hasViewed: true,
    });
  });
  it("合集与逐集请求体严格分支，拒重复集号", () => {
    const base = {
      kind: "collection" as const,
      collection: " https://test/album ",
      episodes: "",
      count: "2",
      date: "2026-10-07",
    };
    expect(submitBody(base)).toEqual({
      linkKind: "collection",
      collectionUrl: "https://test/album",
      reportedEpisodeCount: 2,
      actualLaunchDate: "2026-10-07",
    });
    expect(
      submitBody({ ...base, kind: "episodes", episodes: "1 https://test/1\n2 https://test/2" }),
    ).toEqual({
      linkKind: "episodes",
      episodeUrls: [
        { episodeNo: 1, url: "https://test/1" },
        { episodeNo: 2, url: "https://test/2" },
      ],
      reportedEpisodeCount: 2,
      actualLaunchDate: "2026-10-07",
    });
    expect(() => submitBody({ ...base, kind: "episodes", episodes: "1 a\n1 b" })).toThrow("重复");
  });
  it.each([
    ["PLAN_VERSION_STALE", "方案已更新"],
    ["SAMPLE_NOT_VIEWABLE", "联系服务经理"],
    ["DOWNLOAD_GRANT_INVALID", "下载授权已过期"],
    ["LINK_INVALID", "episodeUrls[1].url：请使用 HTTPS"],
  ])("按%s给提示", (error, text) => {
    const e = new ApiError({
      error: error as "LINK_INVALID",
      status: 409,
      requestId: "test",
      message: "server",
      details: { field: "episodeUrls[1].url", reason: "not_https" },
    });
    expect(deliveryError(e)).toContain(text);
  });
  it("游标跨页去重，记录逐账号全量读取，不以首账号代整剧", async () => {
    const next = structuredClone(tasks);
    next.items[0]!.items[0]!.tasks.push({ ...task.task, launchTaskId: "second" });
    expect(mergeTaskPages(tasks, next).items[0]!.items[0]!.tasks).toHaveLength(2);
    const { api, send } = makeApi();
    send.mockImplementation(async (path) =>
      path.includes("cursor=")
        ? next
        : path.includes("?")
          ? { ...tasks, hasMore: true, nextCursor: "cursor" }
          : task,
    );
    expect(await readLaunchRecord(api, "item", () => true)).toHaveLength(2);
    expect(
      send.mock.calls.filter(([p]) => !p.includes("?") && p.includes("launch-tasks/")),
    ).toHaveLength(2);
  });
});
