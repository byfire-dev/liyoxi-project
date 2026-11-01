import { AppError, createIdentityContext, lockRows } from "../kernel/index.js";
import type { Tx, FiredTimer } from "../kernel/index.js";
import type { AdStaffActor, AdWriteDeps } from "./context.js";
import { paramsAt } from "../config/index.js";
import { timerKey } from "../timers/index.js";
import { requireAdProductionAccess } from "./production-parent-facts.js";
import { moveAd, noCancel } from "./lifecycle.js";
export async function returnAdTx(
  tx: Tx,
  deps: AdWriteDeps,
  actor: AdStaffActor,
  id: string,
  reason: string,
) {
  if (!reason.trim() || [...reason].length > 200) throw new AppError("VALIDATION_FAILED");
  await lockRows(tx, "ad", [id]);
  await requireAdProductionAccess(tx, { identity: actor.ctx, staff: actor.staff }, id);
  const ad = await tx.ad.findUniqueOrThrow({ where: { id } });
  noCancel(ad);
  if (!["pending_assign", "producing"].includes(ad.status)) throw new AppError("STATE_NOT_ALLOWED");
  const now = deps.clock.now(),
    days = (await paramsAt(tx, ["ad.returned_stale_days"], now))["ad.returned_stale_days"];
  await deps.timers.cancel(tx, { subject: { type: "ad", id }, kinds: ["sla.breach"] });
  await moveAd(
    tx,
    deps,
    actor.ctx,
    ad,
    "ad.return",
    "09:803",
    {
      returned_from: ad.status,
      returned_at: now,
      return_reason: reason,
      due_at: null,
      sla_snapshot: null,
    },
    { type: "ad.returned", payload: { v: 1, adId: id, returnedFrom: ad.status } },
  );
  await deps.timers.arm(tx, {
    kind: "ad.returned_stale",
    subject: { type: "ad", id },
    key: timerKey("ad.returned_stale", { type: "ad", id }, String(ad.resubmitCount)),
    fireAt: new Date(now.getTime() + days * 86_400_000),
    entityId: ad.entityId,
    storeId: ad.storeId,
    payload: { returnedAt: now.toISOString(), resubmitCount: ad.resubmitCount },
  });
  return id;
}
export async function handleAdReturnedStale(
  tx: Tx,
  deps: Pick<AdWriteDeps, "clock"> & { events: Pick<AdWriteDeps["events"], "emit"> },
  timer: FiredTimer,
) {
  if (timer.kind !== "ad.returned_stale" || timer.subjectType !== "ad" || !timer.subjectId)
    return "skipped" as const;
  await lockRows(tx, "ad", [timer.subjectId]);
  const ad = await tx.ad.findUnique({ where: { id: timer.subjectId } }),
    actual = await tx.timer.findUnique({ where: { id: timer.id } });
  if (
    !ad ||
    !actual ||
    ad.status !== "returned" ||
    !ad.returnedAt ||
    ad.openCancelRequestId ||
    ad.returnedAt.toISOString() !== timer.payload?.returnedAt ||
    ad.resubmitCount !== timer.payload?.resubmitCount ||
    actual.subjectId !== ad.id ||
    actual.kind !== "ad.returned_stale" ||
    actual.fireAt > deps.clock.now()
  )
    return "skipped" as const;
  await deps.events.emit(
    tx,
    createIdentityContext({
      actor: { type: "system", job: "ad.returned_stale" },
      entityId: ad.entityId,
      storeId: ad.storeId,
    }),
    {
      type: "ad.returned_stale",
      aggregate: { type: "ad", id: ad.id },
      entityId: ad.entityId,
      storeId: ad.storeId,
      dedupeKey: `tmr:${actual.dedupeKey}`,
      payload: { v: 1, adId: ad.id, storeId: ad.storeId, returnedAt: ad.returnedAt.toISOString() },
    },
  );
  return "fired" as const;
}
