// W2-18：批头不合法拒绝整批；单条错误由接收服务计 rejected，不能让一个坏事件堵住其余事件。
import { ANALYTICS_CODE_PATTERN, NETWORK_TYPES } from "../../analytics/events.js";
import type { ClientEventProps } from "../../analytics/events.js";
import { InstantInputSchema } from "../../common/index.js";
import { SUBSCRIBE_POINT_KEYS } from "../../notify/index.js";
import { z } from "../../zod.js";

// 短编码仍不能装手机号；证照号长度本来就超过 Code 上限。
const code = z
  .string()
  .regex(ANALYTICS_CODE_PATTERN)
  .refine((v) => !/^1[3-9]\d{9}$/.test(v));
const uuid = z.uuid();
const quality = z.enum(["hd", "sd"]);
const network = z.enum(NETWORK_TYPES);
export const CLIENT_EVENT_PROP_SCHEMAS = {
  app_launch: z.strictObject({ channelCode: code.optional(), hasInvitation: z.boolean() }),
  profile_step_save: z.strictObject({
    step: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    durationMs: z.int().nonnegative(),
  }),
  store_switch: z.strictObject({ fromPage: code }),
  mall_view: z.strictObject({
    category: code.optional(),
    filters: z
      .strictObject({
        genre: code.optional(),
        industry: code.optional(),
        episodes: code.optional(),
        price: code.optional(),
      })
      .optional(),
    sort: z.enum(["composite", "heat", "price_asc", "price_desc", "newest"]).optional(),
    mode: z.enum(["list", "trailer"]),
  }),
  trailer_play: z.strictObject({
    dramaId: uuid,
    playMs: z.int().min(0).max(3_600_000),
    finished: z.boolean(),
  }),
  drama_detail_view: z.strictObject({ dramaId: uuid, fromPage: code }),
  share_click: z.strictObject({ page: code, dramaId: uuid.optional() }),
  banner_click: z.strictObject({ homeBannerId: uuid }),
  playback_fallback: z.strictObject({
    playableId: uuid,
    network,
    fromQuality: quality,
    toQuality: quality,
    sdkVersion: z
      .string()
      .regex(/^\d+(\.\d+){0,3}$/)
      .optional(),
  }),
  trailer_first_frame: z.strictObject({
    playableId: uuid,
    firstFrameMs: z.int().nonnegative(),
    network,
    quality,
  }),
} satisfies { [K in keyof ClientEventProps]: z.ZodType<ClientEventProps[K]> };

const eventBase = { eventId: uuid, occurredAt: InstantInputSchema, storeId: uuid.optional() };
export const ClientAnalyticsEventSchema = z
  .discriminatedUnion("name", [
    z.strictObject({
      ...eventBase,
      name: z.literal("app_launch"),
      props: CLIENT_EVENT_PROP_SCHEMAS.app_launch,
    }),
    z.strictObject({
      ...eventBase,
      name: z.literal("profile_step_save"),
      props: CLIENT_EVENT_PROP_SCHEMAS.profile_step_save,
    }),
    z.strictObject({
      ...eventBase,
      name: z.literal("store_switch"),
      props: CLIENT_EVENT_PROP_SCHEMAS.store_switch,
    }),
    z.strictObject({
      ...eventBase,
      name: z.literal("mall_view"),
      props: CLIENT_EVENT_PROP_SCHEMAS.mall_view,
    }),
    z.strictObject({
      ...eventBase,
      name: z.literal("trailer_play"),
      props: CLIENT_EVENT_PROP_SCHEMAS.trailer_play,
    }),
    z.strictObject({
      ...eventBase,
      name: z.literal("drama_detail_view"),
      props: CLIENT_EVENT_PROP_SCHEMAS.drama_detail_view,
    }),
    z.strictObject({
      ...eventBase,
      name: z.literal("share_click"),
      props: CLIENT_EVENT_PROP_SCHEMAS.share_click,
    }),
    z.strictObject({
      ...eventBase,
      name: z.literal("banner_click"),
      props: CLIENT_EVENT_PROP_SCHEMAS.banner_click,
    }),
    z.strictObject({
      ...eventBase,
      name: z.literal("playback_fallback"),
      props: CLIENT_EVENT_PROP_SCHEMAS.playback_fallback,
    }),
    z.strictObject({
      ...eventBase,
      name: z.literal("trailer_first_frame"),
      props: CLIENT_EVENT_PROP_SCHEMAS.trailer_first_frame,
    }),
  ])
  .openapi("ClientAnalyticsEvent");
export type ClientAnalyticsEvent = z.infer<typeof ClientAnalyticsEventSchema>;

export const AnalyticsEventBatchSchema = z
  .strictObject({
    sentAt: InstantInputSchema,
    anonymousId: uuid,
    sessionId: uuid,
    clientVersion: z.string().max(16),
    platform: z.enum(["ios", "android", "harmony", "windows", "mac", "devtools"]),
    scene: z.int().optional(),
    // 单条仍按 ClientAnalyticsEventSchema 严格校验；这里只校验批次形状，遵守 m08 3.26 的部分拒收。
    events: z
      .array(z.union([ClientAnalyticsEventSchema, z.unknown()]))
      .min(1)
      .max(50)
      .openapi({
        description: "逐条按 ClientAnalyticsEvent 校验；坏事件计入 rejected，其余照常接收",
      }),
  })
  .openapi("AnalyticsEventBatch");
export type AnalyticsEventBatch = z.infer<typeof AnalyticsEventBatchSchema>;
export const AnalyticsIngestResultSchema = z
  .object({
    accepted: z.int().nonnegative(),
    duplicated: z.int().nonnegative(),
    rejected: z.int().nonnegative(),
    dropped: z.int().nonnegative(),
  })
  .openapi("AnalyticsIngestResult");
export type AnalyticsIngestResult = z.infer<typeof AnalyticsIngestResultSchema>;
export const SubscribeResultBodySchema = z
  .strictObject({
    reportId: uuid,
    point: z.enum(SUBSCRIBE_POINT_KEYS),
    results: z
      .array(
        z.strictObject({
          tmplId: z.string().min(1).max(64),
          result: z.enum(["accept", "reject", "ban", "filter"]),
        }),
      )
      .min(1)
      .max(5),
  })
  .openapi("SubscribeResultBody");
export type SubscribeResultBody = z.infer<typeof SubscribeResultBodySchema>;
export const SubscribeResultOutcomeSchema = z
  .object({ appliedCount: z.int().nonnegative(), ignoredCount: z.int().nonnegative() })
  .openapi("SubscribeResultOutcome");
export type SubscribeResultOutcome = z.infer<typeof SubscribeResultOutcomeSchema>;
