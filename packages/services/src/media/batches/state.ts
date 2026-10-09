import type { UploadBatchCoverage } from "@liyoxi/contract";

export interface BatchItemFacts {
  readonly id: string;
  readonly episodeNo: number | null;
  readonly matchMethod: string | null;
  readonly state: string;
}
export const activeItems = <T extends BatchItemFacts>(items: readonly T[]): readonly T[] =>
  items.filter((item) => !["skipped", "replaced"].includes(item.state));

/** Coverage always uses the registered count; skipped/replaced history cannot fill a gap. */
export function batchCoverage(
  items: readonly BatchItemFacts[],
  expectedCount: number,
  scope: string,
  requireSequence: boolean,
): UploadBatchCoverage {
  const current = activeItems(items),
    counts = new Map<number, number>(),
    unmatchedItemIds: string[] = [];
  for (const item of current) {
    const no = item.episodeNo;
    if (no === null || !Number.isSafeInteger(no) || no < 1 || no > expectedCount)
      unmatchedItemIds.push(item.id);
    else counts.set(no, (counts.get(no) ?? 0) + 1);
  }
  return {
    missingEpisodeNos:
      scope === "full"
        ? Array.from({ length: expectedCount }, (_, i) => i + 1).filter((no) => !counts.has(no))
        : [],
    duplicateEpisodeNos: [...counts]
      .filter(([, count]) => count > 1)
      .map(([no]) => no)
      .sort((a, b) => a - b),
    unmatchedItemIds: unmatchedItemIds.sort(),
    needsSequenceConfirm:
      requireSequence && current.some((item) => item.matchMethod === "sequence"),
  };
}
export const coverageComplete = (coverage: UploadBatchCoverage): boolean =>
  !coverage.missingEpisodeNos.length &&
  !coverage.duplicateEpisodeNos.length &&
  !coverage.unmatchedItemIds.length &&
  !coverage.needsSequenceConfirm;

/** Shared by employee skip/replace and worker completion, in the same parent-locked TX. */
export function decideBatchState(
  batch: { readonly state: string; readonly expectedCount: number; readonly scope: string },
  items: readonly BatchItemFacts[],
): string {
  if (!["uploading", "verifying", "ready"].includes(batch.state)) return batch.state;
  const current = activeItems(items);
  if (current.some((item) => item.state === "pending")) return "uploading";
  if (current.some((item) => item.state === "rejected")) return batch.state;
  if (
    !current.length ||
    !coverageComplete(batchCoverage(items, batch.expectedCount, batch.scope, false))
  )
    return "verifying";
  return current.every((item) => item.state === "checked") ? "ready" : "verifying";
}

export function activeExpiry(createdAt: Date, now: Date): Date {
  return new Date(
    Math.min(now.getTime() + 72 * 60 * 60 * 1000, createdAt.getTime() + 7 * 24 * 60 * 60 * 1000),
  );
}
