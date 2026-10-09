import { DateSchema, IdSchema, InstantSchema, PageQuerySchema } from "../../common/index.js";
import {
  MEDIA_JOB_KIND,
  MEDIA_JOB_MODE,
  MEDIA_JOB_STATE,
  MEDIA_JOB_SUBJECT_TYPE,
  MEDIA_JOB_PARENT_TYPE,
} from "../../enums/index.js";
import { z } from "../../zod.js";
import { adminPage } from "./structures.js";
const csv = (values: readonly string[]) =>
  z
    .string()
    .min(1)
    .max(1000)
    .refine((value) => value.split(",").every((one) => values.includes(one)), "查询值未登记")
    .transform((value) => [...new Set(value.split(","))]);
export const MediaJobListQuerySchema = PageQuerySchema.extend({
  state: csv(MEDIA_JOB_STATE.values).default(["failed"]),
  kind: csv(MEDIA_JOB_KIND.values).optional(),
  subjectType: z.enum(MEDIA_JOB_SUBJECT_TYPE.values).optional(),
  subjectId: IdSchema.optional(),
  parentType: z.enum(MEDIA_JOB_PARENT_TYPE.values).optional(),
  parentId: IdSchema.optional(),
  createdFrom: DateSchema.optional(),
  createdTo: DateSchema.optional(),
  sort: z.enum(["-finishedAt", "-createdAt"]).default("-finishedAt"),
})
  .superRefine((value, ctx) => {
    for (const [type, id] of [
      ["subjectType", "subjectId"],
      ["parentType", "parentId"],
    ] as const)
      if (Boolean(value[type]) !== Boolean(value[id]))
        ctx.addIssue({ code: "custom", path: [id], message: "类型与id须同有同无" });
    if (Boolean(value.createdFrom) !== Boolean(value.createdTo))
      ctx.addIssue({ code: "custom", path: ["createdTo"], message: "日期范围须成对" });
    if (value.createdFrom && value.createdTo && value.createdFrom > value.createdTo)
      ctx.addIssue({ code: "custom", path: ["createdTo"], message: "日期范围倒置" });
  })
  .openapi("MediaJobListQuery");
export type MediaJobListQuery = z.infer<typeof MediaJobListQuerySchema>;
export const MediaJobNoteBodySchema = z
  .strictObject({
    note: z
      .string()
      .trim()
      .refine((value) => Array.from(value).length <= 200, "至多200字")
      .optional(),
  })
  .openapi("MediaJobNoteBody");
export const MediaJobViewSchema = z
  .object({
    mediaJobId: IdSchema,
    kind: z.enum(MEDIA_JOB_KIND.values),
    provider: z.string(),
    mode: z.enum(MEDIA_JOB_MODE.values),
    subject: z.object({ type: z.enum(MEDIA_JOB_SUBJECT_TYPE.values), id: IdSchema }),
    parent: z.object({ type: z.enum(MEDIA_JOB_PARENT_TYPE.values), id: IdSchema }).nullable(),
    state: z.enum(MEDIA_JOB_STATE.values),
    attemptNo: z.int().nonnegative(),
    maxAttempts: z.int().positive(),
    externalJobId: z.string().nullable(),
    error: z
      .object({
        code: z.string().nullable(),
        message: z.string().nullable(),
        isRetryable: z.boolean(),
      })
      .nullable(),
    nextRunAt: InstantSchema,
    deadlineAt: InstantSchema,
    billable: z
      .object({
        qty: z.string().regex(/^\d+\.\d{3}$/),
        unit: z.string().nullable(),
        estCostMicro: z.string().regex(/^\d+$/).nullable(),
      })
      .nullable(),
    startedAt: InstantSchema.nullable(),
    finishedAt: InstantSchema.nullable(),
    createdAt: InstantSchema,
    actions: z.array(z.literal("retry")),
  })
  .openapi("MediaJobView");
export type MediaJobView = z.infer<typeof MediaJobViewSchema>;
export const MediaJobPageSchema = adminPage(MediaJobViewSchema).openapi("MediaJobPage");
