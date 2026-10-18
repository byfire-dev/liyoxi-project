/** Values supplied by the owning domain; docs never reads the upper business tables. */
export interface TransactionConsentFact {
  readonly bizType: "billing_order" | "drama_order" | "ad";
  readonly bizId: string;
  readonly bizNo: string;
  readonly entityId: string;
  readonly merchantUserId: string | null;
  readonly at: Date;
  readonly agreementKeys: readonly string[];
  readonly consentId?: string;
}
