import { ApprovalListQuerySchema, StaffListQuerySchema } from "@liyoxi/contract/queries/admin";
import { describe, expect, it } from "vitest";

import { readContractQuery } from "./contract-query";

const staffOptions = {
  keys: [
    "q",
    "page",
    "pageSize",
    "roleKey",
    "status",
    "sort",
    "withLoad",
    "recommendPool",
    "recommendCityCode",
  ],
  defaults: { page: "1", pageSize: "20" },
  keywordLimit: 20,
  recover: { recommendCityCode: ["recommendPool"] },
};
describe("契约查询：URL wire 与解析结果各有用途", () => {
  it("混合坏 URL 只恢复坏字段，合法 CSV/关键词与分页不丢", () => {
    const result = readContractQuery(
      StaffListQuerySchema,
      {
        page: -3,
        pageSize: "garbage",
        roleKey: "cs,finance",
        status: "future",
        sort: "openWorkCount",
        q: " abc ",
        unknown: "secret",
        tab: "anything",
      },
      staffOptions,
    );
    expect(result.wire).toEqual({ page: "1", pageSize: "20", roleKey: "cs,finance", q: "abc" });
    expect(result.parsed).toMatchObject({
      roleKey: "cs,finance",
      withLoad: false,
      sort: "staffNo",
    });
  });
  it("跨字段拒绝不能透传，合法跨字段组合与缺省可恢复", () => {
    const invalid = readContractQuery(
      StaffListQuerySchema,
      {
        recommendPool: "delivery_manager",
        roleKey: "cs",
        page: 2,
      },
      staffOptions,
    );
    expect(invalid.wire).toEqual({ page: "2", pageSize: "20", roleKey: "cs" });
    const valid = readContractQuery(
      StaffListQuerySchema,
      {
        sort: "openWorkCount",
        withLoad: true,
        pageSize: 50,
      },
      staffOptions,
    );
    expect(valid.parsed).toMatchObject({ sort: "openWorkCount", withLoad: true, pageSize: 50 });
  });
  it("审批 CSV 与布尔只解析一次；wire 字符串能再次被实际 schema 接受", () => {
    const result = readContractQuery(
      ApprovalListQuerySchema,
      {
        kind: "qualification,qualification",
        overdue: "true",
        status: "pending,approved",
        pageSize: 100,
        id: "UI-only",
      },
      { keys: ["kind", "overdue", "status", "pageSize"] },
    );
    expect(result.parsed).toMatchObject({
      kind: ["qualification"],
      overdue: true,
      status: ["pending", "approved"],
      pageSize: 100,
    });
    expect(result.wire).toEqual({
      kind: "qualification,qualification",
      overdue: "true",
      status: "pending,approved",
      pageSize: "100",
    });
    expect(ApprovalListQuerySchema.safeParse(result.wire).success).toBe(true);
    expect(
      readContractQuery(ApprovalListQuerySchema, { kind: ["qualification"] }, { keys: ["kind"] })
        .wire,
    ).toEqual({});
  });
});
