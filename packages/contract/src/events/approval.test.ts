import { describe, expect, it } from "vitest";

import { A03_ERROR_DETAILS } from "../routes/a03-merchant/error-details.js";
import { ApprovalSummarySchema } from "../routes/a01-system/approvals.schemas.js";
import { ERRORS } from "../errors/index.js";
import { payloads } from "./approval.js";

const ID = "01900000-0000-7000-8000-000000000001";
const subject = {
  approvalRequestId: ID,
  kind: "points_adjust",
  subjectType: "billing_account",
  subjectId: ID,
};

describe("approval 的事件载荷（W1-06；x01 第 3.3 节）", () => {
  it("四个迁移事件带三个迁移键，执行事件不带；多余的键、别的类型的执行事件不收", () => {
    const submitted = {
      v: 1,
      ...subject,
      category: "approval",
      entityId: ID,
      storeId: null,
      roundNo: 1,
      fromState: null,
      toState: "pending",
      transition: "submit",
    };
    expect(payloads["approval.submitted"].parse(submitted)).toEqual(submitted);
    const decided = { v: 1, ...subject, isDecidedBySystem: false, fromState: "pending" };
    expect(
      payloads["approval.approved"].safeParse({
        ...decided,
        toState: "approved",
        transition: "approve",
      }).success,
    ).toBe(true);
    expect(
      payloads["approval.rejected"].safeParse({
        ...decided,
        reasonCodes: ["R01"],
        toState: "rejected",
        transition: "reject",
      }).success,
    ).toBe(true);
    expect(
      payloads["approval.withdrawn"].safeParse({
        v: 1,
        ...subject,
        fromState: "pending",
        toState: "withdrawn",
        transition: "withdraw",
      }).success,
    ).toBe(true);
    const executed = {
      v: 1,
      approvalRequestId: ID,
      kind: "order_cancel",
      domainType: "cancel_request",
      domainId: ID,
    };
    expect(payloads["approval.executed"].parse(executed)).toEqual(executed);
    const bad: Array<[keyof typeof payloads, unknown]> = [
      ["approval.submitted", { ...submitted, note: "自由文本" }],
      ["approval.submitted", { ...submitted, toState: "approved" }],
      ["approval.approved", { ...decided, toState: "rejected", transition: "approve" }],
      ["approval.executed", { ...executed, kind: "points_adjust" }],
      ["approval.executed", { ...executed, fromState: "approved" }],
    ];
    for (const [name, payload] of bad)
      expect(payloads[name].safeParse(payload).success, name).toBe(false);
  });
});

describe("审批段错误码的 details 与摘要结构（W1-06）", () => {
  it("登记了结构的码在错误码表里都标了带 details", () => {
    for (const symbol of Object.keys(A03_ERROR_DETAILS) as Array<keyof typeof A03_ERROR_DETAILS>) {
      expect(ERRORS[symbol].hasDetails, symbol).toBe(true);
    }
    expect(
      A03_ERROR_DETAILS.APPROVAL_NOT_PENDING.safeParse({
        status: "approved",
        decidedAt: "2026-01-05T04:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      A03_ERROR_DETAILS.APPROVAL_ALREADY_PENDING.safeParse({ approvalId: ID, requestNo: null })
        .success,
    ).toBe(true);
  });

  it("摘要必有标题；不收登记之外的键", () => {
    const summary = {
      title: "积分调整 +200",
      lines: [{ label: "商家", value: "星河洗车" }],
      points: 200,
      domain: { type: "point_adjustment_request", id: ID },
    };
    expect(ApprovalSummarySchema.parse(summary)).toEqual(summary);
    expect(ApprovalSummarySchema.safeParse({ lines: [] }).success).toBe(false);
    expect(ApprovalSummarySchema.safeParse({ title: "x", certNo: "9144…" }).success).toBe(false);
  });
});
