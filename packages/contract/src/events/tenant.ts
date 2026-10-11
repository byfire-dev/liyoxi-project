// tenant 模块发出的事件的载荷（docs/api/x01-events-jobs.md 第 3.2 节；01 分组 第 4 节）。
// 载荷规则见 x01 第 2.3 节 P1–P7：{ v: 数字, … }，只放 id 与枚举；迁移事件带三个迁移键（P4），由 flow.transition() 补上。
// W1-03 创建事件与 W2-10 主体关闭联动；成员/门店的其他迁移仍按正式目录共享载荷。
import { IdSchema, orNull } from "../common/index.js";
import {
  ENTITY_LIFECYCLE,
  STORE_LIFECYCLE,
  STORE_ARCHIVE_REASON,
  ENTITY_MEMBER_REMOVE_REASON,
  MERCHANT_ROLE,
} from "../enums/index.js";
import { zodEnum } from "../enums/zod.js";
import { z } from "../zod.js";

/** entity.created：迁移码 entity.create（02:523），聚合 entity */
export const entityCreatedPayload = z.strictObject({
  v: z.literal(1),
  entityId: IdSchema,
  /** 同事务建的首店 */
  firstStoreId: IdSchema,
  /** 老板（商家用户 id） */
  ownerUserId: IdSchema,
  fromState: orNull(zodEnum(ENTITY_LIFECYCLE)),
  toState: zodEnum(ENTITY_LIFECYCLE),
  transition: z.literal("entity.create"),
});

/** store.created：迁移码 store.create（02:607），聚合 store */
export const storeCreatedPayload = z.strictObject({
  v: z.literal(1),
  storeId: IdSchema,
  entityId: IdSchema,
  isFirstStore: z.boolean(),
  fromState: orNull(zodEnum(STORE_LIFECYCLE)),
  toState: zodEnum(STORE_LIFECYCLE),
  transition: z.literal("store.create"),
});

export const entityClosedPayload = z.strictObject({
  v: z.literal(1),
  entityId: IdSchema,
  closedBy: z.enum(["owner_deletion", "staff_close"]),
  fromState: z.literal("active"),
  toState: z.literal("closed"),
  transition: z.literal("entity.close"),
});
export const entityAbandonedPayload = z.strictObject({
  v: z.literal(1),
  entityId: IdSchema,
  fromState: z.literal("active"),
  toState: z.literal("abandoned"),
  transition: z.literal("entity.abandon"),
});
export const storeDraftDeletedPayload = z.strictObject({
  v: z.literal(1),
  storeId: IdSchema,
  entityId: IdSchema,
});
export const storeRestoredPayload = z.strictObject({
  v: z.literal(1),
  storeId: IdSchema,
  entityId: IdSchema,
  fromState: z.literal("archived"),
  toState: z.literal("active"),
  transition: z.literal("store.restore"),
});
export const storeArchivedPayload = z.strictObject({
  v: z.literal(1),
  storeId: IdSchema,
  entityId: IdSchema,
  archiveReason: zodEnum(STORE_ARCHIVE_REASON),
  fromState: z.literal("active"),
  toState: z.literal("archived"),
  transition: z.enum(["store.archive", "store.draft_delete", "store.archive_by_entity"]),
});
export const entityMemberRemovedPayload = z.strictObject({
  v: z.literal(1),
  entityMemberId: IdSchema,
  entityId: IdSchema,
  merchantUserId: IdSchema,
  role: zodEnum(MERCHANT_ROLE),
  removeReason: zodEnum(ENTITY_MEMBER_REMOVE_REASON),
  fromState: z.literal("active"),
  toState: z.literal("removed"),
  transition: z.enum([
    "entity_member.remove",
    "entity_member.leave",
    "entity_member.cascade_remove",
  ]),
});
export const invitationRevokedPayload = z.strictObject({
  v: z.literal(1),
  invitationId: IdSchema,
  entityId: IdSchema,
  storeId: IdSchema,
  fromState: z.literal("pending"),
  toState: z.literal("revoked"),
  transition: z.literal("invitation.revoke"),
});

// 门店范围调整不是状态迁移，不带迁移键；邀请接受分支由其 producer 后续交付。
export const entityMemberStoresChangedPayload = z.strictObject({
  v: z.literal(1),
  entityMemberId: IdSchema,
  entityId: IdSchema,
  merchantUserId: IdSchema,
  addedStoreIds: z.array(IdSchema),
  removedStoreIds: z.array(IdSchema),
  invitationId: orNull(IdSchema).optional(),
});

export const payloads = {
  "entity.created": entityCreatedPayload,
  "store.created": storeCreatedPayload,
  "entity.closed": entityClosedPayload,
  "entity.abandoned": entityAbandonedPayload,
  "store.archived": storeArchivedPayload,
  "store.draft_deleted": storeDraftDeletedPayload,
  "store.restored": storeRestoredPayload,
  "entity_member.removed": entityMemberRemovedPayload,
  "entity_member.stores_changed": entityMemberStoresChangedPayload,
  "invitation.revoked": invitationRevokedPayload,
} as const;
