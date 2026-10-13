import {
  DictRefSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
  openEnum,
  orNull,
} from "../../common/index.js";
import { ACCOUNT_CHANGE_REQUEST_KIND, APPROVAL_STATUS } from "../../enums/index.js";
import { z } from "../../zod.js";
import { ApprovalDecisionViewSchema } from "../a01-system/approvals.schemas.js";
import { adminPage } from "../a01-system/structures.js";
import { MerchantUserBriefSchema } from "./entities.schemas.js";

export const AccountChangeRequestIdParamsSchema = z.strictObject({
  accountChangeRequestId: IdSchema,
});
const phone = z.string().regex(/^1[3-9]\d{9}$/, "须为11位中国大陆手机号");
const commonCreate = {
  reasonCode: z.string().min(1),
  reasonText: z.string().trim().min(1).max(500),
  confirm: z.strictObject({ targetPhoneMask: z.string().min(1) }),
};
const requiredProofs = z.array(IdSchema).min(1).max(9);
export const AccountChangeCreateBodySchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...commonCreate,
      kind: z.literal("phone_rebind"),
      merchantUserId: IdSchema,
      newPhone: phone,
      proofFileIds: requiredProofs,
    }),
    z.strictObject({
      ...commonCreate,
      kind: z.literal("owner_transfer"),
      entityId: IdSchema,
      newPhone: phone,
      proofFileIds: requiredProofs,
    }),
    z.strictObject({
      ...commonCreate,
      kind: z.literal("owner_reverify"),
      merchantUserId: IdSchema,
      proofFileIds: z.array(IdSchema).max(9).default([]),
      verifyMethod: z.string().trim().min(1).max(50),
      verifyRecord: z.string().trim().min(1).max(500),
    }),
  ])
  .openapi("AccountChangeCreateBody");

const csv = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .refine(
      (value) => value.split(",").every((part) => values.includes(part)),
      "查询值不在可选范围内",
    )
    .transform((value) => [...new Set(value.split(","))] as T[number][]);
export const AccountChangeListQuerySchema = z.strictObject({
  ...PageQuerySchema.shape,
  entityId: IdSchema.optional(),
  merchantUserId: IdSchema.optional(),
  kind: csv(ACCOUNT_CHANGE_REQUEST_KIND.values).optional(),
  status: csv(APPROVAL_STATUS.values).optional(),
});
const requestNoConfirm = z.strictObject({ requestNo: z.string().min(1) });
export const AccountChangeApproveBodySchema = z
  .strictObject({
    lockVersion: z.int().nonnegative(),
    confirm: requestNoConfirm.extend({ newPhoneMask: orNull(z.string()) }),
    confirmChecks: z.array(z.string().min(1)).max(10).default([]),
  })
  .openapi("AccountChangeApproveBody");
export const AccountChangeRejectBodySchema = z
  .strictObject({ note: z.string().trim().min(1).max(200), confirm: requestNoConfirm })
  .openapi("AccountChangeRejectBody");
export const AccountChangeWithdrawBodySchema = z
  .strictObject({ note: z.string().trim().max(200).optional(), confirm: requestNoConfirm })
  .openapi("AccountChangeWithdrawBody");

export const AccountChangeRequestCardSchema = z
  .strictObject({
    accountChangeRequestId: IdSchema,
    kind: openEnum(ACCOUNT_CHANGE_REQUEST_KIND.values),
    requestNo: z.string(),
    approval: ApprovalDecisionViewSchema,
    target: orNull(MerchantUserBriefSchema),
    entity: orNull(z.strictObject({ entityId: IdSchema, name: orNull(z.string()) })),
    newPhoneMask: orNull(z.string()),
    reason: DictRefSchema,
    reasonText: z.string(),
    appliedAt: orNull(InstantSchema),
    actions: z.array(openEnum(["approve", "reject", "withdraw"])),
  })
  .openapi("AccountChangeRequestCard");
export const AccountChangeResultSchema = z
  .union([
    z.strictObject({ purgedUserId: orNull(IdSchema), prevPhoneMask: z.string() }),
    z.strictObject({
      newOwnerUserId: IdSchema,
      newOwnerAccountCreated: z.boolean(),
      newOwnerMemberId: IdSchema,
      prevOwnerMemberId: IdSchema,
    }),
    z.strictObject({ bypassUntil: InstantSchema }),
  ])
  .openapi("AccountChangeResult");
export const AccountChangeRequestDetailSchema = AccountChangeRequestCardSchema.extend({
  proofFileIds: z.array(IdSchema),
  confirmChecks: z.array(z.string()),
  verifyMethod: orNull(z.string()),
  verifyRecord: orNull(z.string()),
  currentOwner: orNull(MerchantUserBriefSchema),
  precheck: orNull(
    z.strictObject({
      ok: z.boolean(),
      issues: z.array(
        openEnum([
          "phone_taken",
          "phone_occupied_by_empty_account",
          "new_owner_in_other_entity",
          "target_not_active",
          "entity_not_active",
        ]),
      ),
    }),
  ),
  result: orNull(AccountChangeResultSchema),
  createdAt: InstantSchema,
}).openapi("AccountChangeRequestDetail");
export const AccountChangeRequestListSchema = adminPage(AccountChangeRequestCardSchema)
  .strict()
  .openapi("AccountChangeRequestList");

export type AccountChangeCreateBody = z.infer<typeof AccountChangeCreateBodySchema>;
export type AccountChangeListQuery = z.infer<typeof AccountChangeListQuerySchema>;
export type AccountChangeApproveBody = z.infer<typeof AccountChangeApproveBodySchema>;
export type AccountChangeRejectBody = z.infer<typeof AccountChangeRejectBodySchema>;
export type AccountChangeWithdrawBody = z.infer<typeof AccountChangeWithdrawBodySchema>;
export type AccountChangeRequestCard = z.infer<typeof AccountChangeRequestCardSchema>;
export type AccountChangeRequestDetail = z.infer<typeof AccountChangeRequestDetailSchema>;
export type AccountChangeRequestList = z.infer<typeof AccountChangeRequestListSchema>;
export type AccountChangeResult = z.infer<typeof AccountChangeResultSchema>;
