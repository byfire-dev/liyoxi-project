// 后台：商家、资质审核与素材复核（docs/api/a03-merchant.md）：一个顶层资源一个文件，整个文件交给 defineRouteDoc 分拣。
// 加资源文件时在这里加一行 import，并放进下面的数组。
import { defineRouteDoc } from "../doc.js";

import * as accountChangeRequests from "./account-change-requests.js";
import * as assetDemands from "./asset-demands.js";
import * as assignmentHistories from "./assignment-histories.js";
import * as commissionStatements from "./commission-statements.js";
import * as entities from "./entities.js";
import * as followUps from "./follow-ups.js";
import * as merchantUsers from "./merchant-users.js";
import * as partnerApplications from "./partner-applications.js";
import * as partnerBindingChanges from "./partner-binding-changes.js";
import * as partnerBindings from "./partner-bindings.js";
import * as partnerLevelChanges from "./partner-level-changes.js";
import * as partnerLevels from "./partner-levels.js";
import * as partners from "./partners.js";
import * as qualificationDocs from "./qualification-docs.js";
import * as qualificationSubmissions from "./qualification-submissions.js";
import * as referralCodes from "./referral-codes.js";
import * as storeAssets from "./store-assets.js";
import * as stores from "./stores.js";

export const A03_MERCHANT = defineRouteDoc("a03-merchant", [
  accountChangeRequests,
  assetDemands,
  assignmentHistories,
  commissionStatements,
  entities,
  followUps,
  merchantUsers,
  partnerApplications,
  partnerBindingChanges,
  partnerBindings,
  partnerLevelChanges,
  partnerLevels,
  partners,
  qualificationDocs,
  qualificationSubmissions,
  referralCodes,
  storeAssets,
  stores,
]);

// 本文档带 details 的领域错误码的结构（W1-06 起；各包补结构时在这里各加自己的文件）
export * from "./error-details.js";

export * from "./stores.schemas.js";
export * from "./qualification.schemas.js";
export { adminStoreList, adminStoreGet, adminStoreAssignDeliveryManager } from "./stores.js";
export {
  adminQualificationSubmissionGet,
  adminQualificationSubmissionApprove,
  adminQualificationSubmissionReject,
} from "./qualification-submissions.js";

export * from "./store-assets.schemas.js";

export * from "./store-assets.js";

export * from "./asset-demands.js";
export * from "./entities.schemas.js";
export { adminEntityGet, adminEntityMemberList } from "./entities.js";
