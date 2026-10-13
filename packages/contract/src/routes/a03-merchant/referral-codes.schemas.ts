import { IdSchema, InstantSchema, PageQuerySchema, openEnum, orNull } from "../../common/index.js";
import { z } from "../../zod.js";
import { adminPage, StaffBriefSchema } from "../a01-system/structures.js";
const sourceTypes = ["sales", "campaign", "partner"] as const;
const statuses = ["active", "disabled"] as const;
const csv = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .refine((value) => value.split(",").every((part) => values.includes(part)), "筛选值不合法")
    .transform((value) => [...new Set(value.split(","))] as T[number][]);
export const ReferralCodeListQuerySchema = z.strictObject({
  ...PageQuerySchema.shape,
  q: z.string().trim().min(1).max(30).optional(),
  sourceType: csv(sourceTypes).optional(),
  status: csv(statuses).optional(),
  ownerStaffId: IdSchema.optional(),
});
export const ReferralCodeCreateBodySchema = z
  .strictObject({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9A-Z]{4,16}$/),
    sourceType: z.enum(["sales", "campaign"]),
    ownerStaffId: IdSchema.optional(),
    label: z.string().trim().max(30).optional(),
  })
  .refine((value) => value.sourceType !== "sales" || value.ownerStaffId !== undefined, {
    path: ["ownerStaffId"],
    message: "销售码必须选择归属员工",
  });
export const ReferralCodeParamsSchema = z.strictObject({ referralCodeId: IdSchema });
export const ReferralCodeDisableBodySchema = z.strictObject({
  reasonText: z.string().trim().max(200).optional(),
});
export const ReferralCodeEnableBodySchema = z.strictObject({});
export const ReferralCodeRowSchema = z
  .strictObject({
    referralCodeId: IdSchema,
    code: z.string(),
    sourceType: openEnum(sourceTypes),
    owner: orNull(StaffBriefSchema),
    label: orNull(z.string()),
    status: openEnum(statuses),
    disabledAt: orNull(InstantSchema),
    registeredUserCount: z.int().nonnegative(),
    entityCount: z.int().nonnegative(),
    createdAt: InstantSchema,
  })
  .openapi("ReferralCodeRow");
export const ReferralCodeListSchema = adminPage(ReferralCodeRowSchema).strict();
export type ReferralCodeRow = z.infer<typeof ReferralCodeRowSchema>;
export type ReferralCodeList = z.infer<typeof ReferralCodeListSchema>;
export type ReferralCodeListQuery = z.infer<typeof ReferralCodeListQuerySchema>;
export type ReferralCodeCreateBody = z.infer<typeof ReferralCodeCreateBodySchema>;
export type ReferralCodeDisableBody = z.infer<typeof ReferralCodeDisableBodySchema>;
