// tenant 模块：主体、门店、成员关系、邀请的状态迁移表。
// 每行：分组文档的行（分组:行号）、当前状态（null 是新建）、迁移事件码、新状态（SAME 是不改状态）；文档没写守卫的行尾是 NO_GUARD。
// 改这里的行，要在同一个 PR 改分组文档的那一行：pnpm machines:check 逐行对照。
import {
  ENTITY_LIFECYCLE,
  ENTITY_MEMBER_STATUS,
  INVITATION_STATUS,
  QUALIFICATION_STATUS,
  STORE_LIFECYCLE,
} from "@liyoxi/contract/enums";

import { NO_GUARD, chain } from "./define.js";

/** entity.lifecycle：docs/data-model/02-identity-tenant.md */
export const entityLifecycle = chain("entity", "lifecycle", ENTITY_LIFECYCLE, [
  ["02:523", null, "entity.create", ["active"]],
  ["02:524", ["active"], "entity.abandon", ["abandoned"]],
  ["02:525", ["active"], "entity.close", ["closed"]],
]);

/** entity.verification_status：docs/data-model/02-identity-tenant.md */
export const entityVerificationStatus = chain(
  "entity",
  "verification_status",
  QUALIFICATION_STATUS,
  [
    ["02:540", ["unsubmitted", "rejected"], "qualification.submit", ["pending"]],
    ["02:541", ["pending"], "qualification.approve", ["verified"]],
    ["02:542", ["pending"], "qualification.reject", ["rejected"], NO_GUARD],
    ["02:543", ["pending"], "qualification.withdraw", ["unsubmitted", "rejected"], NO_GUARD],
  ],
);

/** store.lifecycle：docs/data-model/02-identity-tenant.md */
export const storeLifecycle = chain("store", "lifecycle", STORE_LIFECYCLE, [
  ["02:607", null, "store.create", ["active"]],
  ["02:608", ["active"], "store.archive", ["archived"]],
  ["02:609", ["active"], "store.draft_delete", ["archived"]],
  ["02:610", ["active"], "store.archive_by_entity", ["archived"], NO_GUARD],
  ["02:611", ["active"], "store.archive_by_entity", ["archived"], NO_GUARD],
  ["02:612", ["archived"], "store.restore", ["active"]],
]);

/** store.qualification_status：docs/data-model/02-identity-tenant.md */
export const storeQualificationStatus = chain(
  "store",
  "qualification_status",
  QUALIFICATION_STATUS,
  [
    ["02:622", ["unsubmitted"], "qualification.submit", ["pending"]],
    ["02:623", ["pending"], "qualification.approve", ["verified"]],
    ["02:624", ["pending"], "qualification.reject", ["rejected"]],
    ["02:625", ["rejected"], "qualification.submit", ["pending"]],
    ["02:626", ["pending"], "qualification.withdraw", ["unsubmitted", "rejected"]],
    ["02:627", ["verified"], "qualification.change_submit", ["verified"]],
    ["02:627", ["verified"], "qualification.change_approve", ["verified"]],
    ["02:627", ["verified"], "qualification.change_reject", ["verified"]],
    ["02:628", ["verified"], "qualification.change_withdraw", ["verified"]],
  ],
);

/** entity_member.status：docs/data-model/02-identity-tenant.md */
export const entityMember = chain("entity_member", "status", ENTITY_MEMBER_STATUS, [
  ["02:690", null, "entity_member.create_owner", ["active"]],
  ["02:691", null, "entity_member.join", ["active"]],
  ["02:692", ["active"], "entity_member.remove", ["removed"]],
  ["02:692", ["active"], "entity_member.leave", ["removed"]],
  ["02:692", ["active"], "entity_member.cascade_remove", ["removed"]],
  ["02:693", ["active"], "entity_member.promote_owner", ["active"]],
  ["02:694", ["active"], "entity_member.cascade_remove", ["removed"]],
  ["02:695", ["active"], "entity_member.cascade_remove", ["removed"]],
]);

/** invitation.status：docs/data-model/02-identity-tenant.md */
export const invitation = chain("invitation", "status", INVITATION_STATUS, [
  ["02:786", null, "invitation.create", ["pending"]],
  ["02:787", ["pending"], "invitation.accept", ["accepted"]],
  ["02:788", ["pending"], "invitation.revoke", ["revoked"]],
  ["02:789", ["pending"], "invitation.expire", ["expired"]],
]);
