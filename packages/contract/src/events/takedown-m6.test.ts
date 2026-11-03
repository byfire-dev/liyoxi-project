import { expect, it } from "vitest";
import { payloads } from "./takedown-m6.js";
const base = {
  v: 1,
  takedownTaskId: "01900000-0000-7000-8000-000000000001",
  orderItemId: "01900000-0000-7000-8000-000000000002",
};
it("下架事件固定业务字段与迁移，抽签参数留历史而不混入通知载荷", () => {
  const confirmed = {
    ...base,
    merchantMethod: "delete",
    fromState: "pending_merchant",
    toState: "merchant_confirmed",
    transition: "takedown.merchant_confirm",
  };
  expect(payloads["takedown.merchant_confirmed"].safeParse(confirmed).success).toBe(true);
  expect(
    payloads["takedown.merchant_confirmed"].safeParse({ ...confirmed, draw: 10000 }).success,
  ).toBe(false);
  const checked = {
    ...base,
    checkMethod: "sampled_out",
    fromState: "merchant_confirmed",
    toState: "checked",
    transition: "takedown.sample_release",
  };
  expect(payloads["takedown.checked"].safeParse(checked).success).toBe(true);
  expect(
    payloads["takedown.checked"].safeParse({ ...checked, transition: "takedown.check_pass" })
      .success,
  ).toBe(false);
  expect(
    payloads["takedown.found_online"].safeParse({
      ...base,
      stillOnlineCount: 1,
      fromState: "merchant_confirmed",
      toState: "pending_merchant",
      transition: "takedown.still_online",
    }).success,
  ).toBe(true);
  expect(
    payloads["takedown.escalated"].safeParse({
      ...base,
      dueDate: "2026-11-01",
      fromState: "pending_merchant",
      toState: "pending_merchant",
      transition: "takedown.escalate",
    }).success,
  ).toBe(true);
  expect(
    payloads["takedown.basis_reopened"].safeParse({
      ...base,
      fromState: "merchant_confirmed",
      toState: "pending_merchant",
      transition: "takedown.basis_reopen",
    }).success,
  ).toBe(true);
  expect(
    payloads["takedown.breach_notified"].safeParse({
      v: 1,
      takedownTaskId: base.takedownTaskId,
      breachNoticeCount: 1,
      fromState: "pending_merchant",
      toState: "pending_merchant",
      transition: "takedown.breach_notice",
    }).success,
  ).toBe(true);
});
