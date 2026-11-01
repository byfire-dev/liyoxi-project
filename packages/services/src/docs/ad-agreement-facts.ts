import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { versionLabel } from "./versions.js";

/** Read only the non-sensitive consent facts belonging to this actual advertisement. */
export async function readAdAgreementConsent(tx: Tx, input: {
  agreementConsentId: string; entityId: string; storeId: string; adId: string;
}) {
  const row = await tx.agreementConsent.findFirst({
    where: { id: input.agreementConsentId, entityId: input.entityId, storeId: input.storeId,
      agreementKey: "ad_service", scene: "ad_request", bizType: "ad", bizId: input.adId },
    select: { agreementKey: true, consentedAt: true, method: true,
      agreementVersion: { select: { major: true, minor: true } } },
  });
  if (!row) throw new AppError("PRECONDITION_CHANGED", { message: "广告协议同意记录不匹配" });
  return { agreementKey: "ad_service" as const, versionLabel: versionLabel(row.agreementVersion),
    consentedAt: row.consentedAt.toISOString(), method: row.method };
}

/** Advertisement quote uses the current version selected by docs.currentVersions. */
export async function readAdAgreementFacts(tx: Tx, input: {
  entityId: string; merchantUserId: string; agreementVersionId: string;
}) {
  const version = await tx.agreementVersion.findFirst({
    where: { id: input.agreementVersionId, agreementKey: "ad_service" },
    select: { agreement: { select: { name: true } } },
  });
  if (!version) throw new AppError("AGREEMENT_VERSION_STALE");
  const prior = await tx.agreementConsent.findFirst({
    where: { entityId: input.entityId, merchantUserId: input.merchantUserId,
      agreementVersionId: input.agreementVersionId, agreementKey: "ad_service" },
    select: { id: true },
  });
  return { name: version.agreement.name, hasPriorConsent: prior !== null };
}
