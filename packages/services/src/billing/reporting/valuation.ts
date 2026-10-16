import type { PointEntryValuation } from "@liyoxi/db";
import { POINT_BUCKET } from "@liyoxi/contract/enums";
import { replayLotValuation } from "@liyoxi/shared";
import { z } from "zod";
import type { Tx } from "../../kernel/index.js";
import type { Ledger } from "../ledger/index.js";

const bucket = z.enum(POINT_BUCKET.values);
const policyRule = z.strictObject({
  costBasis: z.literal("as_recorded"),
  rounding: z.literal("floor"),
  remainder: z.literal("last_take"),
});
export interface BillingValuationReader {
  readonly valuationPolicy: Pick<Tx["valuationPolicy"], "findUnique">;
  readonly pointLot: Pick<Tx["pointLot"], "findMany">;
  readonly pointLedgerEntry: Pick<Tx["pointLedgerEntry"], "findMany">;
}
/** 仅读源表，按口径1重算；不推进/加锁，也不读写派生表。at由调用方注入。 */
export async function computeEntityValuation(
  db: BillingValuationReader,
  entityId: string,
  at: Date,
): Promise<PointEntryValuation[]> {
  if (!Number.isFinite(at.getTime())) throw new Error("BILLING_REPORTING_TIME_INVALID");
  const policy = await db.valuationPolicy.findUnique({ where: { versionNo: 1 } });
  if (!policy || !policyRule.safeParse(policy.rule).success)
    throw new Error("BILLING_VALUATION_POLICY_UNAVAILABLE");
  const lots = await db.pointLot.findMany({
    where: { entityId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const entries = await db.pointLedgerEntry.findMany({
    where: { entityId },
    orderBy: { seq: "asc" },
  });
  const byLot = new Map(lots.map((lot) => [lot.id, lot]));
  const byEntry = new Map(entries.map((entry) => [entry.id, entry]));
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const lot = byLot.get(entry.pointLotId);
    if (
      !lot ||
      entry.entityId !== lot.entityId ||
      entry.lotKind !== lot.kind ||
      entry.planId !== lot.planId
    )
      throw new Error("BILLING_VALUATION_ENTRY_SCOPE_INVALID");
    const group = groups.get(lot.id) ?? [];
    if (group.length && group[group.length - 1]!.bizDate > entry.bizDate)
      throw new Error("BILLING_VALUATION_BIZ_DATE_ORDER_INVALID");
    group.push(entry);
    groups.set(lot.id, group);
  }
  const visiting = new Set<string>(),
    completed = new Set<string>();
  const derived = new Map<string, PointEntryValuation>();
  function visit(id: string): void {
    if (completed.has(id)) return;
    if (visiting.has(id)) throw new Error("BILLING_VALUATION_DEPENDENCY_CYCLE");
    const lot = byLot.get(id),
      rows = groups.get(id);
    if (!lot || !rows?.length) throw new Error("BILLING_VALUATION_HISTORY_MISSING");
    if (rows[0]!.bizDate.getTime() !== lot.bizDate.getTime())
      throw new Error("BILLING_VALUATION_INFLOW_DATE_INVALID");
    visiting.add(id);
    let resolvedConversionValueFen: number | undefined;
    if (lot.sourceType === "conversion") {
      const origin = lot.originPointLotId ? byLot.get(lot.originPointLotId) : undefined;
      const transfer = lot.originPointLedgerEntryId
        ? byEntry.get(lot.originPointLedgerEntryId)
        : undefined;
      if (
        lot.costBasisFen !== null ||
        lot.kind !== "addon" ||
        !origin ||
        origin.kind !== "plan" ||
        !transfer ||
        transfer.pointLotId !== origin.id ||
        transfer.entityId !== entityId ||
        transfer.toBucket !== "converted_out" ||
        transfer.qty !== lot.originalQty ||
        transfer.ledgerOperationId !== lot.sourceId ||
        entries.filter(
          (entry) => entry.ledgerOperationId === lot.sourceId && entry.toBucket === "converted_out",
        )[lot.sourceNo - 1]?.id !== transfer.id ||
        transfer.seq >= rows[0]!.seq
      )
        throw new Error("BILLING_VALUATION_CONVERSION_SOURCE_INVALID");
      visit(origin.id);
      const value = derived.get(transfer.id);
      if (!value || !["transfer_out", "reverse_transfer"].includes(value.effect))
        throw new Error("BILLING_VALUATION_CONVERSION_EFFECT_INVALID");
      resolvedConversionValueFen = value.valueFen;
    } else if (
      lot.costBasisFen === null ||
      lot.originPointLotId !== null ||
      lot.originPointLedgerEntryId !== null
    )
      throw new Error("BILLING_VALUATION_COST_MISSING");
    const values = replayLotValuation(
      {
        originalQty: lot.originalQty,
        costBasisFen: lot.costBasisFen,
        ...(resolvedConversionValueFen === undefined ? {} : { resolvedConversionValueFen }),
      },
      rows.map((entry) => ({
        id: entry.id,
        seq: entry.seq,
        fromBucket: bucket.parse(entry.fromBucket),
        toBucket: bucket.parse(entry.toBucket),
        points: entry.qty,
        pointHoldId: entry.pointHoldId,
      })),
    );
    for (const [index, value] of values.entries())
      derived.set(value.entryId, {
        pointLedgerEntryId: value.entryId,
        valuationPolicyVersionNo: 1,
        pointLedgerEntrySeq: value.seq,
        pointLotId: id,
        entityId,
        bizDate: rows[index]!.bizDate,
        effect: value.effect,
        valueFen: value.valueFen,
        remainingValueFen: value.remainingValueFen,
        computedAt: at,
      });
    visiting.delete(id);
    completed.add(id);
  }
  for (const lot of lots) visit(lot.id);
  return [...derived.values()].sort((a, b) =>
    a.pointLedgerEntrySeq < b.pointLedgerEntrySeq ? -1 : 1,
  );
}

/** 原写者仍经正式账户锁/账本时钟，委托同一只读计算后整主体覆盖。 */
export async function rebuildEntityValuation(
  tx: Tx,
  deps: { ledger: Pick<Ledger, "lockAccount"> },
  entityId: string,
): Promise<PointEntryValuation[]> {
  const clock = await deps.ledger.lockAccount(tx, entityId);
  const values = await computeEntityValuation(tx, entityId, clock.now);
  // 全部归属/依赖/回放先通过，再整主体覆盖；不修改只增流水或批次。
  await tx.pointEntryValuation.deleteMany({ where: { entityId, valuationPolicyVersionNo: 1 } });
  if (values.length) await tx.pointEntryValuation.createMany({ data: values });
  return values;
}
