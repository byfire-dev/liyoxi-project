// tenant 三张状态机表的登记（W1-03；02 分组 第 2.9–2.11 节的状态机表）：随迁列、活动流默认描述，
// 与本包用到的十行迁移的守卫。迁移表本身在 @liyoxi/shared/machines，这里是表里没有的那一半（flow/README.md 第 4 节）。
//
// 登记在装配时是静态的，拿不到进程里的服务：守卫按 args 或同事务用例事实回库核对。
// 未登记守卫的行随所属里程碑补；资质变更提交/决定由W2-11补02:627既有行：
// 在那之前迁移到这些行即抛内部错误，不放行。
import type { AuditCategory } from "@liyoxi/contract";
import { QUALIFICATION_DUPLICATE_REJECT_NOTE } from "@liyoxi/contract";
import { hasFinalQualificationRejection } from "./qualification-facts.js";

import { chainKey, machinePort, rowKey } from "../flow/index.js";
import type { ActivityDescription, Guard, MachineBinding, TransitionFacts } from "../flow/index.js";
import { implementKeyed } from "../kernel/index.js";
import type { PortImplementation } from "../kernel/index.js";
import {
  guardEntityClose,
  guardEntityCloseCascade,
  requireClosedStoreCascade,
} from "./entity-close.js";
import { guardAccountMemberRemoval, guardMemberRemoval } from "./member-removal.js";
import { guardInvitation } from "./invitations.js";
import { guardInvitationExpiry } from "./invitation-expiry.js";
import { guardStoreArchive, guardStoreArchiveCascade } from "./store-archive.js";
import { guardStoreRestore } from "./store-restore.js";
import { guardStoreCreate } from "./store-create.js";
import { guardAccept } from "./invitation-accept.js";
import { guardDraftAbandon } from "./empty-draft.js";
import { guardOwnerTransfer } from "./owner-transfer.js";

/** 建主体的三行迁移随 args 带的事实 */
export interface CreateEntityArgs {
  /** 建主体的账号 */
  readonly merchantUserId: string;
}

/** 认证通过时写进主体的字段（密文、盲索引、脱敏串由调用方做好） */
export interface VerifiedEntityFields {
  readonly name: string;
  readonly entityType: "enterprise" | "individual";
  readonly usccEnc: string;
  readonly usccBidx: Uint8Array;
  readonly usccMask: string;
  readonly legalRepNameEnc: string | null;
  readonly legalRepNameMask: string | null;
}

/** 员工驳回至少一项编码；系统重复主体拒绝由真实轮次/审批/认证事实守卫允许空编码。 */
export interface QualificationRejection {
  readonly reasonCodes: readonly string[];
  readonly note: string;
}

/** 资质迁移随 args 带的事实 */
export interface QualificationArgs {
  readonly submissionId?: string;
  readonly verified?: VerifiedEntityFields;
  readonly rejection?: QualificationRejection;
}

const argsOf = <T>(facts: TransitionFacts): Partial<T> => (facts.args ?? {}) as Partial<T>;

// ---------- 建主体的三行 ----------

/** 02:523 entity.create：账号没有有效成员关系 */
const noActiveMembership: Guard = async (tx, facts) => {
  const { merchantUserId } = argsOf<CreateEntityArgs>(facts);
  if (merchantUserId === undefined) return false;
  return (await tx.entityMember.count({ where: { merchantUserId, status: "active" } })) === 0;
};

/**
 * 02:607 store.create：主体 active。M1 只有建主体时的首家门店：主体由操作人创建、名下还没有别的门店。
 * 新增门店（老板、额度校验）随 M2 在这里补。
 */
const firstStoreOfOwnEntity: Guard = async (tx, facts) => {
  const { merchantUserId } = argsOf<CreateEntityArgs>(facts);
  if (merchantUserId === undefined || facts.entityId === null) return false;
  const entity = await tx.entity.findUnique({
    where: { id: facts.entityId },
    select: { lifecycle: true, createdByUserId: true },
  });
  if (entity === null || entity.lifecycle !== "active") return false;
  if (entity.createdByUserId !== merchantUserId) return false;
  const others = await tx.store.count({
    where: { entityId: facts.entityId, NOT: { id: facts.subjectId } },
  });
  return others === 0;
};

/** 02:690 entity_member.create_owner：该账号没有别的有效成员关系 */
const noOtherActiveMembership: Guard = async (tx, facts) => {
  if (await guardOwnerTransfer(tx, facts)) return true;
  const { merchantUserId } = argsOf<CreateEntityArgs>(facts);
  if (merchantUserId === undefined) return false;
  const others = await tx.entityMember.count({
    where: { merchantUserId, status: "active", NOT: { id: facts.subjectId } },
  });
  return others === 0;
};

// ---------- 资质的 initial 轮次 ----------

/** 02:622、02:625 提交：门店启用中且已起名（库里的 ck_store_name_required 兜底） */
const storeReadyToSubmit: Guard = async (tx, facts) => {
  const store = await tx.store.findUnique({
    where: { id: facts.subjectId },
    select: { lifecycle: true, name: true },
  });
  return (
    store !== null &&
    store.lifecycle === "active" &&
    store.name !== null &&
    !(await hasFinalQualificationRejection(tx, facts.subjectId))
  );
};

/** 02:623 通过：门店启用中 */
const storeActive: Guard = async (tx, facts) => {
  const store = await tx.store.findUnique({
    where: { id: facts.subjectId },
    select: { lifecycle: true },
  });
  return store?.lifecycle === "active";
};

/** 02:624/627 驳回：员工原因必填；系统空原因限当前真实duplicate_entity决定。 */
const rejectionGiven: Guard = async (tx, facts) => {
  const { rejection, submissionId } = argsOf<QualificationArgs>(facts);
  if (!rejection || !rejection.note.trim()) return false;
  if (rejection.reasonCodes.length) return true;
  if (
    facts.ctx.actor.type !== "system" ||
    !facts.entityId ||
    !submissionId ||
    rejection.note !== QUALIFICATION_DUPLICATE_REJECT_NOTE
  )
    return false;
  const round = await tx.qualificationSubmission.findFirst({
    where: {
      id: submissionId,
      storeId: facts.subjectId,
      entityId: facts.entityId!,
      submittedAt: { not: null },
      closedAt: null,
    },
    include: {
      approvalRequest: true,
      qualificationDocs: { where: { docType: "business_license", removedAt: null } },
    },
  });
  const approval = round?.approvalRequest,
    license = round?.qualificationDocs[0];
  if (
    !license?.certNoBidx ||
    approval?.status !== "rejected" ||
    !approval.isDecidedBySystem ||
    approval.reasonCodes.length !== 0 ||
    approval.decisionNote !== rejection.note ||
    approval.kind !== "qualification" ||
    approval.subjectType !== "store" ||
    approval.subjectId !== round!.storeId ||
    approval.decidedByStaffId !== null ||
    approval.storeId !== round!.storeId ||
    approval.entityId !== round!.entityId ||
    approval.roundNo !== round!.roundNo
  )
    return false;
  return (
    (await tx.entity.count({
      where: {
        id: { not: round!.entityId },
        verificationStatus: "verified",
        usccBidx: license.certNoBidx,
      },
    })) > 0
  );
};

/** 02:626 撤回：只由系统做（主体被关闭或放弃时的联动） */
const bySystem: Guard = (_tx, facts) => Promise.resolve(facts.ctx.actor.type === "system");
const lifecycleChangeWithdrawal: Guard = async (tx, facts) => {
  if (facts.ctx.actor.type !== "system" || !facts.entityId) return false;
  const entity = await tx.entity.findUnique({ where: { id: facts.entityId } });
  return entity !== null && ["closed", "abandoned"].includes(entity.lifecycle);
};

/** 02:540 主体一侧的提交：主体 active */
const entityActive: Guard = async (tx, facts) => {
  const entity = await tx.entity.findUnique({
    where: { id: facts.subjectId },
    select: { lifecycle: true },
  });
  return entity?.lifecycle === "active";
};

/** 02:541 主体一侧的通过：认证字段齐全（信用代码不重复由唯一索引 uq_entity_uscc_bidx_verified 保证） */
const verifiedFieldsGiven: Guard = (_tx, facts) => {
  const { verified } = argsOf<QualificationArgs>(facts);
  return Promise.resolve(
    verified !== undefined &&
      verified.name.trim() !== "" &&
      verified.usccEnc !== "" &&
      verified.usccMask !== "" &&
      verified.usccBidx.byteLength === 32,
  );
};

// ---------- 活动流默认描述 ----------

const QUALIFICATION_VERBS: Readonly<Record<string, string>> = {
  "qualification.submit": "提交资质审核",
  "qualification.approve": "资质审核通过",
  "qualification.reject": "资质审核驳回",
  "qualification.withdraw": "撤回资质审核",
  "qualification.change_withdraw": "随主体终止撤回资质变更审核",
  "qualification.change_submit": "提交资质变更审核",
  "qualification.change_approve": "资质变更审核通过",
  "qualification.change_reject": "资质变更审核驳回",
};

/** 事件码 → 描述；这条链上没写到的事件码返回 null：用例必须自己传审计内容 */
const describe =
  (
    object: "entity" | "store" | "entity_member" | "invitation",
    category: AuditCategory,
    summaries: Readonly<Record<string, string>>,
  ) =>
  (facts: TransitionFacts): ActivityDescription | null => {
    const summary = summaries[facts.event];
    if (summary === undefined) return null;
    // 动作：tenant.<对象>.<事件码的动作段>，如 tenant.store.qualification_submit
    const verb = facts.event
      .replace(/^(entity_member|entity|store|invitation)\./, "")
      .replaceAll(".", "_");
    return { category, action: `tenant.${object}.${verb}`, summary };
  };

/** 六条链的登记 */
export const TENANT_MACHINE_BINDINGS: Readonly<Record<string, MachineBinding>> = {
  [chainKey("entity", "lifecycle")]: {
    companions: ["closed_at"],
    activity: describe("entity", "merchant_lifecycle", {
      "entity.create": "创建经营主体",
      "entity.abandon": "空草稿主体让位",
    }),
    guards: {
      [rowKey("02:523", "entity.create")]: noActiveMembership,
      [rowKey("02:524", "entity.abandon")]: guardDraftAbandon,
      [rowKey("02:525", "entity.close")]: guardEntityClose,
    },
  },
  [chainKey("entity", "verification_status")]: {
    companions: [
      "name",
      "entity_type",
      "uscc_enc",
      "uscc_bidx",
      "uscc_mask",
      "legal_rep_name_enc",
      "legal_rep_name_mask",
      "verified_at",
    ],
    activity: describe("entity", "review", QUALIFICATION_VERBS),
    guards: {
      [rowKey("02:540", "qualification.submit")]: entityActive,
      [rowKey("02:541", "qualification.approve")]: verifiedFieldsGiven,
    },
  },
  [chainKey("store", "lifecycle")]: {
    companions: [
      "archived_at",
      "archive_actor_type",
      "archive_actor_id",
      "archive_client",
      "archive_reason",
    ],
    activity: describe("store", "merchant_lifecycle", {
      "store.create": "创建门店",
      "store.archive": "停用门店",
      "store.draft_delete": "删除草稿门店",
      "store.restore": "恢复门店",
      "store.archive_by_entity": "随主体关闭停用门店",
    }),
    guards: {
      [rowKey("02:607", "store.create")]: async (tx, facts) =>
        (await guardStoreCreate(tx, facts)) || firstStoreOfOwnEntity(tx, facts),
      [rowKey("02:608", "store.archive")]: guardStoreArchive,
      [rowKey("02:609", "store.draft_delete")]: guardStoreArchive,
      [rowKey("02:612", "store.restore")]: guardStoreRestore,
      [rowKey("02:611", "store.archive_by_entity")]: guardDraftAbandon,
    },
    effects: { [rowKey("02:610", "store.archive_by_entity")]: requireClosedStoreCascade },
  },
  [chainKey("store", "qualification_status")]: {
    activity: describe("store", "review", QUALIFICATION_VERBS),
    guards: {
      [rowKey("02:622", "qualification.submit")]: storeReadyToSubmit,
      [rowKey("02:623", "qualification.approve")]: storeActive,
      [rowKey("02:624", "qualification.reject")]: rejectionGiven,
      [rowKey("02:625", "qualification.submit")]: storeReadyToSubmit,
      [rowKey("02:626", "qualification.withdraw")]: bySystem,
      [rowKey("02:628", "qualification.change_withdraw")]: lifecycleChangeWithdrawal,
      [rowKey("02:627", "qualification.change_submit")]: storeReadyToSubmit,
      [rowKey("02:627", "qualification.change_approve")]: storeActive,
      [rowKey("02:627", "qualification.change_reject")]: rejectionGiven,
    },
  },
  [chainKey("entity_member", "status")]: {
    companions: [
      "role",
      "display_name",
      "removed_at",
      "remove_actor_type",
      "remove_actor_id",
      "remove_client",
      "remove_reason",
      "last_store_id",
    ],
    activity: describe("entity_member", "member", {
      "entity_member.create_owner": "成为主体的老板",
      "entity_member.join": "接受邀请加入门店",
      "entity_member.remove": "移除店员",
      "entity_member.leave": "退出主体",
      "entity_member.cascade_remove": "随主体关闭移除成员",
    }),
    guards: {
      [rowKey("02:690", "entity_member.create_owner")]: noOtherActiveMembership,
      [rowKey("02:693", "entity_member.promote_owner")]: guardOwnerTransfer,
      [rowKey("02:694", "entity_member.cascade_remove")]: guardOwnerTransfer,
      [rowKey("02:691", "entity_member.join")]: guardAccept,
      [rowKey("02:692", "entity_member.remove")]: guardMemberRemoval,
      [rowKey("02:692", "entity_member.leave")]: guardMemberRemoval,
      [rowKey("02:692", "entity_member.cascade_remove")]: async (tx, facts) =>
        (await guardStoreArchiveCascade(tx, facts)) ||
        (await guardAccountMemberRemoval(tx, facts)) ||
        guardEntityCloseCascade(tx, facts),
      [rowKey("02:695", "entity_member.cascade_remove")]: async (tx, facts) =>
        (await guardDraftAbandon(tx, facts)) || (await guardEntityCloseCascade(tx, facts)),
    },
  },
  [chainKey("invitation", "status")]: {
    companions: [
      "accepted_at",
      "accepted_by_user_id",
      "accepted_member_id",
      "revoked_at",
      "revoke_actor_type",
      "revoke_actor_id",
      "revoke_client",
      "revoke_reason",
      "token_enc",
    ],
    activity: describe("invitation", "member", {
      "invitation.revoke": "随主体关闭撤回邀请",
      "invitation.accept": "接受门店邀请",
    }),
    guards: {
      [rowKey("02:786", "invitation.create")]: guardInvitation,
      [rowKey("02:787", "invitation.accept")]: guardAccept,
      [rowKey("02:788", "invitation.revoke")]: (tx, facts) =>
        facts.ctx.actor.type === "merchant"
          ? (async () => (await guardInvitation(tx, facts)) || guardEntityCloseCascade(tx, facts))()
          : (async () =>
              (await guardStoreArchiveCascade(tx, facts)) || guardEntityCloseCascade(tx, facts))(),
      [rowKey("02:789", "invitation.expire")]: guardInvitationExpiry,
    },
  },
};

/** 交给 register.ts：一条链一条端口实现 */
export const machineImplementations = (): PortImplementation[] =>
  Object.entries(TENANT_MACHINE_BINDINGS).map(([key, binding]) =>
    implementKeyed(machinePort, key, binding),
  );
