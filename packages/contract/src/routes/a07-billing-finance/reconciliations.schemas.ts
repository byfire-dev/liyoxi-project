import { z } from "../../zod.js";
import { DateSchema, IdSchema, InstantSchema } from "../../common/index.js";
import {
  RECON_DAY_STATUS,
  WX_BILL_FILE_STATUS,
  PAYMENT_EXCEPTION_RESOLUTION,
} from "../../enums/index.js";
import { PaymentExceptionRowSchema } from "./payment-exceptions.schemas.js";

const amount = z.string().regex(/^\d+$/);
const signed = z.string().regex(/^-?\d+$/);
const count = z.int().nonnegative();
const moneyCount = z.object({ count, amountFen: amount });
export const ReconciliationMonthQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});
export const ReconciliationParamsSchema = z.object({ reconciliationId: IdSchema });
export const ReconciliationRerunBodySchema = z.object({
  confirm: z.object({ billDate: DateSchema }),
});
export const ReconDayRowSchema = z
  .object({
    billDate: DateSchema,
    reconciliationId: IdSchema.nullable(),
    platformPay: moneyCount,
    billPay: moneyCount.nullable(),
    bank: moneyCount.nullable(),
    refund: z
      .object({ platformCount: count, platformFen: amount, billCount: count, billFen: amount })
      .nullable(),
    feeFen: signed,
    diff: moneyCount
      .extend({
        resolutions: z.array(
          z.object({ resolution: z.enum(PAYMENT_EXCEPTION_RESOLUTION.values), amountFen: amount }),
        ),
      })
      .nullable(),
    status: z.enum(RECON_DAY_STATUS.values),
    billFileStatus: z.enum(WX_BILL_FILE_STATUS.values).nullable(),
    runCount: count,
    lastRunAt: InstantSchema.nullable(),
    actions: z.array(z.enum(["resolve", "rerun"])),
  })
  .openapi("ReconDayRow");
export const ReconMonthSchema = z
  .object({
    items: z.array(ReconDayRowSchema).max(31),
    month: ReconciliationMonthQuerySchema.shape.month,
    overview: z.object({
      platform: moneyCount.extend({ wechatCount: count, bankCount: count }),
      wechatBill: moneyCount.extend({ downloadedThrough: DateSchema.nullable() }),
      refund: moneyCount.extend({ isBillMatched: z.boolean() }),
      diff: z.object({
        openCount: count,
        openAmountFen: amount,
        resolvingCount: count,
        earliestOpenBillDate: DateSchema.nullable(),
      }),
    }),
    dayStatusCounts: z.object({ ok: count, diff: count, fixed: count, wait: count }),
    openExceptions: z.array(PaymentExceptionRowSchema).max(20),
    prevMonthAllOk: z.boolean(),
  })
  .openapi("ReconMonth");
export type ReconciliationMonthQuery = z.infer<typeof ReconciliationMonthQuerySchema>;
export type ReconciliationRerunBody = z.infer<typeof ReconciliationRerunBodySchema>;
export type ReconDayRow = z.infer<typeof ReconDayRowSchema>;
export type ReconMonth = z.infer<typeof ReconMonthSchema>;
