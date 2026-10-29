import { expect, it } from "vitest";
import { writeTableSearch } from "../../../lib/table-search";
import { refundFilters, refundLabel, refundSearch, refundTableSearch, sourceLabels } from "./model";

it("W418退款链接支持系统来源与全局主体过滤，列表/计数/选中项各用自己的字段", () => {
  const id = "0199e187-e72a-7000-8000-000000000001";
  const search = refundSearch({
    tab: "pending_execution",
    page: "2",
    pageSize: "10",
    q: " TK001 ",
    entityId: id,
    storeId: id,
    refundRequestId: id,
    source: "staging_probe",
    ruleCode: "unapplied_receipt",
    overdueOnly: "false",
  });
  expect(refundFilters(search)).toEqual({
    q: "TK001",
    entityId: id,
    storeId: id,
    source: "staging_probe",
    ruleCode: "unapplied_receipt",
    overdueOnly: "false",
  });
  const changed = refundSearch(writeTableSearch(refundTableSearch(search)));
  expect(changed).toEqual({ ...search, refundRequestId: undefined });
  expect(
    refundSearch({
      source: "fake",
      refundRequestId: "bad",
      entityId: "bad",
      overdueOnly: "yes",
      tab: "done",
    }),
  ).toMatchObject({
    tab: "pending_approval",
    source: undefined,
    refundRequestId: undefined,
    entityId: undefined,
    overdueOnly: undefined,
  });
  expect(sourceLabels[search.source!]).toBe("预发系统退款");
  expect(refundLabel({ status: "executing", closeReason: null })).toBe("退款处理中");
  expect(refundLabel({ status: "not_executed", closeReason: "withdrawn" })).toBe("已撤回");
  expect(refundLabel({ status: "not_executed", closeReason: "voided" })).toBe("已作废");
});
