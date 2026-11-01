import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

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
