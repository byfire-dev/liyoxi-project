import { z } from "../../zod.js";
import { IdSchema, InstantSchema, PageQuerySchema } from "../../common/index.js";
import { ApprovalDecisionViewSchema } from "../a01-system/approvals.schemas.js";
import { adminPage } from "../a01-system/structures.js";
export const FinanceConfigKeySchema = z.enum(["bank_account", "purchase_policy", "controls"]);
const amount = z.int().nonnegative();
const Controls = z.strictObject({
  adminCreateOrder: z.boolean(),
  wechatSingleLimitFen: amount,
  wechatDailyLimitFen: amount,
  receiptSecondReviewFen: z.int().positive().nullable(),
  shippingReport: z.boolean(),
});
const Policy = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        when: z.strictObject({
          platforms: z
            .array(z.enum(["ios", "android", "harmony", "windows", "mac", "devtools", "unknown"]))
            .optional(),
          versionRange: z.string().min(1).optional(),
          entityIds: z.array(IdSchema).optional(),
          types: z.array(z.enum(["plan_new", "plan_renew", "plan_upgrade", "topup"])).optional(),
          amountGteFen: amount.optional(),
          amountLtFen: amount.optional(),
        }),
        then: z.strictObject({
          mode: z.enum(["in_app", "offline_contract", "hidden"]).optional(),
          channels: z
            .strictObject({
              wechat_jsapi: z.enum(["on", "off"]).optional(),
              bank_transfer: z.enum(["on", "off"]).optional(),
            })
            .optional(),
          copySet: z
            .strictObject({
              planNounKey: z.string().min(1),
              pointsNounKey: z.string().min(1),
              payButtonKey: z.string().min(1),
            })
            .optional(),
        }),
      }),
    )
    .max(100),
});
export const FinanceConfigParamsSchema = z.object({ financeConfigRevisionId: IdSchema });
export const FinanceConfigListQuerySchema = PageQuerySchema.extend({
  tab: z.enum(["current", "history"]).default("current"),
  configKey: FinanceConfigKeySchema.optional(),
  financeConfigRevisionId: IdSchema.optional(),
}).refine((v) => !v.financeConfigRevisionId || v.tab === "history");
export const FinanceConfigViewSchema = z
  .object({
    financeConfigRevisionId: IdSchema,
    configKey: FinanceConfigKeySchema,
    payload: z.union([
      z.object({ accountName: z.string(), bankName: z.string(), accountNoMask: z.string() }),
      Policy,
      Controls,
    ]),
    changeNote: z.string(),
    effectiveAt: InstantSchema.nullable(),
    state: z.enum(["pending", "scheduled", "effective", "superseded", "rejected", "withdrawn"]),
    createdAt: InstantSchema,
    approval: ApprovalDecisionViewSchema,
    actions: z.array(z.string()),
  })
  .openapi("FinanceConfigRevisionView");
export const FinanceConfigListSchema = z.union([
  z.object({ items: z.array(FinanceConfigViewSchema) }),
  adminPage(FinanceConfigViewSchema),
]);
const confirm = z.strictObject({
  configKey: FinanceConfigKeySchema,
  baseRevisionId: IdSchema.nullable(),
});
export const FinanceConfigCreateBodySchema = z.discriminatedUnion("configKey", [
  z.strictObject({
    configKey: z.literal("bank_account"),
    payload: z.strictObject({
      accountName: z.string().trim().min(1).max(200),
      bankName: z.string().trim().min(1).max(200),
      accountNo: z.string().regex(/^[0-9\s]{8,64}$/),
    }),
    changeNote: z.string().trim().min(1).max(200),
    confirm,
  }),
  z.strictObject({
    configKey: z.literal("purchase_policy"),
    payload: Policy,
    changeNote: z.string().trim().min(1).max(200),
    confirm,
  }),
  z.strictObject({
    configKey: z.literal("controls"),
    payload: Controls,
    changeNote: z.string().trim().min(1).max(200),
    confirm,
  }),
]);
export const FinanceConfigApproveBodySchema = z.strictObject({
  lockVersion: z.int().nonnegative(),
  confirmChecks: z
    .array(z.string())
    .max(10)
    .refine((v) => v.includes("change_reviewed")),
  confirm: z.strictObject({
    configKey: FinanceConfigKeySchema,
    financeConfigRevisionId: IdSchema,
    accountNoLast4: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
  }),
  note: z.string().max(200).optional(),
});
export const FinanceConfigRejectBodySchema = z.strictObject({
  note: z.string().trim().min(1).max(200),
});
export const FinanceConfigWithdrawBodySchema = z.strictObject({
  note: z.string().trim().max(200).optional(),
});
export type FinanceConfigListQuery = z.infer<typeof FinanceConfigListQuerySchema>;
export type FinanceConfigCreateBody = z.infer<typeof FinanceConfigCreateBodySchema>;
export type FinanceConfigApproveBody = z.infer<typeof FinanceConfigApproveBodySchema>;
export type FinanceConfigRejectBody = z.infer<typeof FinanceConfigRejectBodySchema>;
export type FinanceConfigWithdrawBody = z.infer<typeof FinanceConfigWithdrawBodySchema>;
