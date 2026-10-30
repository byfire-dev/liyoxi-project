import type { InvariantScope, InvariantViolation, Tx } from "../kernel/index.js";
import type { LicenseConvergenceDeps, LicenseFacts } from "./license-facts.js";
import { licenseEligible, reconcileLetters } from "./license-convergence.js";

const day = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
const ownership = (
  letter: { dramaOrderId: string; entityId: string; storeId: string; dramaId: string },
  item: Omit<LicenseFacts, "accounts">,
) =>
  letter.dramaOrderId === item.orderId &&
  letter.entityId === item.entityId &&
  letter.storeId === item.storeId &&
  letter.dramaId === item.dramaId;

/** Includes current candidates without any letter, as well as old letters whose item became terminal. */
export async function findN6Violations(
  tx: Tx,
  deps: LicenseConvergenceDeps,
  scope: InvariantScope = {},
): Promise<InvariantViolation[]> {
  deps.assertOpen?.();
  const existing = await tx.licenseLetter.findMany({
    where: {
      status: { not: "voided" },
      ...(scope.entityIds ? { entityId: { in: [...scope.entityIds] } } : {}),
    },
    orderBy: { id: "asc" },
  });
  const all = new Set(existing.map((letter) => letter.orderItemId));
  let cursor: string | undefined;
  for (;;) {
    const page = await deps.facts.listCandidateIds(tx, {
      cursor,
      limit: 200,
      entityIds: scope.entityIds,
    });
    for (const id of page) all.add(id);
    if (page.length < 200) break;
    const next = page.at(-1)!;
    if (next === cursor) throw new TypeError("授权候选分页未前进");
    cursor = next;
  }
  const ids = [...all].sort();
  const references = await deps.facts.readReferences(tx, { itemIds: ids, accountIds: [] });
  const found = new Set(references.items.map((item) => item.orderItemId));
  // A missing external reference is reported, never replaced by a fabricated empty account set.
  const facts = await deps.facts.getLicenseFacts(
    tx,
    ids.filter((id) => found.has(id)),
  );
  const letters = await tx.licenseLetter.findMany({
    where: {
      orderItemId: { in: ids },
      status: { not: "voided" },
      ...(scope.entityIds ? { entityId: { in: [...scope.entityIds] } } : {}),
    },
    include: { currentRevision: true },
    orderBy: { id: "asc" },
  });
  const violations: InvariantViolation[] = [];
  // Historical evidence remains verifiable after cancellation or account removal. Read it within
  // the requested entity scope, independently of current candidates; never heal historical rows.
  const history = await tx.licenseLetter.findMany({
    where: scope.entityIds ? { entityId: { in: [...scope.entityIds] } } : {},
    select: {
      id: true,
      entityId: true,
      revisions: {
        select: { id: true, revNo: true, renderStatus: true, fileId: true, pdfSha256: true },
        orderBy: { revNo: "asc" },
      },
    },
    orderBy: { id: "asc" },
  });
  const ready = history.flatMap((letter) =>
    letter.revisions.filter((revision) => revision.renderStatus === "ready"),
  );
  const files = await deps.readFiles(
    tx,
    ready.flatMap((revision) => (revision.fileId ? [revision.fileId] : [])),
  );
  for (const letter of history) {
    if (letter.revisions.some((revision, index) => revision.revNo !== index + 1))
      violations.push({
        subject: { type: "license_letter", id: letter.id },
        entityId: letter.entityId,
        detail: { problem: "revision_sequence_gap" },
      });
    for (const revision of letter.revisions) {
      if (revision.renderStatus !== "ready") continue;
      const file = files.find((row) => row.id === revision.fileId);
      if (!file || !file.sha256 || file.sha256 !== revision.pdfSha256)
        violations.push({
          subject: { type: "license_letter", id: letter.id },
          entityId: letter.entityId,
          detail: { problem: "ready_pdf_hash_mismatch", revisionId: revision.id },
        });
    }
  }
  const repair = new Set<string>();
  for (const id of ids) {
    const item = facts.find((row) => row.orderItemId === id);
    const rows = letters.filter((letter) => letter.orderItemId === id);
    if (!item || rows.some((letter) => !ownership(letter, item))) {
      for (const letter of rows)
        violations.push({
          subject: { type: "license_letter", id: letter.id },
          entityId: letter.entityId,
          detail: { problem: "external_reference_invalid" },
        });
      continue;
    }
    const wanted = licenseEligible(item.phase) ? item.accounts : [];
    const expectedStatus = item.usageStartDate ? "effective" : "pending_effective";
    for (const account of wanted) {
      const matches = rows.filter((letter) => letter.channelAccountId === account.channelAccountId);
      if (
        matches.length !== 1 ||
        matches.some(
          (letter) =>
            letter.status !== expectedStatus ||
            day(letter.periodStart) !== item.usageStartDate ||
            day(letter.periodEnd) !== item.usageEndDate,
        )
      ) {
        violations.push({
          subject: { type: "order_item", id },
          entityId: item.entityId,
          detail: {
            problem: "current_license_mismatch",
            channelAccountId: account.channelAccountId,
          },
        });
        repair.add(id);
      }
    }
    for (const letter of rows) {
      if (!wanted.some((account) => account.channelAccountId === letter.channelAccountId)) {
        violations.push({
          subject: { type: "license_letter", id: letter.id },
          entityId: item.entityId,
          detail: { problem: "license_outside_current_facts" },
        });
        repair.add(id);
      }
      if (
        letter.status === "effective" &&
        (!letter.currentRevision ||
          letter.currentRevision.licenseLetterId !== letter.id ||
          letter.currentRevision.renderStatus !== "ready")
      )
        violations.push({
          subject: { type: "license_letter", id: letter.id },
          entityId: item.entityId,
          detail: { problem: "effective_without_ready_revision" },
        });
    }
  }
  if (repair.size) {
    // All item locks above are already held. One writer then acquires the whole letter batch.
    const result = await reconcileLetters(tx, deps, [...repair].sort(), "invariant:docs.N6");
    if (result.created + result.revised + result.voided > 0) {
      for (let i = 0; i < violations.length; i++) {
        const row = violations[i]!;
        if (
          ["current_license_mismatch", "license_outside_current_facts"].includes(
            String(row.detail.problem),
          )
        )
          violations[i] = { ...row, healed: { action: "reconcileLetters", at: deps.clock.now() } };
      }
    }
  }
  deps.assertOpen?.();
  return violations;
}

export async function findN16Violations(
  tx: Tx,
  deps: LicenseConvergenceDeps,
  scope: InvariantScope = {},
): Promise<InvariantViolation[]> {
  deps.assertOpen?.();
  const letters = await tx.licenseLetter.findMany({
    where: scope.entityIds ? { entityId: { in: [...scope.entityIds] } } : {},
    orderBy: { id: "asc" },
  });
  const references = await deps.facts.readReferences(tx, {
    itemIds: [...new Set(letters.map((letter) => letter.orderItemId))],
    accountIds: [...new Set(letters.map((letter) => letter.channelAccountId))],
  });
  const violations = letters.flatMap((letter): InvariantViolation[] => {
    const item = references.items.find((row) => row.orderItemId === letter.orderItemId);
    const account = references.accounts.find((row) => row.id === letter.channelAccountId);
    return !item ||
      !ownership(letter, item) ||
      !account ||
      account.entityId !== letter.entityId ||
      account.storeId !== letter.storeId ||
      account.platform !== letter.platform
      ? [
          {
            subject: { type: "license_letter", id: letter.id },
            entityId: letter.entityId,
            detail: {
              problem: "external_reference_invalid",
              orderItemExists: !!item,
              accountExists: !!account,
            },
          },
        ]
      : [];
  });
  deps.assertOpen?.();
  return violations;
}
