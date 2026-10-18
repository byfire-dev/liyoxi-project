import { IdSchema, DateSchema } from "../common/index.js";
import { z } from "../zod.js";
export const dramaCreatedPayload = z.strictObject({
  v: z.literal(1),
  dramaId: IdSchema,
  fromState: z.null(),
  toState: z.literal("draft"),
  transition: z.literal("drama.create"),
});
const firstDramaListedPayload = z.strictObject({
  v: z.literal(1),
  dramaId: IdSchema,
  isRelist: z.literal(false),
  fromState: z.literal("draft"),
  toState: z.literal("listed"),
  transition: z.literal("drama.list"),
});
export const dramaListedPayload = z.union([
  firstDramaListedPayload,
  z.strictObject({
    v: z.literal(1),
    dramaId: IdSchema,
    isRelist: z.literal(true),
    fromState: z.literal("delisted"),
    toState: z.literal("listed"),
    transition: z.literal("drama.relist"),
  }),
]);
export const dramaTierChangedPayload = z.strictObject({
  v: z.literal(1),
  dramaId: IdSchema,
  fromTier: z.enum(["S", "A", "B", "C"]).nullable(),
  toTier: z.enum(["S", "A", "B", "C"]).nullable(),
});
export const dramaLicenseExtendedPayload = z.strictObject({
  v: z.literal(1),
  dramaId: IdSchema,
  dramaCopyrightRevisionId: IdSchema,
  prevEndDate: DateSchema,
  newEndDate: DateSchema,
});
export const dramaLicenseScopeChangedPayload = z.strictObject({
  v: z.literal(1),
  dramaId: IdSchema,
  dramaCopyrightRevisionId: IdSchema,
  platformsRemoved: z.array(z.enum(["douyin", "wechat_channels"])),
  platformsAdded: z.array(z.enum(["douyin", "wechat_channels"])),
  isTerritoryChanged: z.boolean(),
});
export const dramaDelistedPayload = z.strictObject({
  v: z.literal(1),
  dramaId: IdSchema,
  reasonCode: z.enum([
    "ops_strategy",
    "rights_issue",
    "content_revision",
    "other",
    "license_expired",
  ]),
  fromState: z.literal("listed"),
  toState: z.literal("delisted"),
  transition: z.enum(["drama.delist", "drama.license_expire"]),
});
export const payloads = {
  "drama.permit_changed": z.strictObject({
    v: z.literal(1),
    dramaId: IdSchema,
    dramaPermitId: IdSchema,
    platform: z.enum(["all", "douyin", "wechat_channels"]),
  }),
  "drama.masters_changed": z.strictObject({
    v: z.literal(1),
    dramaId: IdSchema,
    uploadBatchId: IdSchema,
    episodeNos: z.array(z.int().positive()),
    isContentChanged: z.boolean(),
  }),
  "drama.created": dramaCreatedPayload,
  "drama.tier_changed": dramaTierChangedPayload,
  "drama.license_extended": dramaLicenseExtendedPayload,
  "drama.license_scope_changed": dramaLicenseScopeChangedPayload,
  "drama.delisted": dramaDelistedPayload,
  "drama.listed": dramaListedPayload,
} as const;
