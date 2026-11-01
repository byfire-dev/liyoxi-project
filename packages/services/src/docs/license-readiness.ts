import type { Tx } from "../kernel/index.js";
import type { LicenseFacts } from "./license-facts.js";
import { LicenseLetterSnapshotSchema } from "./license-facts.js";
import { licenseContentFingerprint, licenseLetterMatchesFacts, licenseEligible } from "./license-convergence.js";

export interface LicenseReadyFile {
  readonly id: string;
  readonly category: string;
  readonly scopeType: string;
  readonly entityId: string | null;
  readonly storeId: string | null;
  readonly status: string;
  readonly moderationState: string;
  readonly ext: string;
  readonly sha256: string | null;
  readonly deletedAt: Date | null;
  readonly erasedAt: Date | null;
}
export interface LicenseReadiness {
  readonly orderItemId: string;
  readonly ready: boolean;
  readonly blockers: readonly ("missing" | "legal_mismatch" | "revision_pending" | "file_not_ready")[];
}

/** Caller holds current order/item and letter locks. Read only; never signs or renders inside TX. */
export async function readLicenseReadiness(
  tx: Tx,
  facts: readonly LicenseFacts[],
  readFiles: (tx: Tx, ids: readonly string[]) => Promise<readonly LicenseReadyFile[]>,
): Promise<LicenseReadiness[]> {
  if (!facts.length) return [];
  const letters = await tx.licenseLetter.findMany({
    where: { orderItemId: { in: facts.map((item) => item.orderItemId) }, status: { not: "voided" } },
    include: { revisions: { orderBy: { revNo: "desc" }, take: 1 } },
    orderBy: { id: "asc" },
  });
  const files = new Map((await readFiles(tx, [...new Set(letters.flatMap((letter) => {
    const latest = letter.revisions[0];
    return latest?.fileId ? [latest.fileId] : [];
  }))])).map((file) => [file.id, file]));
  return facts.map((item) => {
    const blockers = new Set<LicenseReadiness["blockers"][number]>();
    const rows = letters.filter((letter) => letter.orderItemId === item.orderItemId);
    if (!licenseEligible(item.phase)) blockers.add("legal_mismatch");
    if (!item.accounts.length) blockers.add("missing");
    if (rows.some((letter) => !licenseLetterMatchesFacts(letter, item))) blockers.add("legal_mismatch");
    for (const account of item.accounts) {
      const matches = rows.filter((letter) => letter.channelAccountId === account.channelAccountId);
      if (matches.length !== 1) {
        blockers.add(matches.length ? "legal_mismatch" : "missing");
        continue;
      }
      const letter = matches[0]!, latest = letter.revisions[0];
      // A newer queued/corrected legal version cannot borrow the previous downloadable PDF.
      if (!latest || latest.renderStatus !== "ready" || letter.currentRevisionId !== latest.id || !latest.readyAt) {
        blockers.add("revision_pending");
        continue;
      }
      const snapshot = LicenseLetterSnapshotSchema.safeParse(latest.letterSnapshot);
      if (!snapshot.success ||
        snapshot.data.orderNo !== item.orderNo || snapshot.data.letterNo !== letter.letterNo ||
        snapshot.data.revNo !== latest.revNo || snapshot.data.account.platform !== account.platform ||
        snapshot.data.account.accountId !== account.accountNo ||
        snapshot.data.period.start !== item.usageStartDate || snapshot.data.period.end !== item.usageEndDate ||
        licenseContentFingerprint(snapshot.data) !== latest.contentFp) blockers.add("legal_mismatch");
      const file = latest.fileId ? files.get(latest.fileId) : undefined;
      if (!file || file.scopeType !== "entity" || file.entityId !== item.entityId || file.storeId !== null ||
        file.category !== "legal_doc" || file.ext !== "pdf" || file.status !== "stored" ||
        file.moderationState === "block" || file.deletedAt || file.erasedAt ||
        !latest.pdfSha256 || file.sha256 !== latest.pdfSha256) blockers.add("file_not_ready");
    }
    return { orderItemId: item.orderItemId, ready: blockers.size === 0, blockers: [...blockers] };
  });
}
