import { expect, it } from "vitest";
import { ExtensionQuoteSchema } from "@liyoxi/contract";
import { renewalSearch, renewalFilters, extensionBody } from "./model";
const id = "0199e187-e72a-7000-8000-000000000001",
  other = "0199e187-e72a-7000-8000-000000000002";
const row = { subscriptionTermId: id, endDate: "2030-10-30" },
  draft = { days: 7, reasonCode: "fixture_enabled_reason", note: "虚构补偿依据" };
const quote = ExtensionQuoteSchema.parse({
  mode: "extend",
  targetSubscriptionTermId: id,
  isTargetDifferent: false,
  days: 7,
  prevEndDate: "2030-10-30",
  newEndDate: "2030-11-06",
  newEndsAt: "2030-11-06T16:00:00.000Z",
  restorePoints: 0,
  shiftedTerms: [],
  blockReasons: [],
});
it("到期summary仅三个正式筛选，不把tab/页码或虚构日期排序放进服务端查询", () => {
  const search = renewalSearch({
    tab: "expired",
    page: "2",
    pageSize: "50",
    q: "虚构",
    managerId: id,
    sort: "-money",
    createdFrom: "2030-01-01",
  });
  expect(search).toMatchObject({ tab: "expired", page: 2, pageSize: 50, managerId: id });
  expect(renewalFilters(search)).toEqual({ q: "虚构", managerId: id, planId: undefined });
  expect(renewalSearch({ tab: "all", pageSize: 100 })).toMatchObject({
    tab: "expiring",
    pageSize: 20,
  });
});
it("延长confirm保留打开时原周期/止日，目标变化不静默改写；0恢复点与服务端日期原样", () => {
  expect(
    extensionBody(row, draft, {
      ...quote,
      targetSubscriptionTermId: other,
      isTargetDifferent: true,
    }),
  ).toEqual({
    ...draft,
    subscriptionTermId: id,
    confirm: { subscriptionTermId: id, endDate: "2030-10-30" },
  });
  expect(quote.restorePoints).toBe(0);
  expect(row.endDate).toBe("2030-10-30");
});
it("失效/天数变更/退款禁止试算不能发起延长，不放宽90天或说明守卫", () => {
  for (const invalid of [
    { ...quote, mode: "not_applicable" as const },
    { ...quote, blockReasons: ["term_refunded" as const] },
    { ...quote, days: 3 },
    { ...quote, newEndDate: null },
  ])
    expect(() => extensionBody(row, draft, invalid)).toThrow("试算");
  expect(() => extensionBody(row, { ...draft, days: 91 }, { ...quote, days: 91 })).toThrow();
  expect(() => extensionBody(row, { ...draft, note: "" }, quote)).toThrow();
});
