import { notifyReadOf } from "../kernel/index.js";
import type { Assembly, InvariantViolation, TransactionConsentFact, Tx } from "../kernel/index.js";

/** Missing ownership registration is a check error, never a false zero. */
export async function findN5Violations(tx: Tx, assembly: Assembly): Promise<InvariantViolation[]> {
  const read = notifyReadOf(assembly);
  const failures: InvariantViolation[] = [];
  for (const name of ["billingConsentFacts", "orderConsentFacts", "adConsentFacts"]) {
    if (!read.has(name)) throw new Error(`docs.N5 缺少实际单据事实登记：${name}`);
    const facts = await read.read<TransactionConsentFact[]>(tx, name);
    if (!facts) throw new Error(`docs.N5 单据事实读取失败：${name}`);
    for (const fact of facts) {
      const consents = await tx.agreementConsent.findMany({ where: { bizType: fact.bizType, bizId: fact.bizId },
        include: { agreementVersion: true } });
      for (const key of fact.agreementKeys) {
        const consent = consents.find(row => row.agreementKey === key && (!fact.consentId || row.id === fact.consentId));
        let issue: string | null = null;
        if (!consent) issue = "missing_consent";
        else if (consent.bizNo !== fact.bizNo || consent.entityId !== fact.entityId ||
          (fact.merchantUserId !== null && consent.merchantUserId !== fact.merchantUserId)) issue = "consent_reference_mismatch";
        else {
          const version = consent.agreementVersion;
          const current = await tx.agreementVersion.findFirst({ where: { agreementKey: key,
            status: { in: ["pending", "active", "superseded"] }, effectiveAt: { lte: consent.consentedAt } },
            select: { id: true }, orderBy: [{ effectiveAt: "desc" }, { id: "desc" }] });
          if (consent.consentedAt > fact.at || !version.effectiveAt || version.effectiveAt > consent.consentedAt || current?.id !== version.id ||
            version.contentSha256 !== consent.contentSha256) issue = "consent_version_not_effective";
        }
        if (issue) failures.push({ subject: { type: fact.bizType, id: fact.bizId }, entityId: fact.entityId,
          detail: { problem: issue, agreementKey: key } });
      }
    }
  }
  return failures;
}

export function boundN5Violations(_tx: Tx): Promise<InvariantViolation[]> {
  throw new Error("docs.N5 需要本运行时的领域装配");
}
