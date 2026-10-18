import { expect, it } from "vitest";
import { accessFromMe } from "../auth/model";
import {
  approvalSearch,
  approvalQuery,
  approvalSummaryQuery,
  approvalTarget,
  type ApprovalDetail,
} from "./model";

const id = "01900000-0000-7000-8000-000000000001";
const access = accessFromMe({
  staff: { staffId: "admin", name: "管理员", roleKey: "super_admin", isLead: true },
  roleName: "管理员",
  moduleLevels: {
    workbench: "v",
    drama: "n",
    billing: "n",
    merchant: "e",
    order: "n",
    delivery: "n",
    publish: "e",
    service: "n",
    finance: "n",
    report: "n",
    ops: "n",
    system: "n",
    channel: "n",
  },
  permissions: [],
  dataScope: "all",
  flags: {},
});
const item: Pick<ApprovalDetail, "approvalId" | "kind" | "operations"> = {
  approvalId: id,
  kind: "qualification",
  operations: {
    get: "admin.qualificationSubmission.get",
    approve: "admin.qualificationSubmission.approve",
    reject: "admin.qualificationSubmission.reject",
    withdraw: null,
  },
};
it("筛选按契约校验，非法日期范围和站外选中id不进入URL", () => {
  const result = approvalSearch({
    submittedFrom: "2026-10-10",
    submittedTo: "2026-10-01",
    page: "0",
    pageSize: "13",
    id: "https://outside.example",
    unexpected: "x",
  });
  expect(result).toMatchObject({ tab: "todo", page: "1", pageSize: "20" });
  for (const key of ["submittedFrom", "submittedTo", "id", "unexpected"])
    expect(result).not.toHaveProperty(key);
});
it("合法kind/status CSV保持wire，分页数字与日期过滤保持", () => {
  expect(
    approvalQuery({
      kind: "qualification,channel_account",
      status: "pending,approved",
      page: "2",
      pageSize: "50",
      id,
    }),
  ).toMatchObject({
    kind: "qualification,channel_account",
    status: "pending,approved",
    page: 2,
    pageSize: 50,
  });
  expect(approvalQuery({ id })).not.toHaveProperty("id");
});
it("摘要保同业务筛选，排除tab/status和分页避免计数口径错位", () => {
  expect(
    approvalSummaryQuery({
      q: "资质",
      kind: "qualification",
      status: "pending",
      tab: "submitted",
      overdue: "true",
    }),
  ).toMatchObject({ q: "资质", kind: "qualification", overdue: "true" });
  for (const key of ["tab", "status", "page", "pageSize"])
    expect(approvalSummaryQuery({})).not.toHaveProperty(key);
});
it("领域GET符号与已实现可进入页面双核，不能把服务字符串拼成调用", () => {
  expect(approvalTarget(item, access)).toBe(`/merchants/review?id=${id}`);
  expect(
    approvalTarget(
      { ...item, operations: { ...item.operations, get: "admin.future.get" } },
      access,
    ),
  ).toBeNull();
  expect(approvalTarget(item, null)).toBeNull();
});
it("财务配置/未来类型没有业务处理公口时明确只读", () => {
  for (const kind of ["finance_config_change", "future", "transfer_confirm"])
    expect(approvalTarget({ ...item, kind }, access)).toBeNull();
});
