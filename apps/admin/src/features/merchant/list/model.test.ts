import { StoreListQuerySchema, StoreListSummaryQuerySchema } from "@liyoxi/contract";
import { describe, expect, it } from "vitest";
import { createAdminApi } from "../../../lib/api";
import { createQueryClient } from "../../../lib/query";
import { createMerchantApi } from "../detail/api";
import { amount, MERCHANT_KEY } from "../detail/model";
import { merchantListQuery, merchantListSearch, merchantSummaryQuery } from "./model";
const id = "0199e187-e72a-7000-8000-000000000001";
const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, message: "ok", data }), {
    headers: { "Content-Type": "application/json" },
  });
describe("W215商家列表查询边界", () => {
  it("全筛选在列表与summary同范围，CSV/空值/页码规范化并保留实际默认排序", () => {
    const raw = {
      q: " 虚构门店 ",
      regionCode: "440100",
      industryCode: "food",
      categoryCode: "coffee",
      qualificationStatus: "pending,verified",
      sourceType: "sales,campaign,partner",
      subscriptionStatus: "active,expired",
      planId: id,
      expiresWithinDays: 30,
      deliveryManagerId: id,
      isManagerUnassigned: true,
      entityId: id,
      lifecycle: "archived",
      page: 3,
      pageSize: 50,
      sort: "-totalPaidFen",
      ui: "never-send",
    };
    const list = merchantListQuery(raw),
      summary = merchantSummaryQuery(raw);
    const { page, pageSize, sort, ...filters } = list;
    expect({ page, pageSize, sort }).toEqual({ page: 3, pageSize: 50, sort: "-totalPaidFen" });
    expect(summary).toEqual(filters);
    expect(summary).toMatchObject({
      q: "虚构门店",
      sourceType: "sales,campaign,partner",
      deliveryManagerId: id,
      lifecycle: "archived",
    });
    expect(summary).not.toHaveProperty("isManagerUnassigned");
    expect(StoreListQuerySchema.safeParse(list).success).toBe(true);
    expect(StoreListSummaryQuerySchema.safeParse(summary).success).toBe(true);
    expect(
      merchantListSearch({
        page: -2,
        pageSize: 100,
        planId: "bad",
        sort: "invented",
        sourceType: "invented",
        q: "x".repeat(40),
      }),
    ).toEqual({
      lifecycle: "active",
      sort: "-lastOrderAt",
      page: "1",
      pageSize: "20",
      q: "x".repeat(30),
    });
    expect(merchantListQuery({ isManagerUnassigned: true })).toMatchObject({
      isManagerUnassigned: "true",
    });
    expect(amount(null)).toBe("—");
    expect(amount(undefined)).toBe("—");
    expect(amount(0)).not.toBe("—");
  });
  it("实际GET与summary保持同过滤，迟到请求保存在原actor/query键内，不覆盖新范围", async () => {
    const requests: Request[] = [];
    let release!: (response: Response) => void;
    const api = createMerchantApi({
      api: createAdminApi({
        baseUrl: "http://admin.test",
        build: "w215",
        fetch: async (input) => {
          if (!(input instanceof Request)) throw new Error("必须使用真实Request");
          requests.push(input.clone());
          if (requests.length === 1)
            return new Promise<Response>((resolve) => {
              release = resolve;
            });
          if (new URL(input.url).pathname.endsWith("summary"))
            return ok({
              total: 7,
              paidCount: 3,
              activePlanCount: 2,
              pendingReviewCount: 1,
              newThisMonthCount: 4,
            });
          return ok({ items: [], total: 7, page: 1, pageSize: 20 });
        },
        handlers: {
          redirectToLogin() {},
          stepUp: async () => false,
          refreshAccess() {},
          invalidateQueries() {},
          notify() {},
          showBlocked() {},
          buildMismatch() {},
        },
      }),
    });
    const cache = createQueryClient(),
      oldQuery = merchantListQuery({ q: "旧店" }),
      newQuery = merchantListQuery({ q: "新店", sourceType: "sales,campaign" });
    const oldKey = [...MERCHANT_KEY, "old-actor", "list", oldQuery],
      newKey = [...MERCHANT_KEY, "new-actor", "list", newQuery];
    try {
      const slow = cache.fetchQuery({ queryKey: oldKey, queryFn: () => api.stores(oldQuery) });
      await cache.fetchQuery({ queryKey: newKey, queryFn: () => api.stores(newQuery) });
      await api.summary(merchantSummaryQuery(newQuery));
      release(ok({ items: [], total: 1, page: 1, pageSize: 20 }));
      await slow;
      expect(cache.getQueryData(newKey)).toMatchObject({ total: 7 });
      expect(cache.getQueryData(oldKey)).toMatchObject({ total: 1 });
      const listParams = new URL(requests[1]!.url).searchParams;
      listParams.delete("page");
      listParams.delete("pageSize");
      listParams.delete("sort");
      expect(Object.fromEntries(new URL(requests[2]!.url).searchParams)).toEqual(
        Object.fromEntries(listParams),
      );
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    } finally {
      cache.clear();
    }
  });
});
