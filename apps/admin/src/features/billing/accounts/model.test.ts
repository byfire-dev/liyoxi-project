import { expect, it } from "vitest";
import {
  accountSearch,
  accountFilters,
  ledgerQuery,
  adjustmentInput,
  adjustmentBody,
} from "./model";
const id = "0199e187-e72a-7000-8000-000000000001";
const draft = {
  direction: "increase" as const,
  lotKind: "addon" as const,
  adjustPoints: 7,
  reasonCode: "compensation",
  note: "虚构服务补偿依据",
};
it("账户分页与筛选和游标各自归属，summary不携带分页/流水；日期与门店ID不猜测", () => {
  const search = accountSearch({
    page: 2,
    pageSize: 50,
    q: "  虚构主体  ",
    accountId: id,
    storeId: "bad",
    cursor: "opaque_cursor",
    ledgerTab: "gain",
    lotKind: "addon",
    ledgerLimit: 10,
    occurredFrom: "2030-02-30",
    subStatus: "active",
  });
  expect(search).toMatchObject({
    page: 2,
    pageSize: 50,
    q: "虚构主体",
    accountId: id,
    storeId: undefined,
    occurredFrom: undefined,
  });
  expect(accountFilters(search)).toEqual({
    q: "虚构主体",
    planId: undefined,
    subStatus: "active",
    flag: undefined,
  });
  expect(ledgerQuery(search)).toEqual({
    tab: "gain",
    lotKind: "addon",
    storeId: undefined,
    occurredFrom: undefined,
    occurredTo: undefined,
    cursor: "opaque_cursor",
    limit: 10,
  });
  expect(ledgerQuery(search)).not.toHaveProperty("page");
});
it("调整只用真实quote的before确认，零可用仍保留；提交是申请而非账本执行", () => {
  expect(adjustmentBody(id, draft, { isAllowed: true, spendableBeforePoints: 0 })).toEqual({
    ...draft,
    pointAccountId: id,
    confirm: { spendableBeforePoints: 0 },
  });
  expect(() => adjustmentBody(id, draft, { isAllowed: false, spendableBeforePoints: 100 })).toThrow(
    "不允许",
  );
  expect(() =>
    adjustmentBody(id, { ...draft, note: "短" }, { isAllowed: true, spendableBeforePoints: 0 }),
  ).toThrow();
  expect(() =>
    adjustmentBody(
      id,
      { ...draft, direction: "decrease", termExtensionRequestId: id },
      { isAllowed: true, spendableBeforePoints: 100 },
    ),
  ).toThrow();
});
it("平台退回须增加且关联合法冻结单，不能仅靠输入积分产生退款旁路", () => {
  expect(() => adjustmentInput({ ...draft, reasonCode: "platform_refund" })).toThrow();
  expect(() =>
    adjustmentInput({
      ...draft,
      reasonCode: "platform_refund",
      direction: "decrease",
      pointHoldId: id,
    }),
  ).toThrow();
  expect(
    adjustmentInput({ ...draft, reasonCode: "platform_refund", pointHoldId: id }),
  ).toMatchObject({ pointHoldId: id, direction: "increase" });
  expect(() => adjustmentInput({ ...draft, adjustPoints: 0 })).toThrow();
});
