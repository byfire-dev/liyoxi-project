import { SubscriptionDailySnapshotSchema } from "@liyoxi/contract";
import type { SubscriptionDailySnapshot } from "@liyoxi/contract";
import type { BillingEntityDaily } from "@liyoxi/db";
import { addDays, calendarDate, endOfDay, parseLocalDate } from "@liyoxi/shared/time";
import type { LocalDate } from "@liyoxi/shared/time";
import { z } from "zod";
import type { Tx } from "../../kernel/index.js";
import type { Ledger } from "../ledger/index.js";
import { fromDateColumn, toDateColumn } from "../ledger/context.js";
import { rebuildEntityValuation } from "./valuation.js";

const payload = z.object({ dailySnapshot: z.unknown().optional() });
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

/** 全部历史校验与覆盖在调用方同一TX；缺旧快照明确失败，不拍可变当前余额。 */
export function createBillingDailyProjection(deps: { ledger: Pick<Ledger, "lockAccount"> }) {
  return {
    async snapshot(tx: Tx, entityId: string, through: LocalDate): Promise<void> {
      parseLocalDate(through);
      const clock = await deps.ledger.lockAccount(tx, entityId);
      if (through >= clock.today) throw new Error("BILLING_DAILY_DAY_NOT_CLOSED");
      const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId } });
      const first = calendarDate(entity.createdAt);
      if (through < first) return;
      const terms = await tx.subscriptionTerm.findMany({ where: { entityId } });
      const termIds = new Set(terms.map((term) => term.id));
      const events = await tx.subscriptionEvent.findMany({
        where: { entityId, bizDate: { lte: toDateColumn(through) } },
        orderBy: [{ bizDate: "asc" }, { seq: "asc" }],
      });
      const history = events.map((event) => {
        if (event.payload === null) throw new BillingDailyHistoryMissingError();
        const parsed = payload.safeParse(event.payload);
        if (!parsed.success) throw new Error("BILLING_DAILY_HISTORY_PAYLOAD_INVALID");
        if (parsed.data.dailySnapshot === undefined) throw new BillingDailyHistoryMissingError();
        const snapshot = SubscriptionDailySnapshotSchema.parse(parsed.data.dailySnapshot);
        if (!termIds.has(event.subscriptionTermId) || snapshot.termId !== event.subscriptionTermId)
          throw new Error("BILLING_DAILY_HISTORY_SCOPE_INVALID");
        return { event, snapshot };
      });
      const known = new Set(history.map(({ snapshot }) => snapshot.termId));
      if (terms.some((term) => term.createdAt < endOfDay(through) && !known.has(term.id)))
        throw new BillingDailyHistoryMissingError();
      const lots = await tx.pointLot.findMany({ where: { entityId } });
      const schedules = await tx.grantSchedule.findMany({ where: { entityId } });
      const bySchedule = new Map(schedules.map((schedule) => [schedule.id, schedule]));
      const valuations = await rebuildEntityValuation(tx, deps, entityId);
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
      const entries = await tx.pointLedgerEntry.findMany({
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
          recomputedAt: clock.now,
          createdAt: clock.now,
        });
      }
      // 覆盖范围内派生行；任何失败由调用方事务整体回滚，原历史保持只增。
      await tx.billingEntityDaily.deleteMany({
        where: { entityId, bizDate: { lte: toDateColumn(through) } },
      });
      if (rows.length) await tx.billingEntityDaily.createMany({ data: rows });
    },
  };
}
