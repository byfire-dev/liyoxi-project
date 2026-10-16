import { DateSchema, FenSchema, IdSchema, InstantSchema } from "../common/scalars.js";
import { SUBSCRIPTION_TERM_STATUS } from "../enums/billing.js";
import { z } from "../zod.js";

/** subscription_event内部历史；旧payload可缺，新写者必须同TX真填。 */
export const SubscriptionDailySnapshotSchema = z
  .strictObject({
    v: z.literal(1),
    termId: IdSchema,
    status: z.enum(SUBSCRIPTION_TERM_STATUS.values),
    planId: IdSchema,
    planRevisionId: IdSchema,
    months: z.int().positive(),
    monthlyEquivFen: FenSchema.nonnegative(),
    startsAt: InstantSchema,
    endsAt: InstantSchema,
    activatedAt: InstantSchema.nullable(),
    pendingGrants: z.array(
      z.strictObject({
        grantScheduleId: IdSchema,
        monthNo: z.int().min(0).max(32767),
        dueDate: DateSchema,
        valueFen: FenSchema.nonnegative(),
      }),
    ),
  })
  .superRefine((snapshot, ctx) => {
    if (
      snapshot.startsAt >= snapshot.endsAt ||
      (snapshot.status === "active" && snapshot.activatedAt === null)
    )
      ctx.addIssue({ code: "custom", message: "周期快照期限或激活事实不完整" });
    const ids = new Set<string>(),
      months = new Set<number>();
    for (const grant of snapshot.pendingGrants) {
      if (ids.has(grant.grantScheduleId) || months.has(grant.monthNo))
        ctx.addIssue({ code: "custom", message: "周期快照发放计划重复" });
      ids.add(grant.grantScheduleId);
      months.add(grant.monthNo);
    }
  });
export type SubscriptionDailySnapshot = z.infer<typeof SubscriptionDailySnapshotSchema>;
