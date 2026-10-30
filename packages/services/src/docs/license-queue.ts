import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import type { LicenseLetter, LicenseLetterRevision } from "@liyoxi/db";
import { AppError, createIdentityContext, lockRows } from "../kernel/index.js";
import type { Clock, DeliveredEvent, IdentityContext, Tx } from "../kernel/index.js";
import type { Events } from "../events/index.js";
import type { LicenseFactPort, LicenseLetterSnapshot } from "./license-facts.js";
import { parseLicenseLetterSnapshot } from "./license-facts.js";
import { licenseContentFingerprint, licenseLetterMatchesFacts } from "./license-convergence.js";
import { recordLicenseRenderResult } from "./license-render-result.js";
import type { LicenseRenderIssue } from "./license-render-result.js";

export const LICENSE_RENDER_MAX_ATTEMPTS = 4;
export const LICENSE_RENDER_LEASE_MS = 5 * 60_000;
export interface LicenseRenderFilePort {
  /** Runs after order/item/letter locks; validate sha/owner/category and link the permanent PDF at file rank410. */
  assertAndLink(tx: Tx, input: {
    fileId: string; sha256: string; revisionId: string; entityId: string; storeId: string;
  }): Promise<void>;
}
export interface LicenseRenderQueueDeps {
  readonly clock: Clock;
  readonly facts: LicenseFactPort;
  readonly events: Pick<Events, "emit">;
  readonly files: LicenseRenderFilePort;
  readonly readLastClaimLease: (tx: Tx, input: {
    licenseLetterId: string; revisionId: string; entityId: string; storeId: string;
  }) => Promise<Date | null>;
  readonly assertOpen?: () => void;
}
export type LicenseRevisionWriteDeps = Pick<LicenseRenderQueueDeps, "clock" | "facts" | "events" | "readLastClaimLease" | "assertOpen">;
export interface LicenseRenderClaim {
  readonly revisionId: string;
  readonly licenseLetterId: string;
  readonly orderItemId: string;
  readonly entityId: string;
  readonly storeId: string;
  readonly letterNo: string;
  readonly revNo: number;
  readonly attempt: number;
  readonly leaseUntil: Date;
  readonly letterLockVersion: number;
  readonly snapshot: LicenseLetterSnapshot;
  readonly contentFp: string;
  readonly templateVersion: string;
}
export type LicenseRenderCompletion = {
  readonly fileId: string;
  readonly pdfSha256: string;
  readonly platformSignedAt: Date;
} & (
  | { readonly signMode: "platform_cert"; readonly certIssuer: string; readonly certSerial: string }
  | { readonly signMode: "stamp" }
  | { readonly signMode: "esign_seal"; readonly certIssuer: string; readonly certSerial: string;
      readonly esignProvider: string; readonly esignFlowId: string }
);
const workerContext = () => createIdentityContext({ actor: { type: "system", job: "docs.render" } });
async function lockRevision(tx: Tx, deps: LicenseRevisionWriteDeps, id: string) {
  deps.assertOpen?.();
  const ref = await tx.licenseLetterRevision.findUnique({
    where: { id }, include: { licenseLetter: { select: { orderItemId: true } } },
  });
  if (!ref) return null;
  const facts = await deps.facts.getLicenseFacts(tx, [ref.licenseLetter.orderItemId]);
  await lockRows(tx, "license_letter", [ref.licenseLetterId]);
  const revision = await tx.licenseLetterRevision.findUnique({ where: { id } });
  const letter = await tx.licenseLetter.findUnique({ where: { id: ref.licenseLetterId } });
  deps.assertOpen?.();
  return revision && letter ? { revision, letter, facts: facts[0] } : null;
}
async function retireRevision(tx: Tx, revision: LicenseLetterRevision, letter: LicenseLetter, now: Date) {
  await tx.licenseLetterRevision.update({ where: { id: revision.id }, data: {
    renderStatus: "failed", renderLeaseUntil: null, updatedAt: now,
  } });
  await recordLicenseRenderResult(tx, workerContext(), {
    licenseLetterId: letter.id, revisionId: revision.id, entityId: letter.entityId, storeId: letter.storeId,
    fence: { attempt: revision.renderAttemptNo, leaseUntil: revision.renderLeaseUntil },
    outcome: letter.status === "voided" ? "voided" : "failed",
  });
}
const sameFence = (revision: LicenseLetterRevision, claim: LicenseRenderClaim, now: Date) =>
  revision.licenseLetterId === claim.licenseLetterId && revision.renderStatus === "rendering" &&
  revision.renderAttemptNo === claim.attempt &&
  revision.renderLeaseUntil?.getTime() === claim.leaseUntil.getTime() &&
  claim.leaseUntil > now;

/** Call only when renderer, fixed template and signer are configured; no external calls in this writer. */
export async function claimLicenseRevision(
  tx: Tx, deps: LicenseRevisionWriteDeps, revisionId: string,
): Promise<LicenseRenderClaim | null> {
  const row = await lockRevision(tx, deps, revisionId), now = deps.clock.now();
  if (!row || row.revision.renderStatus !== "queued" ||
    row.revision.renderAttemptNo >= LICENSE_RENDER_MAX_ATTEMPTS) return null;
  if (!row.facts || !licenseLetterMatchesFacts(row.letter, row.facts)) {
    await retireRevision(tx, row.revision, row.letter, now);
    return null;
  }
  const snapshot = parseLicenseLetterSnapshot(row.revision.letterSnapshot);
  if (licenseContentFingerprint(snapshot) !== row.revision.contentFp)
    throw new AppError("PRECONDITION_CHANGED", { message: "授权版次指纹不一致" });
  if (snapshot.period.start !== row.facts.usageStartDate || snapshot.period.end !== row.facts.usageEndDate) {
    await retireRevision(tx, row.revision, row.letter, now);
    return null;
  }
  // A reset under a frozen test clock must not reproduce a previous claim's lease (ABA).
  const lastLease = await deps.readLastClaimLease(tx, {
    licenseLetterId: row.letter.id, revisionId, entityId: row.letter.entityId, storeId: row.letter.storeId,
  });
  const leaseUntil = new Date(Math.max(now.getTime() + LICENSE_RENDER_LEASE_MS,
    lastLease ? lastLease.getTime() + 1 : 0));
  const attempt = row.revision.renderAttemptNo + 1;
  const changed = await tx.licenseLetterRevision.updateMany({
    where: { id: revisionId, renderStatus: "queued", renderAttemptNo: row.revision.renderAttemptNo },
    data: { renderStatus: "rendering", renderAttemptNo: attempt, renderLeaseUntil: leaseUntil, updatedAt: now },
  });
  if (changed.count !== 1) return null;
  const claim: LicenseRenderClaim = {
    revisionId, licenseLetterId: row.letter.id, orderItemId: row.letter.orderItemId,
    entityId: row.letter.entityId, storeId: row.letter.storeId,
    letterNo: row.letter.letterNo, revNo: row.revision.revNo, attempt, leaseUntil,
    letterLockVersion: row.letter.lockVersion, snapshot,
    contentFp: row.revision.contentFp, templateVersion: row.revision.templateVersion,
  };
  await recordLicenseRenderResult(tx, workerContext(), { ...claim, fence: claim, outcome: "started" });
  return claim;
}

/** Returns false for any late/expired/obsolete claim before touching its uploaded file. */
export async function completeLicenseRevision(
  tx: Tx, deps: LicenseRenderQueueDeps, claim: LicenseRenderClaim, result: LicenseRenderCompletion,
): Promise<boolean> {
  const row = await lockRevision(tx, deps, claim.revisionId), now = deps.clock.now();
  if (!row || !sameFence(row.revision, claim, now)) return false;
  if (!row.facts || row.letter.lockVersion !== claim.letterLockVersion ||
    !licenseLetterMatchesFacts(row.letter, row.facts) || row.revision.contentFp !== claim.contentFp ||
    row.revision.revNo !== claim.revNo || row.revision.templateVersion !== claim.templateVersion ||
    claim.snapshot.period.start !== row.facts.usageStartDate || claim.snapshot.period.end !== row.facts.usageEndDate) {
    await retireRevision(tx, row.revision, row.letter, now);
    return false;
  }
  if (!/^[0-9a-f]{64}$/.test(result.pdfSha256) || !Number.isFinite(result.platformSignedAt.getTime()) ||
    (result.signMode !== "stamp" && (!result.certIssuer.trim() || !result.certSerial.trim())))
    throw new AppError("PRECONDITION_CHANGED", { message: "授权签署结果不完整" });
  const changed = await tx.licenseLetterRevision.updateMany({
    where: { id: claim.revisionId, renderStatus: "rendering", renderAttemptNo: claim.attempt,
      renderLeaseUntil: claim.leaseUntil },
    data: {
      renderStatus: "ready", fileId: result.fileId, pdfSha256: result.pdfSha256,
      signMode: result.signMode, platformSignedAt: result.platformSignedAt,
      certIssuer: result.signMode === "stamp" ? null : result.certIssuer,
      certSerial: result.signMode === "stamp" ? null : result.certSerial,
      esignProvider: result.signMode === "esign_seal" ? result.esignProvider : null,
      esignFlowId: result.signMode === "esign_seal" ? result.esignFlowId : null,
      renderLeaseUntil: null, readyAt: now, updatedAt: now,
    },
  });
  if (changed.count !== 1) return false;
  await deps.files.assertAndLink(tx, { fileId: result.fileId, sha256: result.pdfSha256,
    revisionId: claim.revisionId, entityId: row.letter.entityId, storeId: row.letter.storeId });
  const current = row.letter.currentRevisionId ? await tx.licenseLetterRevision.findUnique({
    where: { id: row.letter.currentRevisionId }, select: { revNo: true },
  }) : null;
  if (!current || current.revNo < row.revision.revNo) await tx.licenseLetter.update({
    where: { id: row.letter.id }, data: { currentRevisionId: claim.revisionId, updatedAt: now },
  });
  const ctx = workerContext();
  await recordLicenseRenderResult(tx, ctx, { ...claim, fence: claim, outcome: "ready" });
  await deps.events.emit(tx, ctx, {
    type: "license_letter.issued", aggregate: { type: "license_letter", id: row.letter.id },
    payload: { v: 1, licenseLetterId: row.letter.id, revisionId: claim.revisionId, revNo: claim.revNo },
    entityId: row.letter.entityId, storeId: row.letter.storeId,
  });
  deps.assertOpen?.();
  return true;
}

/** Deterministic missing glyphs stop this revision immediately; transient failures keep the four-attempt budget. */
export async function failLicenseRevision(
  tx: Tx, deps: LicenseRevisionWriteDeps, claim: LicenseRenderClaim, issue?: LicenseRenderIssue,
): Promise<"stale" | "queued" | "failed"> {
  const row = await lockRevision(tx, deps, claim.revisionId), now = deps.clock.now();
  if (!row || !sameFence(row.revision, claim, now)) return "stale";
  if (!row.facts || row.letter.lockVersion !== claim.letterLockVersion || !licenseLetterMatchesFacts(row.letter, row.facts)) {
    await retireRevision(tx, row.revision, row.letter, now);
    return "failed";
  }
  const status = issue || claim.attempt >= LICENSE_RENDER_MAX_ATTEMPTS ? "failed" : "queued";
  await tx.licenseLetterRevision.update({ where: { id: claim.revisionId }, data: {
    renderStatus: status, renderLeaseUntil: issue ? claim.leaseUntil : null, updatedAt: now,
  } });
  await recordLicenseRenderResult(tx, workerContext(), { ...claim, fence: claim, outcome: "failed", ...(issue ? { issue } : {}) });
  return status;
}

export async function rerenderLicenseRevision(
  tx: Tx, deps: LicenseRevisionWriteDeps, ctx: IdentityContext, input: { revisionId: string },
) {
  const row = await lockRevision(tx, deps, input.revisionId);
  if (!row) throw new AppError("NOT_FOUND");
  if (row.revision.renderStatus !== "failed" || row.letter.status === "voided")
    throw new AppError("STATE_NOT_ALLOWED");
  await tx.licenseLetterRevision.update({ where: { id: input.revisionId }, data: {
    renderStatus: "queued", renderAttemptNo: 0, renderLeaseUntil: null, updatedAt: deps.clock.now(),
  } });
  await recordLicenseRenderResult(tx, ctx, {
    licenseLetterId: row.letter.id, revisionId: input.revisionId, entityId: row.letter.entityId,
    storeId: row.letter.storeId, fence: { attempt: row.revision.renderAttemptNo, leaseUntil: row.revision.renderLeaseUntil }, outcome: "rerender",
  });
  await deps.events.emit(tx, ctx, {
    type: "license_letter.revision_queued", aggregate: { type: "license_letter", id: row.letter.id },
    payload: EVENT_PAYLOAD_SCHEMAS["license_letter.revision_queued"].parse({
      v: 1, licenseLetterId: row.letter.id, revisionId: input.revisionId, reason: row.revision.reason,
    }),
    entityId: row.letter.entityId, storeId: row.letter.storeId,
  });
  return { revisionId: input.revisionId };
}

export async function readQueuedLicenseRevision(tx: Tx, event: DeliveredEvent) {
  const id = event.payload.revisionId;
  if (event.type !== "license_letter.revision_queued" || typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new AppError("VALIDATION_FAILED");
  const row = await tx.licenseLetterRevision.findUnique({ where: { id },
    select: { id: true, licenseLetterId: true, renderStatus: true, renderAttemptNo: true } });
  if (!row || row.licenseLetterId !== event.payload.licenseLetterId) throw new AppError("NOT_FOUND");
  return row.renderStatus === "queued" ? { revisionId: row.id, attemptNo: row.renderAttemptNo } : null;
}

/** Small transaction batches; caller enqueues returned refs and raises alerts only after commit. */
export async function sweepLicenseRevisions(tx: Tx, deps: LicenseRevisionWriteDeps, signal?: AbortSignal) {
  const now = deps.clock.now();
  const candidates = await tx.licenseLetterRevision.findMany({
    where: { OR: [
      { renderStatus: "queued", createdAt: { lte: new Date(now.getTime() - 120_000) } },
      { renderStatus: "rendering", renderLeaseUntil: { lte: now } },
    ] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100,
    select: { id: true },
  });
  // Never lock letter240 before a later item170: acquire the full item and letter batch first.
  const refs = await tx.licenseLetterRevision.findMany({ where: { id: { in: candidates.map((r) => r.id) } },
    include: { licenseLetter: { select: { orderItemId: true } } } });
  const ids = [...new Set(refs.map((r) => r.licenseLetter.orderItemId))].sort();
  const facts = ids.length ? await deps.facts.getLicenseFacts(tx, ids) : [];
  await lockRows(tx, "license_letter", [...new Set(refs.map((r) => r.licenseLetterId))].sort());
  const requeue: { revisionId: string; attemptNo: number }[] = [], failed: string[] = [];
  for (const ref of refs) {
    signal?.throwIfAborted();
    const row = await tx.licenseLetterRevision.findUnique({ where: { id: ref.id } });
    if (!row) continue;
    const letter = await tx.licenseLetter.findUniqueOrThrow({ where: { id: row.licenseLetterId } });
    const fact = facts.find((item) => item.orderItemId === letter.orderItemId);
    const snapshot = parseLicenseLetterSnapshot(row.letterSnapshot);
    if (["queued", "rendering"].includes(row.renderStatus) && (!fact || !licenseLetterMatchesFacts(letter, fact) ||
      snapshot.period.start !== fact.usageStartDate || snapshot.period.end !== fact.usageEndDate)) {
      await retireRevision(tx, row, letter, now);
      continue;
    }
    if (row.renderStatus === "rendering" && row.renderLeaseUntil && row.renderLeaseUntil <= now) {
      const status = row.renderAttemptNo >= LICENSE_RENDER_MAX_ATTEMPTS ? "failed" : "queued";
      await tx.licenseLetterRevision.update({ where: { id: row.id }, data: {
        renderStatus: status, renderLeaseUntil: null, updatedAt: now,
      } });
      await recordLicenseRenderResult(tx, workerContext(), { licenseLetterId: letter.id,
        revisionId: row.id, entityId: letter.entityId, storeId: letter.storeId,
        fence: { attempt: row.renderAttemptNo, leaseUntil: row.renderLeaseUntil }, outcome: "failed" });
      if (status === "failed") failed.push(row.id);
      else requeue.push({ revisionId: row.id, attemptNo: row.renderAttemptNo });
    } else if (row.renderStatus === "queued" && row.createdAt.getTime() <= now.getTime() - 120_000)
      requeue.push({ revisionId: row.id, attemptNo: row.renderAttemptNo });
  }
  return { requeue, failed };
}

/** Subscriber stays DB-only; the dispatcher calls the same read before its external enqueue hook. */
export async function onLicenseRevisionQueued(tx: Tx, event: DeliveredEvent): Promise<void> {
  await readQueuedLicenseRevision(tx, event);
}
