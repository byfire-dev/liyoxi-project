import { z } from "../../zod.js";
import {
  CursorQuerySchema,
  cursorPage,
  IdSchema,
  InstantSchema,
  DateSchema,
  orNull,
} from "../../common/index.js";
import { SignedUrlSchema } from "../a01-system/files.schemas.js";
import { openEnum } from "../../common/open-enum.js";
import { ORDER_ITEM_PHASE } from "../../enums/order.js";

const size = z.string().regex(/^\d+$/);
export const PortalOrderItemParamsSchema = z.strictObject({ orderItemId: IdSchema });
export const PortalOrderItemListQuerySchema = CursorQuerySchema.extend({
  tab: z.enum(["all", "downloadable", "sample_pending"]).default("all"),
}).strict();
export const PortalGrantViewSchema = z
  .strictObject({
    state: z.enum(["active", "superseded", "revoked"]),
    expiresAt: InstantSchema,
    isExpired: z.boolean(),
  })
  .openapi("PortalGrantView");
export const DownloadBlockerSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("grant_invalid"),
      reason: openEnum(["expired", "superseded", "revoked", "missing"]),
    }),
    z.strictObject({
      kind: z.literal("not_available"),
      reason: openEnum([
        "not_delivered",
        "release_closed",
        "order_item_closed",
        "usage_ended",
        "file_unavailable",
      ]),
    }),
  ])
  .openapi("DownloadBlocker");
export const PortalReleaseBriefSchema = z
  .strictObject({
    deliveryReleaseId: IdSchema,
    releaseNo: z.int().positive(),
    kind: z.enum(["initial", "reissue"]),
    pushedAt: InstantSchema,
    episodeCount: z.int().positive(),
    totalBytes: size,
    changedEpisodeNos: z.array(z.int().positive()),
  })
  .openapi("PortalReleaseBrief");
export const PortalOrderItemCardSchema = z
  .strictObject({
    orderItemId: IdSchema,
    orderId: IdSchema,
    orderNo: z.string(),
    dramaTitle: z.string(),
    poster: orNull(SignedUrlSchema),
    episodeCount: z.int().positive(),
    phase: openEnum(ORDER_ITEM_PHASE.values),
    usageEndDate: DateSchema,
    release: orNull(PortalReleaseBriefSchema),
    grant: orNull(PortalGrantViewSchema),
    isDownloadable: z.boolean(),
    downloadBlocker: orNull(DownloadBlockerSchema),
    // Q9 retains the historical field without restoring portal sample preview eligibility.
    pendingSample: z.null(),
    activityAt: InstantSchema,
  })
  .openapi("PortalOrderItemCard");
export const PortalOrderItemPageSchema =
  cursorPage(PortalOrderItemCardSchema).openapi("PortalOrderItemPage");
export const PortalReleaseViewSchema = PortalReleaseBriefSchema.extend({
  orderItemId: IdSchema,
  orderNo: z.string(),
  dramaTitle: z.string(),
  usageEndDate: DateSchema,
  state: z.enum(["pushed", "superseded", "closed"]),
  closeReason: orNull(z.enum(["cancelled", "usage_ended"])),
  reissueReason: orNull(z.strictObject({ code: z.string(), name: z.string() })),
  episodes: z.array(
    z.strictObject({
      episodeNo: z.int().positive(),
      fileName: z.string(),
      sizeBytes: size,
      isChanged: z.boolean(),
      lastPortalDownloadAt: orNull(InstantSchema),
    }),
  ),
  grant: orNull(PortalGrantViewSchema),
  isDownloadable: z.boolean(),
  downloadBlocker: orNull(DownloadBlockerSchema),
  zipFileName: z.string(),
  hasPublishList: z.boolean(),
}).openapi("PortalReleaseView");
export const PortalDownloadBodySchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("episode"),
      episodeNo: z.int().positive(),
      retry: z.boolean().optional(),
    }),
    z.strictObject({ kind: z.literal("zip"), retry: z.boolean().optional() }),
    z.strictObject({ kind: z.literal("publish_list"), retry: z.boolean().optional() }),
  ])
  .openapi("PortalDownloadBody");
export const PortalDownloadResultSchema = z
  .strictObject({
    kind: z.enum(["episode", "zip", "publish_list"]),
    state: z.enum(["ready", "building", "failed", "none"]),
    downloadId: orNull(IdSchema),
    episodeNo: orNull(z.int().positive()),
    url: orNull(z.string()),
    expiresAt: orNull(InstantSchema),
    fileName: orNull(z.string()),
    sizeBytes: orNull(size),
    pollAfterSec: orNull(z.literal(5)),
  })
  .superRefine((value, ctx) => {
    const ready = value.state === "ready";
    if (
      [value.downloadId, value.url, value.expiresAt, value.fileName, value.sizeBytes].some(
        (v) => (v !== null) !== ready,
      ) ||
      (value.kind === "episode" && (!ready || value.episodeNo === null)) ||
      (value.kind !== "episode" && value.episodeNo !== null) ||
      (value.state === "none" && value.kind !== "publish_list") ||
      (value.pollAfterSec === 5) !== (value.kind === "zip" && value.state === "building")
    )
      ctx.addIssue({ code: "custom", message: "下载结果与状态不一致" });
  })
  .openapi("PortalDownloadResult");
export type PortalOrderItemListQuery = z.infer<typeof PortalOrderItemListQuerySchema>;
export type PortalOrderItemPage = z.infer<typeof PortalOrderItemPageSchema>;
export type PortalReleaseView = z.infer<typeof PortalReleaseViewSchema>;
export type PortalDownloadBody = z.infer<typeof PortalDownloadBodySchema>;
export type PortalDownloadResult = z.infer<typeof PortalDownloadResultSchema>;
export type DownloadBlocker = z.infer<typeof DownloadBlockerSchema>;
