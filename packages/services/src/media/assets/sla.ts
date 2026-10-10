import { EVENT_PAYLOAD_SCHEMAS, z } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { record } from "../../audit/index.js";
import { lockRows, createIdentityContext } from "../../kernel/index.js";
import type { Tx, DeliveredEvent, FiredTimer, TimerOutcome } from "../../kernel/index.js";
import { currentCalendarVersion, lockCalendarImport, workHoursAt } from "../../sla/index.js";
import type { AssetDeps } from "./context.js";
import { assetTimerKey } from "./types.js";
const snapshotSchema = z.strictObject({
  policy: z.string(),
  amount: z.number().nonnegative(),
  unit: z.enum(["work_minutes", "work_days", "natural_hours", "natural_days", "same_day_cutoff"]),
  calendarVersion: z.int().nonnegative(),
  computedAt: z.iso.datetime(),
});
export async function onAssetCalendarImported(tx: Tx, deps: AssetDeps, event: DeliveredEvent) {
  const payload = EVENT_PAYLOAD_SCHEMAS["calendar.imported"].parse(event.payload);
  await lockCalendarImport(tx);
  if (payload.calendarVersion !== (await currentCalendarVersion(tx))) return;
  const rows = await tx.storeAsset.findMany({
    where: { deletedAt: null, reviewState: "unreviewed", dueAt: { not: null } },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "store_asset",
    rows.map((row) => row.id),
  );
  for (const before of rows) {
    const row = await tx.storeAsset.findUniqueOrThrow({ where: { id: before.id } });
    if (row.deletedAt || row.reviewState !== "unreviewed" || !row.dueAt) continue;
    const snapshot = snapshotSchema.parse(row.slaSnapshot);
    if (
      snapshot.calendarVersion >= payload.calendarVersion ||
      !["work_days", "work_minutes", "same_day_cutoff"].includes(snapshot.unit)
    )
      continue;
    const changed = payload.changedDays.some(
      (day) => day >= calendarDate(row.createdAt) && day <= calendarDate(row.dueAt!),
    );
    if (!changed) continue;
    const next = await deps.assets.sla.dueAt(tx, {
      ...snapshot,
      from: row.createdAt,
      workHours: await workHoursAt(tx, row.createdAt),
    });
    await deps.assets.timers.cancel(tx, {
      subject: { type: "store_asset", id: row.id },
      kinds: ["sla.breach"],
    });
    await tx.storeAsset.update({
      where: { id: row.id },
      data: {
        dueAt: next.dueAt,
        slaSnapshot: { ...next.snapshot, computedAt: snapshot.computedAt },
        updatedAt: deps.clock.now(),
      },
    });
    await record(
      tx,
      createIdentityContext({ actor: { type: "system", job: "media.calendar_imported" } }).actor,
      { requestId: null, ip: null, userAgent: null, authMethod: null, sessionId: null },
      {
        stream: "activity",
        category: "profile_edit",
        action: "media.asset.calendar_recomputed",
        target: { type: "store_asset", id: row.id },
        entityId: row.entityId,
        storeId: row.storeId,
        summary: "素材复核时限随日历重算",
        before: { dueAt: row.dueAt.toISOString(), calendarVersion: snapshot.calendarVersion },
        after: { dueAt: next.dueAt.toISOString(), calendarVersion: next.snapshot.calendarVersion },
        fields: ["dueAt", "slaSnapshot"],
      },
    );
    await deps.assets.timers.arm(tx, {
      kind: "sla.breach",
      key: assetTimerKey(row.id),
      subject: { type: "store_asset", id: row.id },
      fireAt: next.dueAt,
      entityId: row.entityId,
      storeId: row.storeId,
      payload: { dueAt: next.dueAt.toISOString() },
    });
  }
}
export async function onAssetSlaBreach(
  tx: Tx,
  deps: AssetDeps,
  timer: FiredTimer,
): Promise<TimerOutcome> {
  if (timer.subjectType !== "store_asset" || !timer.subjectId) return "skipped";
  await lockRows(tx, "store_asset", [timer.subjectId]);
  const row = await tx.storeAsset.findUnique({ where: { id: timer.subjectId } }),
    persisted = await tx.timer.findUnique({ where: { id: timer.id } });
  if (
    !row ||
    row.deletedAt ||
    row.reviewState !== "unreviewed" ||
    !row.dueAt ||
    !persisted ||
    persisted.status !== "dispatched" ||
    persisted.dedupeKey !== assetTimerKey(row.id) ||
    persisted.fireAt.getTime() !== row.dueAt.getTime() ||
    row.dueAt > deps.clock.now() ||
    timer.payload?.dueAt !== row.dueAt.toISOString()
  )
    return "skipped";
  await deps.events.emit(
    tx,
    createIdentityContext({ actor: { type: "system", job: "media.sla_breach" } }),
    {
      type: "asset.sla_breached",
      aggregate: { type: "store_asset", id: row.id },
      entityId: row.entityId,
      storeId: row.storeId,
      payload: { v: 1, storeAssetId: row.id, storeId: row.storeId, dueAt: row.dueAt.toISOString() },
      dedupeKey: `tmr:${persisted.dedupeKey}:${row.dueAt.toISOString()}`,
    },
  );
  return "fired";
}
