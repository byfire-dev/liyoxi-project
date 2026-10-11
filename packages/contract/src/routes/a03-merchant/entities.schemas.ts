import {
  ENTITY_LIFECYCLE,
  ENTITY_TYPE,
  ENTITY_MEMBER_STATUS,
  ENTITY_MEMBER_REMOVE_REASON,
  STORE_LIFECYCLE,
  QUALIFICATION_STATUS,
  SOURCE_TYPE,
} from "../../enums/index.js";
import { z } from "../../zod.js";
import { DictRefSchema, IdSchema, InstantSchema, openEnum, orNull } from "../../common/index.js";
import { StaffBriefSchema } from "../a01-system/structures.js";
import { StoreHeaderSchema, SubscriptionBriefSchema } from "./stores.schemas.js";

const count = z.int().min(0);
export const EntityIdParamsSchema = z.strictObject({ entityId: IdSchema });
export const EntityMemberListQuerySchema = z.strictObject({
  storeId: IdSchema.optional(),
  role: z.enum(["owner", "clerk"]).optional(),
  includeRemoved: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});
export const MerchantUserBriefSchema = StoreHeaderSchema.shape.owner.options[0]
  .strict()
  .openapi("MerchantUserBrief");
export const EntityStoreRowSchema = z
  .strictObject({
    storeId: IdSchema,
    name: orNull(z.string()),
    isPrimary: z.boolean(),
    lifecycle: openEnum(STORE_LIFECYCLE.values),
    qualificationStatus: openEnum(QUALIFICATION_STATUS.values),
    lastDecidedAt: orNull(InstantSchema),
    reviewDueAt: orNull(InstantSchema),
    openQualificationSubmissionId: orNull(IdSchema),
    address: z.strictObject({
      city: orNull(DictRefSchema),
      district: orNull(DictRefSchema),
      detail: orNull(z.string()),
    }),
    deliveryManager: orNull(StaffBriefSchema),
    liveDramaCount: count,
    producingDramaCount: count,
    assetCount: count,
    reviewedAssetCount: count,
    copiedAssetCount: count,
    copiedFromStoreId: orNull(IdSchema),
    clerkCount: count,
    createdAt: InstantSchema,
  })
  .openapi("EntityStoreRow");
export const PendingInvitationRowSchema = z
  .strictObject({
    invitationId: IdSchema,
    storeId: IdSchema,
    remarkName: orNull(z.string()),
    inviterName: orNull(z.string()),
    createdAt: InstantSchema,
    expiresAt: InstantSchema,
  })
  .openapi("PendingInvitationRow");
export const MemberRowSchema = z
  .strictObject({
    memberId: IdSchema,
    user: MerchantUserBriefSchema,
    role: openEnum(["owner", "clerk"]),
    status: openEnum(ENTITY_MEMBER_STATUS.values),
    storeIds: z.array(IdSchema),
    joinedAt: InstantSchema,
    registeredAt: InstantSchema,
    removedAt: orNull(InstantSchema),
    removeReason: orNull(openEnum(ENTITY_MEMBER_REMOVE_REASON.values)),
    uploadedAssetCount: count,
    adoptedAssetCount: count,
    actions: z.array(z.string()),
  })
  .openapi("MemberRow");
export const EntityMemberListSchema = z.strictObject({ items: z.array(MemberRowSchema) });
export const EntityCardSchema = z
  .strictObject({
    entityId: IdSchema,
    name: orNull(z.string()),
    entityType: orNull(openEnum(ENTITY_TYPE.values)),
    lifecycle: openEnum(ENTITY_LIFECYCLE.values),
    closedAt: orNull(InstantSchema),
    verificationStatus: openEnum(QUALIFICATION_STATUS.values),
    usccMask: orNull(z.string()),
    legalRepNameMask: orNull(z.string()),
    verifiedAt: orNull(InstantSchema),
    sourceType: openEnum(SOURCE_TYPE.values),
    referralCode: orNull(
      z.strictObject({ referralCodeId: IdSchema, code: z.string(), label: orNull(z.string()) }),
    ),
    createdAt: InstantSchema,
    owner: orNull(MerchantUserBriefSchema),
    subscription: SubscriptionBriefSchema,
    usage: z.strictObject({
      storesUsed: count,
      storeLimit: count,
      seatsUsed: count,
      memberLimit: orNull(count),
      storesOver: count,
      seatsOver: count,
      limitReason: openEnum(["plan", "inactive"]),
      storeLimitOverride: orNull(count),
      memberLimitOverride: orNull(count),
      pendingInvitationCount: count,
      activeMemberCount: count,
      isOverLimit: z.boolean(),
    }),
    spendablePoints: count,
    stores: z.array(EntityStoreRowSchema),
    pendingInvitations: z.array(PendingInvitationRowSchema),
    lockVersion: count,
    actions: z.array(z.string()),
  })
  .openapi("EntityCard");
export type EntityCard = z.infer<typeof EntityCardSchema>;
export type EntityStoreRow = z.infer<typeof EntityStoreRowSchema>;
export type MemberRow = z.infer<typeof MemberRowSchema>;
export type EntityMemberList = z.infer<typeof EntityMemberListSchema>;
export type EntityMemberListQuery = z.infer<typeof EntityMemberListQuerySchema>;
