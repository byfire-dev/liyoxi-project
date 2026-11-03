import { expect, it } from "vitest";
import {
  accountRouteSearch,
  healthAbnormalBody,
  healthQuery,
  healthScope,
  healthSearch,
} from "./health-model";
it("健康视图和原审批查询独立保留；健康summary与列表采用同筛选", () => {
  const raw = accountRouteSearch({
    tab: "done_today",
    q: "原审批",
    view: "health",
    healthQ: "健康搜索",
    healthTab: "abnormal",
    healthPlatform: "douyin",
    healthPage: 2,
  });
  expect(raw).toMatchObject({
    tab: "done_today",
    q: "原审批",
    view: "health",
    healthQ: "健康搜索",
    healthTab: "abnormal",
    healthPage: 2,
  });
  const search = healthSearch(raw),
    { status, page, pageSize, ...scope } = healthQuery(search)!;
  expect([status, page, pageSize]).toEqual(["abnormal", 2, 20]);
  expect(scope).toEqual(healthScope(search));
  expect(scope).toMatchObject({ q: "健康搜索", platform: "douyin" });
  expect(accountRouteSearch({ tab: "todo", q: "审批" })).not.toHaveProperty("healthQ");
});
it("标记异常必须原因与说明，不自动标记巡检异常账号", () => {
  expect(healthAbnormalBody("", "异常")).toBeNull();
  expect(healthAbnormalBody("reason", "  ")).toBeNull();
  expect(healthAbnormalBody("reason", "x".repeat(201))).toBeNull();
  expect(healthAbnormalBody("reason", " 账号资料异常 ")).toEqual({
    reasonCode: "reason",
    note: "账号资料异常",
  });
});
