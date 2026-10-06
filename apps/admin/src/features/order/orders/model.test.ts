import { describe, expect, it } from "vitest";
import { orderFilters, orderQuery, orderSearch, resolveOrderNo } from "./model";
describe("订单地址与正式单号解析", () => {
  it("状态/分页/排序保留且summary不含tab，非法范围与未知参数不透传", () => {
    const search = orderSearch({
      tab: "producing",
      page: 2,
      pageSize: 10,
      sort: "submittedAt",
      q: "演练",
      submittedFrom: "2026-10-06",
      submittedTo: "2026-10-05",
      deliveryManagerId: "bad-id",
      hidden: "yes",
    });
    expect(orderQuery(search)).toMatchObject({
      tab: "producing",
      page: 2,
      pageSize: 10,
      sort: "submittedAt",
      q: "演练",
    });
    expect(orderFilters(search)).not.toHaveProperty("tab");
    expect(search.filters).toEqual({});
  });
  it("直接打开仅接受完全相同的单号，忽略近似搜索命中", async () => {
    const calls: unknown[] = [];
    const api = {
      list: async (query: unknown) => {
        calls.push(query);
        return {
          items: [
            { orderId: "first", orderNo: "LYX001-extra" },
            { orderId: "exact", orderNo: "LYX001" },
          ],
        };
      },
    };
    expect(await resolveOrderNo(api, "LYX001")).toBe("exact");
    expect(await resolveOrderNo(api, "LYX00")).toBeNull();
    expect(calls[0]).toEqual({ q: "LYX001", tab: "all", page: 1, pageSize: 100 });
    expect(await resolveOrderNo(api, "")).toBeNull();
    expect(await resolveOrderNo(api, "x".repeat(41))).toBeNull();
    expect(calls).toHaveLength(2);
  });
});
