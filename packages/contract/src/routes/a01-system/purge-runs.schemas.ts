import { IdSchema, InstantSchema, PageQuerySchema, orNull } from "../../common/index.js";
import { FILE_PURGE_RUN_MODE, FILE_PURGE_RUN_STATE } from "../../enums/index.js";
import { z } from "../../zod.js";
import { ReasonRequiredBodySchema } from "./files.schemas.js";
import { StaffBriefSchema, adminPage } from "./structures.js";

const bytes = z.string().regex(/^\d+$/);
export const PurgeRunListQuerySchema = PageQuerySchema.extend({
  state: z
    .string()
    .min(1)
    .max(1000)
    .refine(
      (value) =>
        value.split(",").every((one) => FILE_PURGE_RUN_STATE.values.some((state) => state === one)),
      "查询值未登记",
    )
    .transform((value) => [...new Set(value.split(","))])
    .default(["proposed", "held"]),
}).openapi("PurgeRunListQuery");
export type PurgeRunListQuery = z.infer<typeof PurgeRunListQuerySchema>;
export const PurgeRunViewSchema = z
  .object({
    purgeRunId: IdSchema,
    mode: z.enum(FILE_PURGE_RUN_MODE.values),
    state: z.enum(FILE_PURGE_RUN_STATE.values),
    candidateCount: z.int().min(0).max(5000),
    candidateBytes: bytes,
    byCategory: z.record(z.string(), z.object({ count: z.int().nonnegative(), bytes })),
    heldReason: orNull(z.string()),
    decidedBy: orNull(StaffBriefSchema),
    decidedAt: orNull(InstantSchema),
    deletedCount: orNull(z.int().nonnegative()),
    guardTrips: orNull(z.int().nonnegative()),
    startedAt: orNull(InstantSchema),
    finishedAt: orNull(InstantSchema),
    createdAt: InstantSchema,
    actions: z.array(z.enum(["approve", "reject"])),
  })
  .openapi("PurgeRunView");
export type PurgeRunView = z.infer<typeof PurgeRunViewSchema>;
export const PurgeRunPageSchema = adminPage(PurgeRunViewSchema).openapi("PurgeRunPage");
export const PurgeRunIdParamsSchema = z.object({ purgeRunId: IdSchema });
export const PurgeApproveBodySchema = z
  .strictObject({
    confirm: z.strictObject({ candidateCount: z.int().min(0).max(5000), candidateBytes: bytes }),
    note: z
      .string()
      .trim()
      .refine((value) => [...value].length <= 200, "至多200字")
      .optional(),
  })
  .openapi("PurgeApproveBody");
export type PurgeApproveBody = z.infer<typeof PurgeApproveBodySchema>;
export const PurgeRejectBodySchema = ReasonRequiredBodySchema;
export type PurgeRejectBody = z.infer<typeof PurgeRejectBodySchema>;
