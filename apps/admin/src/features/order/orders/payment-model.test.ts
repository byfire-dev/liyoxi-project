import { expect, it } from "vitest";
import { PaymentOrderAdminRowSchema } from "@liyoxi/contract";
import { paymentSearch, paymentFilters, paymentQuery } from "./payment-model";
import { readProofPermission } from "./payment-api";
const id = "0199e187-e72a-7000-8000-000000000001",
  other = "0199e187-e72a-7000-8000-000000000002",
  at = "2030-10-18T04:00:00.000Z";
const row = PaymentOrderAdminRowSchema.parse({
  paymentOrderId: id,
  orderNo: "FK203010180001",
  createdAt: at,
  entity: {
    entityId: other,
    name: "虚构主体",
    primaryStoreId: null,
    primaryStoreName: null,
    storeCount: 0,
    verificationStatus: "verified",
    managerStaff: null,
  },
  store: null,
  type: "topup",
  title: "虚构积分包",
  contentNote: null,
  amountFen: 1,
  paidAmountFen: 0,
  refundedAmountFen: 0,
  channel: "bank_transfer",
  status: "pending_payment",
  transferState: "awaiting_proof",
  fulfillmentStatus: "none",
  statusNote: null,
  hasOpenException: false,
  source: "admin",
  pendingTransferProofId: null,
  actions: ["submit-proof"],
});
it("独立付款筛选和页签使用自己的URL字段，不污染旧订购单；summary仅筛选真实计数", () => {
  const s = paymentSearch({
    view: "payments",
    tab: "making",
    payTab: "pending_payment",
    payPage: 2,
    paySize: 50,
    payType: "plan_new,topup",
    payException: "true",
    payQ: "虚构",
    payEntityId: other,
    paymentId: id,
  });
  expect(s.payTab).toBe("pending_payment");
  expect(paymentQuery(s)).toMatchObject({
    tab: "pending_payment",
    page: 2,
    pageSize: 50,
    type: "plan_new,topup",
    hasOpenException: "true",
    entityId: other,
  });
  expect(paymentFilters(s)).not.toHaveProperty("tab");
  expect(paymentFilters(s)).not.toHaveProperty("page");
  expect(paymentFilters(s)).not.toHaveProperty("paymentId");
  expect(
    paymentSearch({ payTab: "making", payType: "other", payEntityId: "bad", paySize: 100 }),
  ).toMatchObject({ payTab: "all", payType: undefined, payEntityId: undefined, paySize: 20 });
});
it("代传action必须精确匹配真实单号、付款ID、主体；空页/别主体/别ID/无action均不推断允许", async () => {
  const queries: unknown[] = [];
  for (const [items, allowed] of [
    [[row], true],
    [[], false],
    [[{ ...row, paymentOrderId: other }], false],
    [[{ ...row, entity: { ...row.entity, entityId: id } }], false],
    [[{ ...row, actions: [] }], false],
  ] satisfies [(typeof row)[], boolean][]) {
    const api = {
      list: async (query: unknown) => {
        queries.push(query);
        return { items: [...items], page: 1, pageSize: 10, total: items.length };
      },
    };
    expect(await readProofPermission(api, row)).toBe(allowed);
  }
  expect(
    queries.every(
      (q) =>
        typeof q === "object" &&
        q !== null &&
        "no" in q &&
        q.no === row.orderNo &&
        "entityId" in q &&
        q.entityId === other,
    ),
  ).toBe(true);
});
