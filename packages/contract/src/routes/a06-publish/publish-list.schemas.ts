import { z } from "../../zod.js";
import { IdSchema, InstantSchema, orNull } from "../../common/index.js";
import { StaffBriefSchema } from "../a01-system/structures.js";
import { TicketBriefSchema, OrderItemBriefSchema } from "./publish.schemas.js";
import { ImageRefSchema } from "../m08-support-misc/image.schemas.js";

const text = (max: number) => z.string().max(max).nullable();
export const PublishListTopicsSchema = z
  .array(z.string().min(1).max(21))
  .max(10)
  .refine((items) => {
    const values = items.map((v) => v.replace(/^#/, "").trim());
    return (
      values.every((v) => v.length >= 1 && v.length <= 20) && new Set(values).size === values.length
    );
  });
export const PublishListEpisodeInputSchema = z.strictObject({
  episodeNo: z.int().positive(),
  highlight: text(30),
  title: text(100),
  topics: PublishListTopicsSchema.nullable(),
  intro: text(200),
});
export const PublishListReplaceBodySchema = z.strictObject({
  lockVersion: z.int().nonnegative(),
  collectionName: text(60),
  coverFileId: IdSchema.nullable(),
  titleTemplate: text(100).refine(
    (v) => v === null || !/[{}]/.test(v.replace(/\{(?:剧名|集数|看点)\}/g, "")),
  ),
  topics: PublishListTopicsSchema,
  intro: text(200),
  episodes: z
    .array(PublishListEpisodeInputSchema)
    .refine((rows) => new Set(rows.map((r) => r.episodeNo)).size === rows.length),
});
export const PublishListImportBodySchema = z.strictObject({
  lockVersion: z.int().nonnegative(),
  format: z.enum(["csv", "tsv"]),
  content: z.string().refine((v) => new TextEncoder().encode(v).byteLength <= 200 * 1024),
});
export const PublishListTicketParamsSchema = z.strictObject({ deliveryTicketId: IdSchema });
export const PublishListItemParamsSchema = z.strictObject({ orderItemId: IdSchema });
export const PublishListAdminViewSchema = z
  .strictObject({
    publishListId: IdSchema,
    ticket: TicketBriefSchema,
    orderItem: OrderItemBriefSchema,
    collectionName: z.string().nullable(),
    cover: orNull(
      z.strictObject({
        ...ImageRefSchema.shape,
        url: z.string().nullable(),
        expiresAt: InstantSchema.nullable(),
      }),
    ),
    titleTemplate: z.string().nullable(),
    topics: z.array(z.string()),
    intro: z.string().nullable(),
    isAiDeclarationRequired: z.boolean(),
    episodes: z.array(
      z.strictObject({
        episodeNo: z.int().positive(),
        highlight: z.string().nullable(),
        title: z.string().nullable(),
        renderedTitle: z.string(),
        topics: z.array(z.string()).nullable(),
        intro: z.string().nullable(),
        changedInReleaseNo: z.int().positive().nullable(),
      }),
    ),
    completeness: z.strictObject({
      isComplete: z.boolean(),
      missing: z.array(z.enum(["collection_name", "cover", "intro", "topics", "episode_titles"])),
      untitledEpisodeNos: z.array(z.int().positive()),
    }),
    isEditable: z.boolean(),
    lockReason: z.enum(["links_submitted", "ticket_paused", "ticket_step"]).nullable(),
    savedBy: orNull(StaffBriefSchema),
    savedAt: InstantSchema.nullable(),
    lockVersion: z.int().nonnegative(),
    activeRelease: z
      .strictObject({
        deliveryReleaseId: IdSchema,
        releaseNo: z.int().positive(),
        pushedAt: InstantSchema,
      })
      .nullable(),
  })
  .openapi("PublishListAdminView");
export const PublishListSaveResultSchema = PublishListAdminViewSchema.extend({
  replayed: z.boolean(),
}).openapi("PublishListSaveResult");
export const PublishListImportResultSchema = z
  .strictObject({
    publishList: PublishListAdminViewSchema,
    importedRowCount: z.int().nonnegative(),
    updatedEpisodeNos: z.array(z.int().positive()),
    replayed: z.boolean(),
  })
  .openapi("PublishListImportResult");
export const PublishListViewSchema = z
  .strictObject({
    orderItemId: IdSchema,
    releaseNo: z.int().positive(),
    collectionName: z.string(),
    cover: orNull(ImageRefSchema),
    topics: z.array(z.string()),
    intro: z.string(),
    isAiDeclarationRequired: z.boolean(),
    episodes: z.array(
      z.strictObject({
        episodeNo: z.int().positive(),
        title: z.string(),
        topics: z.array(z.string()),
        intro: z.string().nullable(),
        isUpdated: z.boolean(),
      }),
    ),
    text: z.string().nullable(),
  })
  .openapi("PublishListView");
export type PublishListReplaceBody = z.infer<typeof PublishListReplaceBodySchema>;
export type PublishListImportBody = z.infer<typeof PublishListImportBodySchema>;
export type PublishListEpisodeInput = z.infer<typeof PublishListEpisodeInputSchema>;
export type PublishListAdminView = z.infer<typeof PublishListAdminViewSchema>;
export type PublishListView = z.infer<typeof PublishListViewSchema>;
