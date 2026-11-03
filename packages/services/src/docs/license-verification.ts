import { LicenseVerificationQuerySchema, LicenseVerificationViewSchema } from "@liyoxi/contract";
import type { LicenseVerificationQuery, LicenseVerificationView } from "@liyoxi/contract";
import type { LicenseLetterRevision } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { maskUscc } from "@liyoxi/shared/mask";
import { AppError } from "../kernel/index.js";
import type { Clock, TxRunner } from "../kernel/index.js";
import { parseLicenseLetterSnapshot } from "./license-facts.js";

/** A100 public-name policy; keep only the first character for names shorter than seven. */
function licenseeMask(name: string): string {
  const chars = [...name];
  return chars.length < 7
    ? `${chars[0] ?? ""}${"*".repeat(Math.max(0, chars.length - 1))}`
    : `${chars.slice(0, 2).join("")}${"*".repeat(chars.length - 6)}${chars.slice(-4).join("")}`;
}
function issued(revision: LicenseLetterRevision) {
  return revision.renderStatus === "ready" && revision.fileId !== null && revision.readyAt !== null &&
    revision.pdfSha256 !== null && revision.signMode !== null && revision.platformSignedAt !== null;
}
function brief(revision: LicenseLetterRevision) {
  return { revNo: revision.revNo, reason: revision.reason, contentFp: revision.contentFp,
    pdfSha256: revision.pdfSha256!, issuedAt: revision.readyAt!.toISOString() };
}

/** Public, zero-write projection. A queued/failed snapshot is never proof of an issued document. */
export function createLicenseVerification(deps: { tx: TxRunner; clock: Clock }) {
  return {
    get: async (input: LicenseVerificationQuery): Promise<LicenseVerificationView> => {
      const query = LicenseVerificationQuerySchema.parse(input);
      if (!/^[0-9A-Za-z]{16}$/.test(query.code)) throw new AppError("LICENSE_VERIFICATION_NOT_FOUND");
      return deps.tx.run(async (tx) => {
        const row = await tx.licenseLetter.findUnique({ where: { verifyCode: query.code },
          include: { revisions: { orderBy: { revNo: "desc" } } } });
        const current = row?.revisions.find((revision) => revision.id === row.currentRevisionId && issued(revision));
        if (!row || !current) throw new AppError("LICENSE_VERIFICATION_NOT_FOUND");
        const snapshot = parseLicenseLetterSnapshot(current.letterSnapshot);
        const revisions = row.revisions.filter(issued);
        const requested = query.revNo ?? null;
        const now = deps.clock.now();
        return LicenseVerificationViewSchema.parse({
          letterNo: row.letterNo,
          displayStatus: row.status === "effective" && row.periodEnd.toISOString().slice(0, 10) < calendarDate(now) ? "expired" : row.status,
          voidedAt: row.voidedAt?.toISOString() ?? null,
          platform: row.platform, licensorName: snapshot.licensor.name,
          licenseeNameMask: licenseeMask(snapshot.licensee.name), licenseeCreditCodeMask: maskUscc(snapshot.licensee.creditCode),
          dramaName: snapshot.drama.name, episodes: snapshot.drama.episodes, account: snapshot.account,
          period: { startDate: snapshot.period.start, startText: snapshot.period.startText, endDate: snapshot.period.end, territory: snapshot.period.territory },
          consent: { consentNo: snapshot.consent.consentNo, agreementName: snapshot.consent.agreement, consentedAt: snapshot.consent.at, operatorMask: snapshot.consent.by },
          currentRevision: { ...brief(current), signMode: current.signMode, certSerial: current.certSerial,
            certIssuer: current.certIssuer, platformSignedAt: current.platformSignedAt!.toISOString() },
          hasPendingRevision: row.revisions.some((revision) => revision.revNo > current.revNo && ["queued", "rendering"].includes(revision.renderStatus)),
          revisions: revisions.map((revision) => ({ ...brief(revision), isCurrent: revision.id === current.id })),
          requestedRevNo: requested,
          requestedRevisionState: requested === null ? "not_requested" : requested === current.revNo ? "current" : revisions.some((revision) => revision.revNo === requested) ? "outdated" : "not_found",
          checkedAt: now.toISOString(),
        });
      });
    },
  };
}
export type LicenseVerification = ReturnType<typeof createLicenseVerification>;
