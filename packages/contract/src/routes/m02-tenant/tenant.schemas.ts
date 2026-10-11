// 商家端：主体、门店与成员 · 主体与门店的结构（docs/api/m02-tenant.md 第 2.1–2.3、2.7、3.2、3.7 节；W1-03）。
// EntityBrief 以本文件为唯一定义（约定 C87），m01 的 GET /m/me 引用它。成员、邀请、下载页授权的结构随 M2。
import {
  DictRefSchema,
  IdSchema,
  InstantSchema,
  DateSchema,
  openEnum,
  orNull,
} from "../../common/index.js";
import {
  MERCHANT_ROLE,
  QUALIFICATION_STATUS,
  STORE_ARCHIVE_REASON,
  STORE_LIFECYCLE,
} from "../../enums/index.js";
import { z } from "../../zod.js";

const verificationStatus = () => openEnum(QUALIFICATION_STATUS.values);

/** 3.10/3.11：实际成员移除或主动退出的同一结果。 */
export const MemberRemovalResultSchema = z
  .strictObject({
    memberId: IdSchema,
    status: z.literal("removed"),
    removedAt: InstantSchema,
  })
  .openapi("MemberRemovalResult");
export type MemberRemovalResult = z.infer<typeof MemberRemovalResultSchema>;
export const MemberIdParamsSchema = z.strictObject({ memberId: IdSchema });

/** 2.12/3.4：所属域真实阻断项，未命中项不返回。 */
export const StoreBlockerSchema = z
  .strictObject({
    kind: z.enum([
      "open_order",
      "open_delivery_ticket",
      "ad_in_production",
      "qualification_in_review",
      "channel_account_in_review",
      "unverified_primary_store",
    ]),
    count: z.int().positive(),
  })
  .openapi("StoreBlocker");
export const StoreArchiveParamsSchema = z.strictObject({ storeId: IdSchema });
export const StoreRestoreParamsSchema = z.strictObject({ storeId: IdSchema });

// ---------- 2.4–2.6 成员、待接受邀请与名额 ----------

export const MemberStoreRefSchema = z.strictObject({
  storeId: IdSchema,
  name: orNull(z.string()),
  lifecycle: openEnum(STORE_LIFECYCLE.values),
  qualificationStatus: verificationStatus(),
});
export type MemberStoreRef = z.infer<typeof MemberStoreRefSchema>;
export const MemberItemForClerkSchema = z
  .strictObject({
    memberId: IdSchema,
    role: openEnum(MERCHANT_ROLE.values),
    displayName: orNull(z.string()),
    joinedAt: InstantSchema,
    isSelf: z.boolean(),
  })
  .openapi("MemberItemForClerk");
export type MemberItemForClerk = z.infer<typeof MemberItemForClerkSchema>;
export const MemberItemSchema = MemberItemForClerkSchema.extend({
  phoneMask: orNull(z.string()),
  storeScope: z.enum(["all", "listed"]),
  stores: z.array(MemberStoreRefSchema),
  uploadCount: z.int().nonnegative(),
  adoptedCount: z.int().nonnegative(),
  actions: z.array(z.enum(["update", "remove"])),
}).openapi("MemberItem");
export type MemberItem = z.infer<typeof MemberItemSchema>;
export const PendingInvitationItemSchema = z
  .strictObject({
    invitationId: IdSchema,
    role: z.literal("clerk"),
    remarkName: orNull(z.string()),
    isPhoneRestricted: z.boolean(),
    isShared: z.boolean(),
    createdAt: InstantSchema,
    expiresAt: InstantSchema,
    actions: z.array(z.literal("revoke")),
  })
  .openapi("PendingInvitationItem");
export type PendingInvitationItem = z.infer<typeof PendingInvitationItemSchema>;
export const SeatInfoSchema = z
  .strictObject({
    seatsUsed: z.int().nonnegative(),
    memberLimit: orNull(z.int().nonnegative()),
    pendingInvitationCount: z.int().nonnegative(),
    includesUnsharedDraft: z.boolean(),
    seatsOver: z.int().nonnegative(),
    limitReason: z.enum(["plan", "inactive"]),
    planName: orNull(z.string()),
  })
  .openapi("SeatInfo");
export type SeatInfo = z.infer<typeof SeatInfoSchema>;
export const MemberListSchema = z.discriminatedUnion("viewerRole", [
  z.strictObject({
    viewerRole: z.literal("owner"),
    items: z.array(MemberItemSchema),
    pendingInvitations: z.array(PendingInvitationItemSchema),
    seats: SeatInfoSchema,
  }),
  z.strictObject({ viewerRole: z.literal("clerk"), items: z.array(MemberItemForClerkSchema) }),
]);
export type MemberList = z.infer<typeof MemberListSchema>;
export const MemberUpdateBodySchema = z.strictObject({
  storeIds: z
    .array(IdSchema)
    .min(1, "请至少保留一家门店；如不再合作，请移除成员")
    .refine((ids) => new Set(ids).size === ids.length, "门店不能重复"),
});

// ---------- 2.8–2.9 邀请卡片与匿名预览 ----------

const invitationToken = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/);
export const InvitationCreateBodySchema = z.strictObject({
  // 客户端意图号不是业务主键；保留 string(uuid) 的通用版本范围。
  clientRequestId: z
    .uuid()
    .length(36)
    .refine((id) => id === id.toLowerCase(), "请求号须为小写 UUID"),
  remarkName: orNull(
    z.string().refine((name) => [...name].length <= 10, "备注名最多10字"),
  ).optional(),
  targetPhone: orNull(
    z
      .string()
      .length(11)
      .regex(/^1\d{10}$/, "请输入11位手机号"),
  ).optional(),
});
export type InvitationCreateBody = z.infer<typeof InvitationCreateBodySchema>;
export const InvitationIdParamsSchema = z.strictObject({ invitationId: IdSchema });
export const InvitationCardSchema = z
  .strictObject({
    invitationId: IdSchema,
    token: invitationToken,
    isReused: z.boolean(),
    role: z.literal("clerk"),
    storeId: IdSchema,
    storeName: orNull(z.string()),
    inviterName: z.string().min(1),
    remarkName: orNull(z.string()),
    isPhoneRestricted: z.boolean(),
    expiresAt: InstantSchema,
    seats: SeatInfoSchema,
  })
  .openapi("InvitationCard");
export type InvitationCard = z.infer<typeof InvitationCardSchema>;
export const InvitationMarkSharedResultSchema = z.strictObject({
  invitationId: IdSchema,
  sharedAt: orNull(InstantSchema),
});
export type InvitationMarkSharedResult = z.infer<typeof InvitationMarkSharedResultSchema>;
export const InvitationRevokeBodySchema = z.strictObject({
  reason: z.enum(["by_owner", "unshared_leave"]),
});
export type InvitationRevokeBody = z.infer<typeof InvitationRevokeBodySchema>;
export const InvitationRevokeResultSchema = z.strictObject({
  invitationId: IdSchema,
  status: z.literal("revoked"),
  revokedAt: InstantSchema,
});
export type InvitationRevokeResult = z.infer<typeof InvitationRevokeResultSchema>;
export const InvitationLookupQuerySchema = z.strictObject({ token: invitationToken });
export const InvitationAcceptBodySchema = z.strictObject({
  token: invitationToken,
  displayName: z
    .string()
    .trim()
    .refine((v) => [...v].length >= 1 && [...v].length <= 20, "称呼须为 1 至 20 字")
    .nullable()
    .optional(),
});
export type InvitationAcceptBody = z.infer<typeof InvitationAcceptBodySchema>;
export const InvitationPreviewSchema = z
  .strictObject({
    invitationId: IdSchema,
    status: z.enum(["pending", "accepted", "revoked", "expired"]),
    storeName: orNull(z.string()),
    city: orNull(DictRefSchema),
    category: orNull(DictRefSchema),
    inviterName: z.string().min(1),
    role: z.literal("clerk"),
    isPhoneRestricted: z.boolean(),
    expiresAt: InstantSchema,
  })
  .openapi("InvitationPreview");
export type InvitationPreview = z.infer<typeof InvitationPreviewSchema>;

/** 额度引导的文案依据：套餐生效 / 未开通或已过期 */
export const QUOTA_LIMIT_REASONS = ["plan", "inactive"] as const;
/** 门店卡的可执行动作（约定 C16）；守卫的最终判断在服务端 */
export const STORE_ACTIONS = ["archive", "delete", "restore"] as const;

// ---------- 2.2 主体 ----------

export const EntityBriefSchema = z
  .strictObject({
    entityId: IdSchema,
    name: orNull(z.string()),
    verificationStatus: verificationStatus(),
  })
  .openapi("EntityBrief");
export type EntityBrief = z.infer<typeof EntityBriefSchema>;

export const EntityQuotaCardSchema = z
  .object({
    entityId: IdSchema,
    name: orNull(z.string()),
    verificationStatus: verificationStatus(),
    subscription: orNull(
      z.object({ planName: z.string(), endDate: DateSchema, isActive: z.boolean() }),
    ),
    storesUsed: z.int().min(0),
    storeLimit: z.int().min(0),
    seatsUsed: z.int().min(0),
    /** null = 不限 */
    memberLimit: orNull(z.int().min(0)),
    pendingInvitationCount: z.int().min(0),
    storesOver: z.int().min(0),
    seatsOver: z.int().min(0),
    limitReason: z.enum(QUOTA_LIMIT_REASONS),
    canAddStore: z.boolean(),
  })
  .openapi("EntityQuotaCard");
export type EntityQuotaCard = z.infer<typeof EntityQuotaCardSchema>;

// ---------- 2.3 门店卡 ----------

export const MemberPreviewSchema = z
  .object({ displayName: orNull(z.string()), role: openEnum(MERCHANT_ROLE.values) })
  .openapi("MemberPreview");

const storeCardForClerkShape = {
  storeId: IdSchema,
  name: orNull(z.string()),
  isPrimary: z.boolean(),
  lifecycle: openEnum(STORE_LIFECYCLE.values),
  isLastSelected: z.boolean(),
  city: orNull(DictRefSchema),
  category: orNull(DictRefSchema),
  qualificationStatus: verificationStatus(),
  assetCount: z.int().min(0),
  clerkCount: z.int().min(0),
  todoCount: z.int().min(0),
};

/** 店员视图：不带上线中与交付中计数、审核时间、完整度、待接受邀请数、头像组；actions 恒为空 */
export const StoreCardForClerkSchema = z
  .strictObject({ ...storeCardForClerkShape, actions: z.array(z.enum(STORE_ACTIONS)).max(0) })
  .openapi("StoreCardForClerk");
export type StoreCardForClerk = z.infer<typeof StoreCardForClerkSchema>;

export const StoreCardSchema = z
  .object({
    ...storeCardForClerkShape,
    archiveReason: orNull(openEnum(STORE_ARCHIVE_REASON.values)),
    archivedAt: orNull(InstantSchema),
    verifiedAt: orNull(InstantSchema),
    submittedAt: orNull(InstantSchema),
    expectedDecisionAt: orNull(InstantSchema),
    completenessPct: z.int().min(0).max(100),
    liveCount: z.int().min(0),
    deliveringCount: z.int().min(0),
    pendingInvitationCount: z.int().min(0),
    memberPreview: z.array(MemberPreviewSchema).max(4),
    actions: z.array(z.enum(STORE_ACTIONS)),
  })
  .openapi("StoreCard");
export type StoreCard = z.infer<typeof StoreCardSchema>;
export const StoreArchiveResultSchema = z
  .strictObject({
    store: StoreCardSchema,
    revokedInvitationCount: z.int().nonnegative(),
    removedMemberCount: z.int().nonnegative(),
  })
  .openapi("StoreArchiveResult");
export type StoreArchiveResult = z.infer<typeof StoreArchiveResultSchema>;

/** m.store.list：不分页，按 viewerRole 判别（约定 C55）；none = 账号没有有效成员关系 */
export const StoreListSchema = z.discriminatedUnion("viewerRole", [
  z.object({
    viewerRole: z.literal("owner"),
    entity: EntityQuotaCardSchema,
    items: z.array(StoreCardSchema),
  }),
  z.object({
    viewerRole: z.literal("clerk"),
    entity: EntityBriefSchema,
    items: z.array(StoreCardForClerkSchema),
  }),
  z.object({
    viewerRole: z.literal("none"),
    entity: z.null(),
    // 恒为空数组：元素类型借店员的门店卡（OpenAPI 写不出“没有元素”的数组）
    items: z.array(StoreCardForClerkSchema).max(0),
  }),
]);
export type StoreList = z.infer<typeof StoreListSchema>;

// ---------- 2.7 成员关系结果 ----------

export const MembershipResultSchema = z
  .object({
    entityId: IdSchema,
    memberId: IdSchema,
    role: openEnum(MERCHANT_ROLE.values),
    /** 建议进入的门店：新建主体为首家门店；已有主体取上次选择的门店，没有则取首家门店 */
    storeId: IdSchema,
    isNew: z.boolean(),
    abandonedEntityId: orNull(IdSchema),
  })
  .openapi("MembershipResult");
export type MembershipResult = z.infer<typeof MembershipResultSchema>;

/** m.entity.create 的请求体：空对象 */
export const EntityCreateBodySchema = z.strictObject({});

// ---------- 3.7 记住当前门店 ----------

export const CurrentStoreBodySchema = z.object({ storeId: IdSchema });
export const CurrentStoreSchema = z.object({ storeId: IdSchema });
export { StoreCreateBodySchema, STORE_COPY_OPTIONS } from "./store-create.schemas.js";
export type { StoreCreateBody } from "./store-create.schemas.js";
