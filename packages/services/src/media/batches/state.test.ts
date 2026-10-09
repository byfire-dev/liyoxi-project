import { expect, it } from "vitest";
import { activeExpiry, batchCoverage, coverageComplete, decideBatchState } from "./state.js";
const full = { state: "uploading", expectedCount: 20, scope: "full" };
const items = Array.from({ length: 20 }, (_, i) => ({
  id: `item${i + 1}`,
  episodeNo: i + 1,
  matchMethod: "pattern",
  state: "checked",
}));
it("requires all twenty genuine active checked episodes; skipped and replaced history cannot fill gaps", () => {
  expect(decideBatchState(full, items)).toBe("ready");
  const skipped = items.map((item, i) => (i === 19 ? { ...item, state: "skipped" } : item));
  expect(batchCoverage(skipped, 20, "full", false).missingEpisodeNos).toEqual([20]);
  expect(decideBatchState(full, skipped)).toBe("verifying");
  expect(coverageComplete(batchCoverage(items.slice(0, 19), 20, "full", false))).toBe(false);
});
it("reconciles pending replacement, uploaded work and the final checked result through one decision", () => {
  const partial = { state: "ready", expectedCount: 20, scope: "partial" };
  expect(decideBatchState(partial, [{ ...items[0]!, state: "pending" }])).toBe("uploading");
  expect(
    decideBatchState({ ...partial, state: "uploading" }, [{ ...items[0]!, state: "uploaded" }]),
  ).toBe("verifying");
  expect(decideBatchState({ ...partial, state: "verifying" }, [items[0]!])).toBe("ready");
  expect(
    decideBatchState({ ...partial, state: "verifying" }, [{ ...items[0]!, state: "rejected" }]),
  ).toBe("verifying");
  expect(decideBatchState(partial, [{ ...items[0]!, state: "skipped" }])).toBe("verifying");
});
it("rejects duplicate and invalid mappings and asks sequence confirmation only while matching", () => {
  const conflict = [
    items[0]!,
    { ...items[1]!, episodeNo: 1 },
    { ...items[2]!, episodeNo: 21 },
    { ...items[3]!, episodeNo: null, matchMethod: "sequence" },
  ];
  const coverage = batchCoverage(conflict, 20, "partial", true);
  expect(coverage.duplicateEpisodeNos).toEqual([1]);
  expect(coverage.unmatchedItemIds).toEqual(["item3", "item4"]);
  expect(coverage.needsSequenceConfirm).toBe(true);
  expect(coverageComplete(coverage)).toBe(false);
  expect(
    batchCoverage([{ ...items[0]!, matchMethod: "sequence" }], 20, "partial", false)
      .needsSequenceConfirm,
  ).toBe(false);
});
it("never resurrects terminal batches and caps each activity extension at seven days", () => {
  for (const state of ["matching", "committed", "canceled", "expired"])
    expect(decideBatchState({ ...full, state }, items)).toBe(state);
  const created = new Date("2026-10-01T00:00:00Z");
  expect(activeExpiry(created, new Date("2026-10-02T00:00:00Z")).toISOString()).toBe(
    "2026-10-05T00:00:00.000Z",
  );
  expect(activeExpiry(created, new Date("2026-10-07T00:00:00Z")).toISOString()).toBe(
    "2026-10-08T00:00:00.000Z",
  );
});
