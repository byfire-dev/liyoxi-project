import type { components } from "@liyoxi/contract/types/portal";
import type { PortalClient } from "../../lib/api";

export type LicenseVerification = components["schemas"]["LicenseVerificationView"];

export function createVerificationApi(client: PortalClient) {
  return {
    async get(
      code: string,
      rawRev: string | null,
      signal?: AbortSignal,
    ): Promise<LicenseVerification> {
      const value = await client.request("/api/v1/portal/license-verifications", "get", {
        query: { code },
        signal,
        querySerializer: () => {
          // The generated input is numeric, but the server deliberately handles raw QR values.
          const query = new URLSearchParams({ code });
          if (rawRev !== null) query.set("revNo", rawRev);
          return query;
        },
      });
      // Keep only the public projection, even if a malformed response contains extra fields.
      const proof = (
        item: LicenseVerification["currentRevision"] | LicenseVerification["revisions"][number],
      ) => ({
        revNo: item.revNo,
        reason: item.reason,
        contentFp: item.contentFp,
        pdfSha256: item.pdfSha256,
        issuedAt: item.issuedAt,
      });
      return {
        letterNo: value.letterNo,
        displayStatus: value.displayStatus,
        voidedAt: value.voidedAt,
        platform: value.platform,
        licensorName: value.licensorName,
        licenseeNameMask: value.licenseeNameMask,
        licenseeCreditCodeMask: value.licenseeCreditCodeMask,
        dramaName: value.dramaName,
        episodes: value.episodes,
        account: {
          platform: value.account.platform,
          name: value.account.name,
          accountId: value.account.accountId,
        },
        period: {
          startDate: value.period.startDate,
          startText: value.period.startText,
          endDate: value.period.endDate,
          territory: value.period.territory,
        },
        consent: {
          consentNo: value.consent.consentNo,
          agreementName: value.consent.agreementName,
          consentedAt: value.consent.consentedAt,
          operatorMask: value.consent.operatorMask,
        },
        currentRevision: {
          ...proof(value.currentRevision),
          signMode: value.currentRevision.signMode,
          certSerial: value.currentRevision.certSerial,
          certIssuer: value.currentRevision.certIssuer,
          platformSignedAt: value.currentRevision.platformSignedAt,
        },
        hasPendingRevision: value.hasPendingRevision,
        revisions: value.revisions.map((item) => ({ ...proof(item), isCurrent: item.isCurrent })),
        requestedRevNo: value.requestedRevNo,
        requestedRevisionState: value.requestedRevisionState,
        checkedAt: value.checkedAt,
      };
    },
  };
}
