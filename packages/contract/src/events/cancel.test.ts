import { describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS, eventPayloadSchema } from "./index.js";

const id = "01900000-0000-7000-8000-00000000000a";
const base = { v: 1, cancelRequestId: id };
const move = (fromState: string | null, toState: string, transition: string) => ({
  ...base,
  fromState,
  toState,
  transition,
});
const examples = {
  "cancel.submitted": {
    ...move(null, "pending_approval", "cancel.submit"),
    approvalRequestId: id,
    kind: "ad_cancel",
    subjectType: "ad",
    subjectId: id,
    totalRefundPoints: 240,
  },
  "cancel.approved": {
    ...move("pending_approval", "pending_execution", "approval.approved"),
    execDueAt: "2026-10-12T10:00:00.000Z",
  },
  "cancel.rejected": move("pending_approval", "not_executed", "approval.rejected"),
  "cancel.withdrawn": move("pending_approval", "not_executed", "approval.withdrawn"),
  "cancel.voided": move("pending_execution", "not_executed", "cancel.void"),
  "cancel.executed": {
    ...move("pending_execution", "done", "cancel.execute"),
    isAutoExecuted: false,
  },
  "ad.cancelled": {
    ...move("producing", "cancelled", "ad.cancel"),
    adId: id,
    returnedPoints: 240,
    forfeitedPoints: 0,
  },
};
function rejects(name: keyof typeof examples, changes: Record<string, unknown>[]) {
  for (const change of changes)
    expect(
      EVENT_PAYLOAD_SCHEMAS[name].safeParse({ ...examples[name], ...change }).success,
      name,
    ).toBe(false);
}

describe("取消事件严格载荷（x01 §3.5）", () => {
  it("七个正式事件都有严格schema，拒绝自由文本、不合规UUID和非1版本", () => {
    for (const name of Object.keys(examples) as (keyof typeof examples)[]) {
      const schema = EVENT_PAYLOAD_SCHEMAS[name];
      expect(eventPayloadSchema(name)).toBe(schema);
      expect(schema.parse(examples[name])).toEqual(examples[name]);
      rejects(name, [{ note: "自由文本" }, { cancelRequestId: id.toUpperCase() }, { v: 2 }]);
    }
  });
  it("提交绑定正确kind与对象，合计是非负整数", () => {
    const schema = EVENT_PAYLOAD_SCHEMAS["cancel.submitted"];
    for (const [kind, subjectType] of [
      ["ad_cancel", "ad"],
      ["order_cancel", "drama_order"],
      ["qualification_cancel", "store"],
    ])
      expect(schema.safeParse({ ...examples["cancel.submitted"], kind, subjectType }).success).toBe(
        true,
      );
    rejects("cancel.submitted", [
      { subjectType: "store" },
      { kind: "plan_refund" },
      { subjectId: id.toUpperCase() },
      { totalRefundPoints: -1 },
      { totalRefundPoints: 0.5 },
      { fromState: "pending_approval" },
      { transition: "submit" },
    ]);
  });
  it("批准严格检查迁移和标准UTC执行截止", () => {
    rejects("cancel.approved", [
      { execDueAt: "2026-10-12" },
      { execDueAt: "2026-10-12T18:00:00+08:00" },
      { fromState: "done" },
      { toState: "done" },
      { transition: "cancel.approve" },
    ]);
  });
  it("驳回、撤回和作废分别只收正式起始状态与迁移", () => {
    for (const name of ["cancel.rejected", "cancel.withdrawn", "cancel.voided"] as const)
      rejects(name, [
        { fromState: "done" },
        { toState: "done" },
        { transition: "approval.approved" },
      ]);
    rejects("cancel.rejected", [{ fromState: "pending_execution" }]);
    rejects("cancel.withdrawn", [{ fromState: "pending_execution" }]);
    rejects("cancel.voided", [{ fromState: "pending_approval" }]);
  });
  it("人工与自动执行的标记、起始状态和迁移码必须匹配", () => {
    const auto = {
      ...move("pending_approval", "done", "cancel.auto_execute"),
      isAutoExecuted: true,
    };
    expect(EVENT_PAYLOAD_SCHEMAS["cancel.executed"].parse(auto)).toEqual(auto);
    rejects("cancel.executed", [
      { isAutoExecuted: true },
      { transition: "cancel.auto_execute" },
      { isAutoExecuted: true, fromState: "pending_approval" },
      { toState: "not_executed" },
    ]);
    expect(
      EVENT_PAYLOAD_SCHEMAS["cancel.executed"].safeParse({ ...auto, isAutoExecuted: false })
        .success,
    ).toBe(false);
  });
  it("广告取消覆盖允许状态，只收实际退回合计与不予退回数量", () => {
    const schema = EVENT_PAYLOAD_SCHEMAS["ad.cancelled"],
      good = examples["ad.cancelled"];
    for (const fromState of [
      "pending_assign",
      "producing",
      "revising",
      "pending_confirm",
      "returned",
    ])
      expect(schema.safeParse({ ...good, fromState }).success).toBe(true);
    expect(schema.safeParse({ ...good, returnedPoints: 0, forfeitedPoints: 240 }).success).toBe(
      true,
    );
    rejects("ad.cancelled", [
      { fromState: "confirmed" },
      { fromState: "cancelled" },
      { returnedPoints: -1 },
      { forfeitedPoints: 0.5 },
      { convertedPoints: 120 },
      { transition: "cancel.execute" },
    ]);
  });
});
