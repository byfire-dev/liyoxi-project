// tenant：主体、门店与成员关系（W1-03 交最小集：建主体、成员关系解析、门店列表与额度、记住当前门店、给 profile 的三个写函数）。
// 用法见本目录的 README.md。新增门店、停用与恢复、成员、邀请、主体关闭随 M2。
export { createTenant } from "./service.js";
export { createInvitationExpiry } from "./invitation-expiry.js";
export type { InvitationExpiry } from "./invitation-expiry.js";
export type { InvitationDeps, InvitationOptions, InvitationPrincipal } from "./invitations.js";
export type { Tenant, TenantDeps, UseCaseOptions } from "./service.js";
export {
  billingAccountPort,
  billingHistoryPort,
  membershipAuthorizationsPort,
  entityAdCancelClosePort,
} from "./ports.js";
export type {
  BillingAccountOpener,
  BillingHistoryFacts,
  BillingHistoryReader,
  MembershipAuthorizations,
  PortalGrantRevocation,
  EntityAdCancelClosePlan,
  EntityAdCancelCloser,
} from "./ports.js";
export { ONE_ENTITY_CONSTRAINT } from "./create-entity.js";
export type { StoreMembership } from "./membership.js";
export type { QuotaUsage } from "./quota.js";
export { assertWithinQuota } from "./quota.js";
export type { ActiveMembership, TenantReader } from "./repo.js";
export { DraftNotEmptyError } from "./empty-draft.js";
export { clearAccountMemberNamesIn } from "./account-name-cleanup.js";
export { QUALIFICATION_ACTIONS, STORE_NAME_MAX, STORE_NAME_MIN } from "./qualification.js";
export type {
  QualificationAction,
  StoreQualificationInput,
  StoreQualificationResult,
} from "./qualification.js";
export { TENANT_MACHINE_BINDINGS } from "./machines.js";
export type {
  CreateEntityArgs,
  QualificationArgs,
  QualificationRejection,
  VerifiedEntityFields,
} from "./machines.js";
export { MEMBER_PREVIEW_MAX } from "./stores.js";
export {
  findI1Violations,
  findI5Violations,
  findI17Violations,
  findI28Violations,
  findI27Violations,
  findI29Violations,
  findI7Violations,
  TENANT_INVARIANT_LIMIT,
  USCC_UNIQUE_INDEX,
} from "./invariants.js";
export { registration } from "./register.js";
// W1-04：给 identity 的两个只读函数的类型
export type { ReferralHit } from "./briefs.js";
export { findVerifiedEntityByUsccBidx } from "./uscc.js";
export { clearDraftStoreName } from "./qualification.js";
export { noticeRecipientsPageForNotify } from "./notify-facts.js";
export { readStoreMediaFacts } from "./media-facts.js";
export {
  billingCloseFactsPort,
  orderCloseFactsPort,
  deliveryCloseFactsPort,
  publishCloseFactsPort,
  profileCloseFactsPort,
  adCloseFactsPort,
  CLOSE_FACTS_PORTS,
  readStoreCloseCounts,
  readEntityDeletionCounts,
} from "./close-facts.js";
export type { BillingCloseCounts, StoreCloseCounts, EntityDeletionCounts } from "./close-facts.js";
export { closeEntityIn } from "./entity-close.js";
export type {
  CloseEntityActor,
  CloseEntityDeps,
  CloseEntityInput,
  CloseEntityResult,
} from "./entity-close.js";

export { readStoreAssetFacts, readAssetMerchantUploader } from "./media-facts.js";
export type { StoreMembersBrief } from "./profile-members.js";
export type { TenantAdminReadDeps } from "./admin-read.js";

export { createTenantEntitlement, TENANT_ENTITLEMENT_EVENTS } from "./entitlement.js";
export type { TenantEntitlement, EntitlementNotice } from "./entitlement.js";

export type { DraftAbandonResult } from "./empty-draft.js";
export type { CallerMemberRemoval } from "./member-removal.js";
export { transferOwnerIn } from "./owner-transfer.js";
export type { OwnerTransferInput, OwnerTransferResult } from "./owner-transfer.js";
export {
  listReferralCodesIn,
  createReferralCodeIn,
  setReferralCodeStatusIn,
} from "./referral-codes.js";
export { readLicenseeFacts } from "./license-facts.js";
export type { LicenseeFacts } from "./license-facts.js";

export { isLicenseOwner, licenseStoreVisible } from "./license-access.js";
