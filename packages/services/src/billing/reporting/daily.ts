import { SubscriptionDailySnapshotSchema } from "@liyoxi/contract";
import type { SubscriptionDailySnapshot } from "@liyoxi/contract";
import type { BillingEntityDaily, PointEntryValuation } from "@liyoxi/db";
import { addDays, calendarDate, endOfDay, parseLocalDate } from "@liyoxi/shared/time";
import type { LocalDate } from "@liyoxi/shared/time";
import { z } from "zod";
import type { Tx } from "../../kernel/index.js";
import type { Ledger } from "../ledger/index.js";
import { fromDateColumn, toDateColumn } from "../ledger/context.js";
import { computeEntityValuation } from "./valuation.js";
import type { BillingValuationReader } from "./valuation.js";

const payload = z.object({
  dailySnapshot: z.unknown().optional(),
  affectedTerms: z.array(z.unknown()).optional(),
});
/** 仅此旧史缺失可由sweep保存点隔离；损坏快照/归属/估值错误仍抛出。 */
export class BillingDailyHistoryMissingError extends Error {
  constructor() {
    super("BILLING_DAILY_HISTORY_SNAPSHOT_MISSING");
    this.name = "BillingDailyHistoryMissingError";
  }
}
const terminal = new Set(["ended", "refunded", "cancelled"]);
const safe = (n: number): number => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("BILLING_DAILY_BALANCE_INVALID");
  return n;
};

export interface BillingDailyReader extends BillingValuationReader {
  readonly entity: Pick<Tx["entity"], "findUniqueOrThrow">;
  readonly subscriptionTerm: Pick<Tx["subscriptionTerm"], "findMany">;
  readonly subscriptionEvent: Pick<Tx["subscriptionEvent"], "findMany">;
  readonly grantSchedule: Pick<Tx["grantSchedule"], "findMany">;
}
export interface EntityDailyComputation {
  readonly days: BillingEntityDaily[];
  readonly valuations: PointEntryValuation[];
}

/** 仅读真实源表；不加锁/advance、不读取或修补已有投影。调用方提供一致读视图。 */
export async function computeEntityDaily(
  db: BillingDailyReader,
  entityId: string,
  through: LocalDate,
  at: Date,
): Promise<EntityDailyComputation> {
  parseLocalDate(through);
  if (!Number.isFinite(at.getTime())) throw new Error("BILLING_REPORTING_TIME_INVALID");
  if (through >= calendarDate(at)) throw new Error("BILLING_DAILY_DAY_NOT_CLOSED");
  const entity = await db.entity.findUniqueOrThrow({ where: { id: entityId } });
  const first = calendarDate(entity.createdAt);
  if (through < first) return { days: [], valuations: [] };
  const terms = await db.subscriptionTerm.findMany({ where: { entityId } });
  const termIds = new Set(terms.map((term) => term.id));
  const byTerm = new Map(terms.map((term) => [term.id, term]));
  const events = await db.subscriptionEvent.findMany({
    where: { entityId, bizDate: { lte: toDateColumn(through) } },
    orderBy: [{ bizDate: "asc" }, { seq: "asc" }],
  });
  const history = events.flatMap((event) => {
    if (event.payload === null) throw new BillingDailyHistoryMissingError();
    const parsed = payload.safeParse(event.payload);
    if (!parsed.success) throw new Error("BILLING_DAILY_HISTORY_PAYLOAD_INVALID");
    if (parsed.data.dailySnapshot === undefined) throw new BillingDailyHistoryMissingError();
    const snapshot = SubscriptionDailySnapshotSchema.parse(parsed.data.dailySnapshot);
    if (!termIds.has(event.subscriptionTermId) || snapshot.termId !== event.subscriptionTermId)
      throw new Error("BILLING_DAILY_HISTORY_SCOPE_INVALID");
    const affected = parsed.data.affectedTerms ?? [];
    if (parsed.data.affectedTerms !== undefined && !["refunded", "cancelled"].includes(event.type))
      throw new Error("BILLING_DAILY_HISTORY_SCOPE_INVALID");
    const ids = new Set([snapshot.termId]);
    const extra = affected.map((raw) => {
      const item = SubscriptionDailySnapshotSchema.parse(raw);
      if (
        item.status !== "scheduled" ||
        !termIds.has(item.termId) ||
        ids.has(item.termId) ||
        byTerm.get(item.termId)!.createdAt > event.occurredAt
      )
        throw new Error("BILLING_DAILY_HISTORY_SCOPE_INVALID");
      ids.add(item.termId);
      return { event, snapshot: item };
    });
    return [{ event, snapshot }, ...extra];
  });
  // 终态/升级快照不能证明此前的生效或预约事实；缺创建历史时仍须按旧史不足隔离。
  const known = new Set(
    history
      .filter(
        ({ event, snapshot }) =>
          (event.type === "activated" && snapshot.status === "active") ||
          (["renewal_scheduled", "downgrade_scheduled"].includes(event.type) &&
            snapshot.status === "scheduled"),
      )
      .map(({ snapshot }) => snapshot.termId),
  );
  if (terms.some((term) => term.createdAt < endOfDay(through) && !known.has(term.id)))
    throw new BillingDailyHistoryMissingError();
  const lots = await db.pointLot.findMany({ where: { entityId } });
  const schedules = await db.grantSchedule.findMany({ where: { entityId } });
  const bySchedule = new Map(schedules.map((schedule) => [schedule.id, schedule]));
  const valuations = await computeEntityValuation(db, entityId, at);
  const inflows = new Map(
    valuations.filter((row) => row.effect === "inflow").map((row) => [row.pointLotId, row]),
  );
  const grants = new Map<string, { termId: string; day: LocalDate }>();
  for (const lot of lots.filter((lot) => lot.sourceType === "grant_monthly")) {
    const schedule = bySchedule.get(lot.sourceId);
    const inflow = inflows.get(lot.id);
    if (
      !schedule ||
      schedule.subscriptionTermId !== lot.subscriptionTermId ||
      !inflow ||
      lot.kind !== "plan" ||
      lot.sourceNo !== 0 ||
      grants.has(lot.sourceId)
    )
      throw new Error("BILLING_DAILY_GRANT_SCOPE_INVALID");
    grants.set(lot.sourceId, {
      termId: schedule.subscriptionTermId,
      day: fromDateColumn(inflow.bizDate),
    });
  }
  for (const { snapshot } of history)
    for (const grant of snapshot.pendingGrants) {
      const schedule = bySchedule.get(grant.grantScheduleId);
      if (
        !schedule ||
        schedule.subscriptionTermId !== snapshot.termId ||
        schedule.monthNo !== grant.monthNo
      )
        throw new Error("BILLING_DAILY_GRANT_SCOPE_INVALID");
    }
  const byEntry = new Map(valuations.map((row) => [row.pointLedgerEntryId, row]));
  const entries = await db.pointLedgerEntry.findMany({
    where: { entityId, bizDate: { lte: toDateColumn(through) } },
    orderBy: [{ bizDate: "asc" }, { seq: "asc" }],
  });
  if (
    entries.some((entry) => fromDateColumn(entry.bizDate) < first) ||
    events.some((event) => fromDateColumn(event.bizDate) < first)
  )
    throw new Error("BILLING_DAILY_HISTORY_BEFORE_ENTITY");
  const latest = new Map<string, { snapshot: SubscriptionDailySnapshot; seq: bigint }>();
  const remaining = new Map<string, number>();
  const balances = { plan: 0, addon: 0, held: 0 };
  const rows: BillingEntityDaily[] = [];
  let eventIndex = 0,
    entryIndex = 0;
  for (let day = first; day <= through; day = addDays(day, 1)) {
    while (
      eventIndex < history.length &&
      fromDateColumn(history[eventIndex]!.event.bizDate) <= day
    ) {
      const item = history[eventIndex++]!;
      const prior = latest.get(item.snapshot.termId);
      if (!prior || prior.seq < item.event.seq)
        latest.set(item.snapshot.termId, { snapshot: item.snapshot, seq: item.event.seq });
    }
    while (entryIndex < entries.length && fromDateColumn(entries[entryIndex]!.bizDate) <= day) {
      const entry = entries[entryIndex++]!;
      const value = byEntry.get(entry.id);
      if (!value) throw new Error("BILLING_DAILY_VALUATION_MISSING");
      for (const [bucket, sign] of [
        [entry.fromBucket, -1],
        [entry.toBucket, 1],
      ] as const) {
        if (bucket === "available") {
          if (entry.lotKind === "plan") balances.plan += sign * entry.qty;
          else balances.addon += sign * entry.qty;
        } else if (bucket === "held") balances.held += sign * entry.qty;
      }
      remaining.set(entry.pointLotId, value.remainingValueFen);
    }
    const active: SubscriptionDailySnapshot[] = [];
    let deferredPlanFeeFen = 0,
      wasActivated = false;
    for (const { snapshot } of latest.values()) {
      const boundary = endOfDay(day).toISOString();
      wasActivated ||= snapshot.activatedAt !== null;
      if (snapshot.status === "active") {
        if (snapshot.startsAt >= boundary || snapshot.endsAt <= boundary)
          throw new Error("BILLING_DAILY_ADVANCE_INCOMPLETE");
        active.push(snapshot);
      } else if (snapshot.status === "scheduled" && snapshot.startsAt < boundary)
        throw new Error("BILLING_DAILY_ADVANCE_INCOMPLETE");
      if (terminal.has(snapshot.status)) continue;
      for (const grant of snapshot.pendingGrants) {
        const real = grants.get(grant.grantScheduleId);
        if (real && real.termId === snapshot.termId && real.day <= day) continue;
        if (grant.dueDate <= day) throw new Error("BILLING_DAILY_ADVANCE_INCOMPLETE");
        deferredPlanFeeFen += grant.valueFen;
      }
    }
    if (active.length > 1) throw new Error("BILLING_DAILY_OVERLAPPING_TERMS");
    const term = active[0];
    rows.push({
      entityId,
      bizDate: toDateColumn(day),
      subStatus: term ? "active" : wasActivated ? "expired" : "none",
      planId: term?.planId ?? null,
      planRevisionId: term?.planRevisionId ?? null,
      subscriptionTermId: term?.termId ?? null,
      termMonths: term?.months ?? null,
      mrrFen: term?.monthlyEquivFen ?? 0,
      planAvailablePoints: safe(balances.plan),
      addonAvailablePoints: safe(balances.addon),
      heldPoints: safe(balances.held),
      liabilityPoints: safe(balances.plan + balances.addon + balances.held),
      liabilityValueFen: safe([...remaining.values()].reduce((sum, value) => sum + value, 0)),
      deferredPlanFeeFen: safe(deferredPlanFeeFen),
      recomputedAt: at,
      createdAt: at,
    });
  }
  return { days: rows, valuations };
}

/** 写者原账户锁/账本时钟保持；只读计算全部成功后才覆盖本主体派生表。 */
export function createBillingDailyProjection(deps: { ledger: Pick<Ledger, "lockAccount"> }) {
  return {
    async snapshot(tx: Tx, entityId: string, through: LocalDate): Promise<void> {
      parseLocalDate(through);
      const clock = await deps.ledger.lockAccount(tx, entityId);
      const { days, valuations } = await computeEntityDaily(tx, entityId, through, clock.now);
      if (!days.length) return;
      await tx.pointEntryValuation.deleteMany({ where: { entityId, valuationPolicyVersionNo: 1 } });
      if (valuations.length) await tx.pointEntryValuation.createMany({ data: valuations });
      await tx.billingEntityDaily.deleteMany({
        where: { entityId, bizDate: { lte: toDateColumn(through) } },
      });
      await tx.billingEntityDaily.createMany({ data: days });
    },
  };
}
