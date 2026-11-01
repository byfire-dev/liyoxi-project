import { z } from "@liyoxi/contract";
import { createIdentityContext, lockRows } from "../kernel/index.js";
import type { FiredTimer, TimerOutcome, Tx } from "../kernel/index.js";
import { timerKey } from "../timers/index.js";
import { readAdTaskStore } from "../profile/index.js";
import type { AdWriteDeps } from "./context.js";

export type AdSlaDeps = Pick<AdWriteDeps, "clock"> & {
  events: Pick<AdWriteDeps["events"], "emit">;
};
const snapshotSchema = z.strictObject({
  policy: z.enum(["ad.first_version", "ad.revision"]),
  amount: z.number().nonnegative(),
  unit: z.enum(["work_minutes", "work_days", "natural_hours", "natural_days", "same_day_cutoff"]),
  calendarVersion: z.int().nonnegative(),
  computedAt: z.iso.datetime(),
});

/** Parent ad150 protects its current revision; only the current persisted timer may breach it. */
export async function handleAdSlaBreach(
  tx: Tx,
  deps: AdSlaDeps,
  timer: FiredTimer,
): Promise<TimerOutcome> {
  if (timer.kind !== "sla.breach" || timer.subjectType !== "ad" || !timer.subjectId)
    return "skipped";
  await lockRows(tx, "ad", [timer.subjectId]);
  const ad = await tx.ad.findUnique({ where: { id: timer.subjectId } });
  const persisted = await tx.timer.findUnique({ where: { id: timer.id } });
  const now = deps.clock.now();
  if (
    !ad ||
    !persisted ||
    ad.openCancelRequestId ||
    !ad.dueAt ||
    ad.dueAt > now ||
    !["pending_assign", "producing", "revising"].includes(ad.status) ||
    persisted.status !== "dispatched" ||
    persisted.kind !== timer.kind ||
    persisted.subjectType !== "ad" ||
    persisted.subjectId !== ad.id ||
    persisted.entityId !== ad.entityId ||
    persisted.storeId !== ad.storeId ||
    persisted.fireAt.getTime() !== ad.dueAt.getTime()
  )
    return "skipped";
  const snapshot = snapshotSchema.safeParse(ad.slaSnapshot);
  if (!snapshot.success) return "skipped";
  const revision =
    ad.status === "revising"
      ? await tx.adRevision.findUnique({
          where: { adId_revisionNo: { adId: ad.id, revisionNo: ad.revisionCount } },
        })
      : null;
  if (
    ad.status === "revising" &&
    (!revision ||
      revision.fulfilledByVersionNo !== null ||
      revision.breachedAt ||
      revision.dueAt.getTime() !== ad.dueAt.getTime())
  )
    return "skipped";
  if (
    !revision &&
    (ad.firstBreachedAt ||
      (await tx.adVersion.count({ where: { adId: ad.id, pushedAt: { not: null } } })))
  )
    return "skipped";
  const purpose = revision ? "revision" : "first",
    round = revision?.revisionNo ?? ad.resubmitCount;
  if (
    snapshot.data.policy !== (revision ? "ad.revision" : "ad.first_version") ||
    persisted.dedupeKey !==
      timerKey("sla.breach", { type: "ad", id: ad.id }, `${revision ? "rev" : "first"}:${round}`)
  )
    return "skipped";
  // Initial arming carries the SLA snapshot; calendar-import rearming carries purpose/round/deadline.
  // Both must match the actual row and the delivered payload, including same-key replacement.
  const payload = z.record(z.string(), z.unknown()).safeParse(persisted.payload);
  if (
    !payload.success ||
    !timer.payload ||
    Object.keys(payload.data).length !== Object.keys(timer.payload).length ||
    Object.entries(payload.data).some(([key, value]) => value !== timer.payload?.[key])
  )
    return "skipped";
  if ("policy" in payload.data) {
    if (Object.entries(snapshot.data).some(([key, value]) => payload.data[key] !== value))
      return "skipped";
  } else if (
    payload.data.purpose !== purpose ||
    payload.data.dueAt !== ad.dueAt.toISOString() ||
    (revision ? payload.data.revisionNo : payload.data.resubmitCount) !== round
  )
    return "skipped";
  const waitingQualification =
    !revision &&
    ad.status === "pending_assign" &&
    (await readAdTaskStore(tx, ad)).store.qualificationStatus === "pending";
  if (revision)
    await tx.adRevision.update({
      where: { id: revision.id },
      data: { breachedAt: now, updatedAt: now },
    });
  else if (!waitingQualification)
    await tx.ad.update({ where: { id: ad.id }, data: { firstBreachedAt: now, updatedAt: now } });
  await deps.events.emit(
    tx,
    createIdentityContext({
      actor: { type: "system", job: "ad.sla_breach" },
      entityId: ad.entityId,
      storeId: ad.storeId,
    }),
    {
      type: "ad.sla_breached",
      aggregate: { type: "ad", id: ad.id },
      entityId: ad.entityId,
      storeId: ad.storeId,
      dedupeKey: `tmr:${persisted.dedupeKey}`,
      payload: {
        v: 1,
        adId: ad.id,
        ...(revision
          ? { purpose: "revision" as const, revisionNo: revision.revisionNo }
          : { purpose: "first" as const }),
        dueAt: ad.dueAt.toISOString(),
      },
    },
  );
  return "fired";
}
