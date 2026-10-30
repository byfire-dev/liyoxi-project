import { z } from "../../zod.js";
import { IdSchema, InstantSchema, DateSchema, orNull } from "../../common/index.js";
import { PlayableSchema } from "../m06-ad/playable.schemas.js";
import { SampleAdSlotsSchema } from "../a05-order-delivery/production.schemas.js";
import { ImageRefSchema } from "../m08-support-misc/image.schemas.js";
const n = z.int().nonnegative(),
  text = z.string(),
  at = orNull(InstantSchema),
  via = z.enum(["weapp", "album", "portal", "wecom"]);
export const SampleConfirmBodySchema = z
  .strictObject({ versionNo: z.int().positive(), viewedVia: via, hasViewed: z.boolean() })
  .openapi("SampleConfirmBody");
export const SampleRequestChangeBodySchema = z
  .strictObject({
    feedbackKind: z.literal("compose"),
    note: z.string().trim().min(1).max(200),
    imageFileIds: z
      .array(IdSchema)
      .max(3)
      .refine((ids) => new Set(ids).size === ids.length, { message: "截图不能重复" })
      .optional(),
  })
  .openapi("SampleRequestChangeBody");
export type SampleRequestChangeBody = z.infer<typeof SampleRequestChangeBodySchema>;
export const SampleViewSchema = z
  .strictObject({
    sampleId: IdSchema,
    orderItemId: IdSchema,
    dramaTitle: text,
    versionNo: z.int().positive(),
    status: z.enum(["pushed", "confirmed", "change_requested", "superseded"]),
    durationMs: n,
    pushedAt: InstantSchema,
    previewChannels: z.array(via),
    adSlots: SampleAdSlotsSchema,
    adsUsed: z.array(
      z.strictObject({
        slot: z.enum(["opening", "ending"]),
        adId: IdSchema,
        versionNo: z.int().positive(),
      }),
    ),
    qcSummary: z.array(
      z.strictObject({
        key: text,
        label: text,
        result: z.enum(["pass", "fail", "na"]),
        note: orNull(text),
      }),
    ),
    firstViewedAt: at,
    viewEvidence: z.strictObject({ albumSavedAt: at, portalViewedAt: at }),
    offlineSentAt: at,
    confirmableVia: z.array(via),
    viewedAckAt: at,
    decision: orNull(
      z.strictObject({
        decidedAt: InstantSchema,
        viewedVia: orNull(via),
        feedbackKind: orNull(text),
        feedbackNote: orNull(text),
        feedbackImages: z.array(ImageRefSchema),
        isOnBehalf: z.boolean(),
      }),
    ),
    playable: orNull(PlayableSchema),
    ticketStep: text,
    isPaused: z.boolean(),
    sampleRoundNo: n,
    agreedLaunchDate: orNull(DateSchema),
    actions: z.array(text),
  })
  .openapi("SampleView");
const ReplayImageSchema = ImageRefSchema.extend({ url: orNull(text), expiresAt: at });
export const SampleWriteResultSchema = SampleViewSchema.extend({
  decision: orNull(
    SampleViewSchema.shape.decision.options[0].extend({
      feedbackImages: z.array(ReplayImageSchema),
    }),
  ),
  replayed: z.boolean(),
}).openapi("SampleWriteResult");
