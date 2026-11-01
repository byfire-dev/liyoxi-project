// x01 §3.5；实际退回口径见 d3-flow:376 与 a05 §3.15。
import { IdSchema } from "../common/index.js";
import { z } from "../zod.js";

export const adCancelledPayload = z.strictObject({
  v: z.literal(1),
  adId: IdSchema,
  cancelRequestId: IdSchema,
  /** 本次账本实际回到原批次与转为加购之和。业务行仍分别保存三个实际数量。 */
  returnedPoints: z.int().nonnegative(),
  forfeitedPoints: z.int().nonnegative(),
  fromState: z.enum(["pending_assign", "producing", "revising", "pending_confirm", "returned"]),
  toState: z.literal("cancelled"),
  transition: z.literal("ad.cancel"),
});

const version = z.int().positive();
const identity = { v: z.literal(1), adId: IdSchema };
export const adRequestedPayload = z.strictObject({
  ...identity,
  entityId: IdSchema,
  storeId: IdSchema,
  adType: z.enum(["opening", "ending", "corner", "mid_roll"]),
  points: z.int().nonnegative(),
  fromState: z.null(),
  toState: z.literal("pending_assign"),
  transition: z.literal("ad.submit"),
});
export const adAssignedPayload = z.strictObject({
  ...identity,
  editorId: IdSchema,
  fromState: z.literal("pending_assign"),
  toState: z.literal("producing"),
  transition: z.literal("ad.assign"),
});
export const adReturnedPayload = z
  .strictObject({
    ...identity,
    returnedFrom: z.enum(["pending_assign", "producing"]),
    fromState: z.enum(["pending_assign", "producing"]),
    toState: z.literal("returned"),
    transition: z.literal("ad.return"),
  })
  .refine((p) => p.returnedFrom === p.fromState);
export const adResubmittedPayload = z.strictObject({
  ...identity,
  resubmitCount: version,
  fromState: z.literal("returned"),
  toState: z.enum(["pending_assign", "producing"]),
  transition: z.literal("ad.resubmit"),
});
export const adVersionPushedPayload = z.strictObject({
  ...identity,
  versionNo: version,
  previewChannels: z.array(z.enum(["weapp", "album", "portal", "wecom"])).min(1),
  fromState: z.enum(["producing", "revising"]),
  toState: z.literal("pending_confirm"),
  transition: z.literal("ad.push_version"),
});
export const adConfirmedPayload = z.strictObject({
  ...identity,
  versionNo: version,
  viewedVia: z.enum(["weapp", "album", "portal", "wecom"]),
  fromState: z.literal("pending_confirm"),
  toState: z.literal("confirmed"),
  transition: z.literal("ad.confirm"),
});
export const adRevisionRequestedPayload = z.strictObject({
  ...identity,
  revisionNo: version,
  onVersionNo: version,
  isCharged: z.boolean(),
  fromState: z.enum(["pending_confirm", "confirmed"]),
  toState: z.literal("revising"),
  transition: z.literal("ad.request_revision"),
});
export const adReturnedStalePayload = z.strictObject({
  ...identity,
  storeId: IdSchema,
  returnedAt: z.iso.datetime({ offset: true }),
});
export const payloads = {
  "ad.cancelled": adCancelledPayload,
  "ad.requested": adRequestedPayload,
  "ad.assigned": adAssignedPayload,
  "ad.returned": adReturnedPayload,
  "ad.resubmitted": adResubmittedPayload,
  "ad.version_pushed": adVersionPushedPayload,
  "ad.confirmed": adConfirmedPayload,
  "ad.revision_requested": adRevisionRequestedPayload,
  "ad.returned_stale": adReturnedStalePayload,
} as const;
