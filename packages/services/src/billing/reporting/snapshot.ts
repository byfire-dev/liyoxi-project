import { SubscriptionDailySnapshotSchema } from "@liyoxi/contract";
import type { SubscriptionDailySnapshot } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import type { Tx } from "../../kernel/index.js";
import { fromDateColumn } from "../ledger/context.js";

/** 调用方已持本主体账户锁，完成变更后同TX读；本函数只读，不造或修补旧历史。 */
export async function captureSubscriptionDailySnapshot(
  tx: Tx,
  entityId: string,
  termId: string,
): Promise<SubscriptionDailySnapshot> {
  const term = await tx.subscriptionTerm.findFirst({ where: { id: termId, entityId } });
  if (!term) throw new Error("BILLING_SNAPSHOT_TERM_NOT_FOUND");
  const grants = await tx.grantSchedule.findMany({
    where: { subscriptionTermId: termId, status: "pending" },
    orderBy: [{ monthNo: "asc" }, { id: "asc" }],
  });
  if (
    grants.some(
      (grant) =>
        grant.entityId !== entityId ||
        calendarDate(grant.dueAt) !== fromDateColumn(grant.dueDate) ||
        grant.dueAt < term.startsAt ||
        grant.dueAt >= term.endsAt,
    )
  )
    throw new Error("BILLING_SNAPSHOT_GRANT_SCOPE_INVALID");
  return SubscriptionDailySnapshotSchema.parse({
    v: 1,
    termId: term.id,
    status: term.status,
    planId: term.planId,
    planRevisionId: term.planRevisionId,
    months: term.months,
    monthlyEquivFen: term.monthlyEquivFen,
    startsAt: term.startsAt.toISOString(),
    endsAt: term.endsAt.toISOString(),
    activatedAt: term.activatedAt?.toISOString() ?? null,
    pendingGrants: grants.map((grant) => ({
      grantScheduleId: grant.id,
      monthNo: grant.monthNo,
      dueDate: fromDateColumn(grant.dueDate),
      valueFen: grant.valueFen,
    })),
  });
}
