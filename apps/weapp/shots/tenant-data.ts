import type {
  Data,
  Invitation,
  Members,
  OwnerStores,
  Preview,
  Result,
  Stores,
} from "../src/sub/member/members/api";
import { agreements, makeMe, makeStores } from "./account-fixtures";
import { overview } from "./profile-fixtures";
export const TENANT_ID = "00000000-0000-4000-8000-000000000001";
export const TENANT_SECOND = "00000000-0000-4000-8000-000000000002";
export const TENANT_NEW = "00000000-0000-4000-8000-000000000003";
export const TENANT_INVITATION = "00000000-0000-4000-8000-000000000004";
export const TENANT_MEMBER = "00000000-0000-4000-8000-000000000005";
export const TENANT_NOW = "2026-10-06T00:00:00.000Z";
export const TENANT_TOKEN = "A".repeat(43);
export function tenantStores(clerk = false): Stores {
  const stores = makeStores();
  if (stores.viewerRole !== "owner") throw new Error("owner fixture required");
  if (!clerk)
    return {
      ...stores,
      items: stores.items.map((item, index) => ({
        ...item,
        actions: index ? ["delete"] : ["archive"],
        qualificationStatus: index ? "unsubmitted" : "verified",
        submittedAt: index ? null : TENANT_NOW,
        verifiedAt: index ? null : TENANT_NOW,
      })),
    } satisfies OwnerStores;
  return {
    viewerRole: "clerk",
    entity: {
      entityId: stores.entity.entityId,
      name: stores.entity.name,
      verificationStatus: stores.entity.verificationStatus,
    },
    items: stores.items.map((s) => ({
      storeId: s.storeId,
      name: s.name,
      isPrimary: s.isPrimary,
      lifecycle: s.lifecycle,
      isLastSelected: s.isLastSelected,
      city: s.city,
      category: s.category,
      qualificationStatus: s.qualificationStatus,
      assetCount: s.assetCount,
      clerkCount: s.clerkCount,
      todoCount: s.todoCount,
      actions: [],
    })),
  };
}
export const tenantSeats: Invitation["seats"] = {
  seatsUsed: 2,
  memberLimit: 5,
  pendingInvitationCount: 1,
  includesUnsharedDraft: true,
  seatsOver: 0,
  limitReason: "plan",
  planName: "成长套餐",
};
export function tenantMembers(clerk = false): Members {
  const stores = makeMe().memberships[0]!.stores.map(
    ({ storeId, name, lifecycle, qualificationStatus }) => ({
      storeId,
      name,
      lifecycle,
      qualificationStatus,
    }),
  );
  const items: Extract<Members, { viewerRole: "owner" }>["items"] = [
    {
      memberId: TENANT_ID,
      role: "owner",
      displayName: "林店长",
      joinedAt: TENANT_NOW,
      isSelf: !clerk,
      phoneMask: "138****8000",
      storeScope: "all",
      stores,
      uploadCount: 8,
      adoptedCount: 3,
      actions: [],
    },
    {
      memberId: TENANT_MEMBER,
      role: "clerk",
      displayName: "小陈",
      joinedAt: TENANT_NOW,
      isSelf: clerk,
      phoneMask: "139****9000",
      storeScope: "listed",
      stores: [stores[1]!],
      uploadCount: 4,
      adoptedCount: 2,
      actions: ["update", "remove"],
    },
  ];
  return clerk
    ? {
        viewerRole: "clerk",
        items: items.map(({ memberId, role, displayName, joinedAt, isSelf }) => ({
          memberId,
          role,
          displayName,
          joinedAt,
          isSelf,
        })),
      }
    : {
        viewerRole: "owner",
        items,
        seats: tenantSeats,
        pendingInvitations: [
          {
            invitationId: TENANT_INVITATION,
            role: "clerk",
            remarkName: "晚班店员",
            isPhoneRestricted: false,
            isShared: true,
            createdAt: TENANT_NOW,
            expiresAt: "2026-10-13T00:00:00.000Z",
            actions: ["revoke"],
          },
        ],
      };
}
export const tenantInvitation: Invitation = {
  invitationId: TENANT_INVITATION,
  token: TENANT_TOKEN,
  isReused: false,
  role: "clerk",
  storeId: TENANT_SECOND,
  storeName: "南山店",
  inviterName: "林店长",
  remarkName: null,
  isPhoneRestricted: false,
  expiresAt: "2026-10-13T00:00:00.000Z",
  seats: tenantSeats,
};
export const tenantPreview = (status: Preview["status"] = "pending"): Preview => ({
  invitationId: TENANT_INVITATION,
  status,
  storeName: "南山店",
  city: { code: "shenzhen", name: "深圳" },
  category: { code: "coffee", name: "咖啡饮品" },
  inviterName: "林店长",
  role: "clerk",
  isPhoneRestricted: false,
  expiresAt: "2026-10-13T00:00:00.000Z",
});
export const tenantResult: Result = {
  entityId: TENANT_ID,
  memberId: TENANT_MEMBER,
  role: "clerk",
  storeId: TENANT_SECOND,
  isNew: true,
  abandonedEntityId: null,
};
export const tenantAgreements: Data<"m.agreement.list"> = {
  ...agreements,
  items: agreements.items.map((a) => ({ ...a, scenes: ["member_join"] })),
};
export const tenantAssetSummary: Data<"m.storeAsset.summary"> = {
  tabs: { all: 4, image: 3, video: 1, recording: 0, audio: 0, document: 0, text: 0 },
  organizingCount: 0,
  adoptedCount: 2,
  recent7dCount: 4,
  hotTags: [],
};
export const tenantDemands: Data<"m.assetDemand.list"> = {
  items: [
    {
      assetDemandId: TENANT_NEW,
      title: "补拍手作咖啡过程",
      shootingNote: "拍清楚制作步骤",
      dueDate: "2026-10-12",
      status: "open",
      isOverdue: false,
      createdByName: "服务经理",
      receivedCount: 2,
      myUploadCount: 1,
      createdAt: TENANT_NOW,
    },
  ],
  nextCursor: null,
  hasMore: false,
};
export function tenantProfile(clerk = false): Data<"m.storeProfile.get"> {
  if (overview.viewerRole !== "owner") throw new Error("owner profile required");
  if (!clerk) return structuredClone(overview);
  return {
    viewerRole: "clerk",
    store: overview.store,
    completeness: overview.completeness,
    steps: { ...overview.steps, qualification: { state: overview.steps.qualification.state } },
    qualification: { status: overview.qualification.status },
    assets: overview.assets,
    members: {
      ownerDisplayName: overview.members.ownerDisplayName,
      clerkCount: overview.members.clerkCount,
      preview: overview.members.preview,
    },
  };
}
export const tenantMe = (clerk = false) => {
  const me = makeMe(clerk);
  if (clerk) {
    me.memberships[0]!.memberId = TENANT_MEMBER;
    me.memberships[0]!.memberDisplayName = "小陈";
    me.user.displayName = "小陈";
  }
  return me;
};
