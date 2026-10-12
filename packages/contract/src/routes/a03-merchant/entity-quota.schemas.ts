import { z } from "../../zod.js";

const int4 = z.int().min(0).max(2_147_483_647);
const storeLimit = int4.min(1).nullable();
const memberLimit = int4.nullable();
export const EntityQuotaUpdateBodySchema = z
  .strictObject({
    storeLimitOverride: storeLimit.optional(),
    memberLimitOverride: memberLimit.optional(),
    lockVersion: int4,
    confirm: z.strictObject({ storeLimitOverride: storeLimit, memberLimitOverride: memberLimit }),
    reasonText: z.string().refine((value) => {
      const length = Array.from(value).length;
      return length >= 1 && length <= 200;
    }, "原因须为1至200字"),
  })
  .refine(
    (value) => value.storeLimitOverride !== undefined || value.memberLimitOverride !== undefined,
    "至少填写一项额度覆盖",
  )
  .openapi("EntityQuotaUpdateBody");
export type EntityQuotaUpdateBody = z.infer<typeof EntityQuotaUpdateBodySchema>;
