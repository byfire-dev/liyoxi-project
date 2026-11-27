import { z } from "zod";
import { record } from "../audit/index.js";
import { createActor } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import {
  LegacyRecoveryInputSchema,
  recoverLegacyDailySnapshot,
  subscriptionInvariants,
} from "../billing/index.js";
import type { LegacyRecoveryInput } from "../billing/index.js";
import { addDays, calendarDate } from "@liyoxi/shared/time";

/** Exact five findings evidenced before the user-authorized 2026-11-27 repair. */
export const LEGACY_RECOVERY_FINDING_IDS = [
  "01a20f09-5cfc-73bd-a9bb-63f1d76b89dc",
  "01a20f09-5cfc-73be-afca-19b4aea5f343",
  "01a20f09-5d1a-76be-b736-038bf0ddb4a7",
  "01a2142f-de33-700b-ba81-787dad6744cb",
  "01a21956-209a-7444-b1d1-07bb4b471927",
] as const;
const detailSchema = z.object({
  entityId: z.uuid(),
  problem: z.enum(["valuation_missing", "history_snapshot_missing"]),
  pointLedgerEntryId: z.uuid().optional(),
});

/** Explicit operator resolution, never auto-healing money or closing alert rows. */
export async function resolveLegacyRecoveryFindings(tx: Tx, raw: LegacyRecoveryInput, at: Date) {
  const input = LegacyRecoveryInputSchema.parse(raw);
  if (!input.apply || !input.evidenceHash || !input.payloadHash)
    throw new Error("LEGACY_RECOVERY_EXPECTED_HASHES_REQUIRED");
  const supplement = await tx.subscriptionEventDailySupplement.findUnique({
    where: { eventId: input.eventId },
  });
  if (!supplement) throw new Error("LEGACY_RECOVERY_SUPPLEMENT_REQUIRED");
  // Reuses active authorizer, original-event/evidence/hash validation and account lock.
  await recoverLegacyDailySnapshot(tx, input, at);
  const checks = subscriptionInvariants.filter((check) =>
    ["billing.I11", "billing.I13"].includes(check.code),
  );
  if (checks.length !== 2) throw new Error("LEGACY_RECOVERY_CHECKS_UNAVAILABLE");
  for (const check of checks) {
    if (
      !check.run ||
      (await check.run(tx, { entityIds: [supplement.entityId] }, { now: at })).length
    )
      throw new Error("LEGACY_RECOVERY_CHECKS_FAILED");
  }
  // Ops technical rows are outside the business lock table. Account locking
  // serializes this repair; lock only these technical rows, in UUID order, last.
  await tx.$queryRawUnsafe(
    "SELECT id FROM invariant_violation WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [...LEGACY_RECOVERY_FINDING_IDS],
  );
  const rows = await tx.invariantViolation.findMany({
    where: { id: { in: [...LEGACY_RECOVERY_FINDING_IDS] } },
    orderBy: { id: "asc" },
  });
  if (rows.length !== LEGACY_RECOVERY_FINDING_IDS.length)
    throw new Error("LEGACY_RECOVERY_FINDINGS_INCOMPLETE");
  const through = addDays(calendarDate(at), -1);
  for (const row of rows) {
    const detail = detailSchema.parse(row.detail);
    if (
      row.module !== "billing" ||
      row.severity !== "P1" ||
      detail.entityId !== supplement.entityId
    )
      throw new Error("LEGACY_RECOVERY_FINDING_SCOPE_INVALID");
    if (row.code === "billing.I11" && detail.problem === "valuation_missing") {
      const entry = detail.pointLedgerEntryId
        ? await tx.pointLedgerEntry.findUnique({ where: { id: detail.pointLedgerEntryId } })
        : null;
      if (
        !entry ||
        entry.entityId !== supplement.entityId ||
        row.subjectType !== "point_lot" ||
        row.subjectId !== entry.pointLotId ||
        row.subjectKey !== null
      )
        throw new Error("LEGACY_RECOVERY_FINDING_SCOPE_INVALID");
    } else if (row.code === "billing.I13" && detail.problem === "history_snapshot_missing") {
      const date = row.subjectKey?.slice(0, 10);
      if (
        row.subjectType !== "billing_entity_daily" ||
        row.subjectId !== null ||
        !date ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        date > through ||
        row.subjectKey !== `${date}:${supplement.entityId}`
      )
        throw new Error("LEGACY_RECOVERY_FINDING_SCOPE_INVALID");
    } else throw new Error("LEGACY_RECOVERY_FINDING_SCOPE_INVALID");
  }
  const pending = rows.filter((row) => row.resolvedAt === null);
  if (!pending.length)
    return { status: "already_resolved" as const, resolved: 0, checked: checks.map((c) => c.code) };
  const resolution = `已验证授权补充记录及正式日投影；billing.I11/I13 均无违规。source=${input.sourceSha}; evidence=${input.evidenceHash}; payload=${input.payloadHash}`;
  for (const row of pending) {
    await tx.invariantViolation.update({
      where: { id: row.id },
      data: {
        resolvedAt: at,
        resolvedByStaffId: input.authorizedByStaffId,
        resolution,
        updatedAt: at,
      },
    });
  }
  await record(
    tx,
    createActor({ type: "system", job: "cli.legacy_snapshot_recovery" }),
    { requestId: null, ip: null, userAgent: null, authMethod: null, sessionId: null },
    {
      stream: "ops",
      category: "system_ops",
      action: "ops.invariant.resolve_legacy_recovery",
      entityId: supplement.entityId,
      target: { type: "invariant_violation", id: pending[0]!.id },
      summary: "复核 I11/I13 通过后填写固定旧历史违规处理结论",
      reason: {
        code: "legacy_snapshot_recovery",
        text: `${input.operator}; authorizedBy=${input.authorizedByStaffId}; ${input.reason}`,
      },
      before: { unresolvedIds: pending.map((row) => row.id) },
      after: {
        resolvedIds: pending.map((row) => row.id),
        checked: checks.map((c) => c.code),
        sourceSha: input.sourceSha,
        evidenceHash: input.evidenceHash,
        payloadHash: input.payloadHash,
      },
      fields: ["resolvedAt", "resolvedByStaffId", "resolution"],
    },
  );
  return {
    status: "resolved" as const,
    resolved: pending.length,
    checked: checks.map((c) => c.code),
  };
}
