import { describe, expect, it } from "vitest";
import { createAssignmentIntent, ticketFilters, ticketQuery, ticketSearch } from "./model";
describe("工单池筛选与分配意图", () => {
  it("筛选地址与summary同口径，运维筛选和非法模型不进入本包接口", () => {
    const search = ticketSearch({
      tab: "assigning",
      sort: "stepDueAt",
      productionModel: "invalid",
      isPaused: "true",
      isStuck: "true",
      overdueOnly: true,
      deliveryManagerId: "none",
      pageSize: 50,
    });
    expect(search.filters).toEqual({ overdueOnly: "true", deliveryManagerId: "none" });
    expect(ticketQuery(search)).toMatchObject({
      tab: "assigning",
      pageSize: 50,
      sort: "stepDueAt",
    });
    expect(ticketFilters(search)).not.toHaveProperty("tab");
  });
  it("同一失败重试沿用幂等键，换候选为新意图，同步双点击仅一个请求", async () => {
    let sequence = 0;
    const intent = createAssignmentIntent(() => `assign-${++sequence}`),
      keys: string[] = [];
    let resolve!: () => void;
    const wait = new Promise<void>((done) => {
      resolve = done;
    });
    const one = intent({ staffId: "one" }, async (key) => {
      keys.push(key);
      await wait;
      throw new Error("网络中断");
    });
    expect(await intent({ staffId: "one" }, async () => "duplicate")).toBeNull();
    resolve();
    await expect(one).rejects.toThrow();
    await intent({ staffId: "one" }, async (key) => keys.push(key));
    await intent({ staffId: "two" }, async (key) => keys.push(key));
    expect(keys).toEqual(["assign-1", "assign-1", "assign-2"]);
  });
});
