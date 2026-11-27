import type { SubscriptionEvent, SubscriptionEventDailySupplement } from "@liyoxi/db";
import { LegacyEvidenceSchema } from "./legacy-evidence-schema.js";
import {
  canonicalLegacyJson,
  legacyHash,
  LEGACY_BASELINE_SHA,
  LEGACY_EVENT_ID,
  reconstructLegacySnapshot,
} from "./legacy-reconstruction.js";

/** SQL evidence stores dates as PostgreSQL text; compare every archived event column canonically. */
export function assertLegacyEventEvidence(
  event: SubscriptionEvent,
  archived: Record<string, unknown>,
): void {
  const current = event as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(archived)) {
    const field = key.replace(/_([a-z])/g, (_all: string, letter: string) => letter.toUpperCase());
    const expected = current[field];
    let same: boolean;
    if (expected instanceof Date && typeof value === "string") {
      same = expected.getTime() === Date.parse(value);
    } else if (key === "seq") {
      same = String(expected) === String(value);
    } else {
      same = canonicalLegacyJson(expected) === canonicalLegacyJson(value);
    }
    if (!same) throw new Error("LEGACY_RECOVERY_EVENT_EVIDENCE_MISMATCH");
  }
}

/** Shared by daily sweep and I13 through computeEntityDaily. Never reads current mutable balances as history. */
export function resolveLegacyDailyPayload(
  event: SubscriptionEvent,
  supplements: readonly SubscriptionEventDailySupplement[],
): SubscriptionEvent["payload"] {
  if (supplements.length === 0) return event.payload;
  const record = supplements[0]!;
  if (
    supplements.length !== 1 ||
    event.id !== LEGACY_EVENT_ID ||
    event.payload !== null ||
    event.type !== "activated" ||
    record.eventId !== event.id ||
    record.entityId !== event.entityId ||
    record.subscriptionTermId !== event.subscriptionTermId ||
    record.eventFingerprint !== legacyHash(event) ||
    record.strategy !== "legacy_activation_v1" ||
    record.baselineSha !== LEGACY_BASELINE_SHA ||
    record.createdAt < event.occurredAt ||
    record.payloadHash !== legacyHash(record.payload) ||
    record.evidenceHash !== legacyHash(record.evidence)
  )
    throw new Error("LEGACY_RECOVERY_SUPPLEMENT_INVALID");
  const evidence = LegacyEvidenceSchema.parse(record.evidence);
  assertLegacyEventEvidence(event, evidence.event);
  const reconstructed = reconstructLegacySnapshot(evidence);
  if (legacyHash(reconstructed) !== record.payloadHash)
    throw new Error("LEGACY_RECOVERY_CANDIDATE_MISMATCH");
  return record.payload;
}
