import { z } from "../../zod.js";
import { IdSchema, orNull } from "../../common/index.js";
import { MERCHANT_USER_STATUS } from "../../enums/index.js";
import { zodEnum } from "../../enums/zod.js";

export const MerchantUserIdParamsSchema = z.strictObject({ merchantUserId: IdSchema });
const confirm = z.strictObject({ phoneMask: z.string().min(1) });
export const MerchantUserStatusBodySchema = z.strictObject({
  reasonText: z.string().trim().min(1).max(200),
  confirm,
});
export const MerchantUserForceLogoutBodySchema = z.strictObject({
  reasonText: z.string().trim().min(1).max(200).optional(),
  confirm,
});
export const MerchantUserStatusViewSchema = z
  .object({
    merchantUserId: IdSchema,
    status: zodEnum(MERCHANT_USER_STATUS),
    phoneMask: orNull(z.string()),
    revokedSessionCount: z.int().nonnegative(),
    revokedPortalSessionCount: z.int().nonnegative(),
    activeOwnerEntityIds: z.array(IdSchema),
  })
  .openapi("MerchantUserStatusView");
export type MerchantUserStatusBody = z.infer<typeof MerchantUserStatusBodySchema>;
export type MerchantUserForceLogoutBody = z.infer<typeof MerchantUserForceLogoutBodySchema>;
export type MerchantUserStatusView = z.infer<typeof MerchantUserStatusViewSchema>;
