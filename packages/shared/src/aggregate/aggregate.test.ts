import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DELIVERY_TICKET_STEP, ORDER_ITEM_PHASE } from "@liyoxi/contract/enums";
import {
  ACTIVE_PHASES,
  PRODUCING_STEPS,
  orderStatus,
  orderSubStatus,
  phaseFromTicket,
} from "./index.js";
const cases = DELIVERY_TICKET_STEP.values.flatMap((step) =>
  [false, true].flatMap((live) => [0, 1].map((returned) => ({ step, live, returned }))),
);
describe("13步骤×上线史×实际退回：52格", () => {
  it.each(cases)("$step live=$live returned=$returned", ({ step, live, returned }) => {
    const expected = [
      "assigning",
      "plan_confirm",
      "ad_prep",
      "sample_making",
      "sample_confirm",
      "batch_compose",
      "delivering",
    ].includes(step)
      ? "producing"
      : ["awaiting_launch", "launch_verify"].includes(step)
        ? "to_launch"
        : step === "in_service"
          ? "live"
          : step === "takedown"
            ? live
              ? "live"
              : "to_launch"
            : step === "archived"
              ? returned > 0
                ? "refunded"
                : "ended"
              : returned > 0
                ? "refunded"
                : "terminated";
    expect(phaseFromTicket(step, live, returned)).toBe(expected);
  });
  it("拒绝未知步骤与非真实退回数量", () => {
    expect(() => phaseFromTicket("unknown", false, 0)).toThrow();
    for (const amount of [-1, 0.5, NaN])
      expect(() => phaseFromTicket("archived", false, amount)).toThrow();
  });
});
describe("整单四条件与子状态", () => {
  it.each(ACTIVE_PHASES)("最早阶段%s优先于其后/已关闭项", (phase) => {
    const remaining = ACTIVE_PHASES.slice(ACTIVE_PHASES.indexOf(phase));
    expect(
      orderStatus([...remaining.map((phase) => ({ phase })), { phase: "terminated" }], false),
    ).toBe(phase);
  });
  it("在途取消优先；全闭有实际退回；终止零退回归取消；ended仍活跃", () => {
    expect(orderStatus([{ phase: "ended" }], true)).toBe("after_sale");
    expect(orderStatus([{ phase: "cancelled" }, { phase: "refunded" }], false)).toBe("refunded");
    expect(orderStatus([{ phase: "terminated" }, { phase: "cancelled" }], false)).toBe("cancelled");
    expect(orderStatus([{ phase: "ended" }, { phase: "refunded" }], false)).toBe("ended");
  });
  it.each(PRODUCING_STEPS)("制作子状态%s，取最靠前工单", (ticketStep) => {
    expect(
      orderSubStatus({
        status: "producing",
        items: [
          { phase: "live", ticketStep: "in_service" },
          { phase: "producing", ticketStep: "delivering" },
          { phase: "producing", ticketStep },
        ],
      }),
    ).toBe(ticketStep);
  });
  it("pending、售后、关闭的全部分支", () => {
    for (const [qualificationStatus, expected] of [
      ["pending", "qualification_reviewing"],
      ["rejected", "qualification_rejected"],
      ["verified", "starting"],
    ])
      expect(
        orderSubStatus({
          status: "pending_start",
          items: [{ phase: "pending_start" }],
          qualificationStatus,
        }),
      ).toBe(expected);
    for (const [cancelRequestStatus, expected] of [
      ["pending_approval", "cancel_reviewing"],
      ["pending_execution", "refund_executing"],
    ])
      expect(
        orderSubStatus({
          status: "after_sale",
          items: [{ phase: "producing" }],
          cancelRequestStatus,
        }),
      ).toBe(expected);
    expect(orderSubStatus({ status: "cancelled", items: [{ phase: "terminated" }] })).toBe(
      "terminated_no_return",
    );
    expect(orderSubStatus({ status: "cancelled", items: [{ phase: "cancelled" }] })).toBe(
      "cancelled_before_start",
    );
    for (const status of ["ended", "refunded"] as const)
      expect(orderSubStatus({ status, items: [{ phase: status }] })).toBeNull();
  });
  it("上线前后所有未来展示分支只依赖传入事实", () => {
    for (const launchState of [
      "awaiting_links",
      "verifying",
      "need_fix",
      "expired_unlaunched",
    ] as const)
      expect(
        orderSubStatus({ status: "to_launch", items: [{ phase: "to_launch", launchState }] }),
      ).toBe(launchState);
    for (const liveState of ["in_service", "takedown_pending", "takedown_overdue"] as const)
      expect(orderSubStatus({ status: "live", items: [{ phase: "live", liveState }] })).toBe(
        liveState,
      );
  });
  it("同阶段的多个工单取最靠前步骤，UUID或输入顺序不决定子状态", () => {
    for (const reversed of [false, true]) {
      const launching = [
        { phase: "to_launch", ticketStep: "launch_verify" },
        { phase: "to_launch", ticketStep: "awaiting_launch" },
      ];
      const live = [
        { phase: "live", ticketStep: "takedown", liveState: "takedown_overdue" as const },
        { phase: "live", ticketStep: "in_service" },
      ];
      expect(
        orderSubStatus({ status: "to_launch", items: reversed ? launching.reverse() : launching }),
      ).toBe("awaiting_links");
      expect(orderSubStatus({ status: "live", items: reversed ? live.reverse() : live })).toBe(
        "in_service",
      );
    }
  });
});
const items = fc
  .array(fc.constantFrom(...ORDER_ITEM_PHASE.values), { minLength: 1, maxLength: 50 })
  .map((phases) => phases.map((phase) => ({ phase })));
it("200轮：调换项顺序/添加关闭零退回项不改聚合，售后始终优先", () => {
  fc.assert(
    fc.property(items, (rows) => {
      expect(orderStatus([...rows].reverse(), false)).toBe(orderStatus(rows, false));
      expect(orderStatus([...rows, { phase: "terminated" }, { phase: "cancelled" }], false)).toBe(
        orderStatus(rows, false),
      );
      expect(orderStatus(rows, true)).toBe("after_sale");
    }),
    { seed: 117, numRuns: 200 },
  );
});
