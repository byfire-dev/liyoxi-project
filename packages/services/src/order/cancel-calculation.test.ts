import { expect, it } from "vitest";
import { calculateCancelLine } from "./cancel-calculation.js";
import type { CancelCalculationInput } from "./cancel-calculation.js";
const base: CancelCalculationInput = {
  targetType: "order_item",
  state: "producing",
  step: "assigning",
  chargePoints: 105,
  priorRequestedPoints: 0,
  reasonCode: "merchant_request",
  ratios: {
    planConfirm: 1000,
    adAndSample: 3000,
    samplePending: 5000,
    postSample: null,
    adInProduction: 10000,
  },
  at: new Date("2026-01-10T04:00:00Z"),
};
it.each([
  ["assigning", "plan_confirm", 11],
  ["plan_confirm", "plan_confirm", 11],
  ["ad_prep", "ad_and_sample", 32],
  ["sample_making", "ad_and_sample", 32],
  ["sample_confirm", "sample_pending", 53],
  ["batch_compose", "post_sample", 0],
  ["delivering", "post_sample", 0],
  ["awaiting_launch", "post_sample", 0],
  ["launch_verify", "post_sample", 0],
] as const)("%s uses its original stage and HALF_UP", (step, stage, deductPoints) => {
  expect(calculateCancelLine({ ...base, step })).toMatchObject({
    stage,
    deductPoints,
    refundPoints: 105 - deductPoints,
  });
});
it.each(["merchant_request", "store_closed", "platform_fault", "qualification_final"] as const)(
  "%s pending start full release",
  (reasonCode) => {
    expect(
      calculateCancelLine({ ...base, state: "pending_start", step: null, reasonCode }),
    ).toMatchObject({ mode: "release", ratioBp: null, deductPoints: 0, refundPoints: 105 });
  },
);
it.each(["cancelled", "refunded", "terminated", "ended"])("closed %s blocks", (state) => {
  expect(calculateCancelLine({ ...base, state })).toEqual({ blocker: "item_closed" });
});
it.each(["pending_assign", "returned", "producing", "revising", "pending_confirm"])(
  "ad %s stage/mode",
  (state) => {
    expect(
      calculateCancelLine({ ...base, targetType: "ad", state, returnedFrom: "pending_assign" }),
    ).toMatchObject(
      ["pending_assign", "returned"].includes(state)
        ? { stage: "ad_unassigned", mode: "release" }
        : { stage: "ad_in_production", mode: "terminate_only", refundPoints: 0 },
    );
  },
);
it("returned from production stays captured; platform refunds fully", () => {
  expect(
    calculateCancelLine({
      ...base,
      targetType: "ad",
      state: "returned",
      returnedFrom: "producing",
      reasonCode: "platform_fault",
    }),
  ).toMatchObject({ mode: "refund", refundPoints: 105, ratioBp: 0 });
});
it("manual null is explicit, full deduction terminates, invalid manual rejects", () => {
  const i = { ...base, step: "delivering", priorRequestedPoints: 5 };
  expect(calculateCancelLine(i)).toMatchObject({
    isManualDeduct: true,
    deductPoints: 0,
    refundPoints: 100,
  });
  expect(
    calculateCancelLine({ ...i, manualDeduct: { deductPoints: 100, deductNote: "依据" } }),
  ).toMatchObject({ mode: "terminate_only", refundPoints: 0, deductPoints: 100 });
  expect(() =>
    calculateCancelLine({ ...i, manualDeduct: { deductPoints: 101, deductNote: "依据" } }),
  ).toThrow();
});
it("prior uses original S for deduction, caps at remaining", () => {
  expect(calculateCancelLine({ ...base, priorRequestedPoints: 100 })).toMatchObject({
    deductPoints: 5,
    refundPoints: 0,
  });
});
const live = {
  ...base,
  state: "live",
  step: "in_service",
  reasonCode: "platform_fault" as const,
  chargePoints: 100,
  priorRequestedPoints: 20,
  usageStartDate: "2026-01-01",
  usageEndDate: "2026-01-10",
  usageEndSource: "license",
  terminationDate: "2026-01-05",
};
it("fixed live date excludes termination day; prior balance and cross-day stay stable", () => {
  const first = calculateCancelLine(live);
  expect(first).toMatchObject({
    mode: "refund",
    refundPoints: 50,
    deductPoints: 30,
    ratioBp: null,
  });
  expect(
    calculateCancelLine({ ...live, at: new Date("2026-01-11T04:00:00Z"), step: "takedown" }),
  ).toEqual(first);
});
it("last live day becomes zero terminate_only; merchant is blocked", () => {
  expect(calculateCancelLine({ ...live, terminationDate: "2026-01-10" })).toMatchObject({
    mode: "terminate_only",
    refundPoints: 0,
    deductPoints: 80,
  });
  expect(calculateCancelLine({ ...live, reasonCode: "merchant_request" })).toEqual({
    blocker: "live_not_refundable",
  });
});
it.each(["2025-12-31", "2026-01-11"])("live date %s rejects", (terminationDate) => {
  expect(() => calculateCancelLine({ ...live, terminationDate })).toThrow();
});
it("never-live takedown expires; missing/unknown facts never become release or zero", () => {
  expect(calculateCancelLine({ ...base, step: "takedown" })).toEqual({ blocker: "item_expired" });
  for (const changed of [
    { step: null },
    { step: "unknown" },
    { priorRequestedPoints: 106 },
    { reasonCode: "qualification_final" as const },
  ])
    expect(() => calculateCancelLine({ ...base, ...changed })).toThrow();
});
