import type { Prisma } from "@liyoxi/db";
import { record } from "../../audit/index.js";
import { createActor } from "../../kernel/index.js";
import { z } from "zod";
import type { Tx } from "../../kernel/index.js";
import { lockRows, uuidv7 } from "../../kernel/index.js";
import { readLegacyEvidence } from "./legacy-read-evidence.js";
import { assertLegacyEventEvidence, resolveLegacyDailyPayload } from "./legacy-supplement.js";
import {
  legacyHash,
  LEGACY_BASELINE_SHA,
  LEGACY_EVENT_ID,
  reconstructLegacySnapshot,
} from "./legacy-reconstruction.js";

export const LegacyRecoveryInputSchema = z
  .object({
    eventId: z.literal(LEGACY_EVENT_ID),
    apply: z.boolean().default(false),
    evidenceHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    payloadHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    authorizedByStaffId: z.uuid(),
    operator: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(1000),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();
export type LegacyRecoveryInput = z.infer<typeof LegacyRecoveryInputSchema>;

/** Only app-owned account lock, no advance(), backdated actor, or writes to any original financial fact. */
export async function recoverLegacyDailySnapshot(tx: Tx, raw: LegacyRecoveryInput, at: Date) {
  const input = LegacyRecoveryInputSchema.parse(raw);
  if (!Number.isFinite(at.getTime())) throw new Error("LEGACY_RECOVERY_TIME_INVALID");
  if (input.apply && (!input.evidenceHash || !input.payloadHash))
    throw new Error("LEGACY_RECOVERY_EXPECTED_HASHES_REQUIRED");
  await lockRows(tx, "staff", [input.authorizedByStaffId], "share");
  const authorizer = await tx.staff.findUnique({ where: { id: input.authorizedByStaffId } });
  if (authorizer?.status !== "active" || authorizer.staffRoleKey !== "super_admin")
    throw new Error("LEGACY_RECOVERY_AUTHORIZER_INVALID");
  const event = await tx.subscriptionEvent.findUniqueOrThrow({ where: { id: input.eventId } });
  const orders = await tx.billingOrder.findMany({
    where: { entityId: event.entityId },
    select: { id: true },
  });
  await lockRows(
    tx,
    "billing_order",
    orders.map((row) => row.id),
  );
  const payments = await tx.paymentTxn.findMany({
    where: { entityId: event.entityId },
    select: { id: true },
  });
  await lockRows(
    tx,
    "payment_txn",
    payments.map((row) => row.id),
  );
  await lockRows(tx, "billing_account", [event.entityId]);
  const existing = await tx.subscriptionEventDailySupplement.findUnique({
    where: { eventId: event.id },
  });
  if (existing) {
    resolveLegacyDailyPayload(event, [existing]);
    if (
      input.apply &&
      (existing.evidenceHash !== input.evidenceHash || existing.payloadHash !== input.payloadHash)
    )
      throw new Error("LEGACY_RECOVERY_REPLAY_CONFLICT");
    return {
      status: "already_applied" as const,
      eventId: event.id,
      evidenceHash: existing.evidenceHash,
      payloadHash: existing.payloadHash,
    };
  }
  const evidence = await readLegacyEvidence(tx);
  assertLegacyEventEvidence(event, evidence.event);
  const payload = reconstructLegacySnapshot(evidence);
  const evidenceHash = legacyHash(evidence),
    payloadHash = legacyHash(payload);
  if (
    (input.evidenceHash && evidenceHash !== input.evidenceHash) ||
    (input.payloadHash && payloadHash !== input.payloadHash)
  )
    throw new Error("LEGACY_RECOVERY_FRESH_EVIDENCE_CHANGED");
  if (!input.apply)
    return { status: "preview" as const, eventId: event.id, evidenceHash, payloadHash };
  if (at < event.occurredAt) throw new Error("LEGACY_RECOVERY_TIME_INVALID");
  await tx.subscriptionEventDailySupplement.create({
    data: {
      id: uuidv7(),
      eventId: event.id,
      entityId: event.entityId,
      subscriptionTermId: event.subscriptionTermId,
      eventFingerprint: legacyHash(event),
      payload,
      payloadHash,
      evidence: JSON.parse(JSON.stringify(evidence)) as Prisma.InputJsonObject,
      evidenceHash,
      strategy: "legacy_activation_v1",
      sourceSha: input.sourceSha,
      baselineSha: LEGACY_BASELINE_SHA,
      authorizedByStaffId: input.authorizedByStaffId,
      operator: input.operator,
      reason: input.reason,
      createdAt: at,
    },
  });
  await record(
    tx,
    createActor({ type: "system", job: "cli.legacy_snapshot_recovery" }),
    { requestId: null, ip: null, userAgent: null, authMethod: null, sessionId: null },
    {
      stream: "ops",
      category: "system_ops",
      action: "billing.subscription.recover_snapshot",
      entityId: event.entityId,
      target: { type: "billing_order", id: event.billingOrderId! },
      summary: "依据授权追加旧订阅日快照；原收款和积分事实保持不变",
      reason: {
        code: "legacy_snapshot_recovery",
        text: `${input.operator}; authorizedBy=${input.authorizedByStaffId}; ${input.reason}`,
      },
      before: null,
      after: { eventId: event.id, evidenceHash, payloadHash, sourceSha: input.sourceSha },
      fields: ["eventId", "evidenceHash", "payloadHash", "sourceSha"],
    },
  );
  return { status: "applied" as const, eventId: event.id, evidenceHash, payloadHash };
}
