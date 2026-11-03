import { addDays, calendarDate, dayRange } from "@liyoxi/shared/time";
import { invalidateZipBundles, readCancelZipTargets } from "../media/index.js";
import { AppError } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { createTimers, timerKey } from "../timers/index.js";
import {
  ensureTakedownTasks,
  extendDeliveryPublishUsage,
  readDeliveryPublishTargets,
} from "../publish/index.js";
import type { DeliveryCoreDeps } from "./context.js";
import { dateOf, ticketOf } from "./repo.js";
import { manifestOf } from "./download/repo.js";

/** Caller owns the item/ticket and the complete publication graph before changing dates. */
export async function scheduleDeliveryUsage(
  tx: Tx,
  deps: DeliveryCoreDeps,
  ctx: IdentityContext,
  ticketId: string,
) {
  const t = await ticketOf(tx, ticketId),
    timers = createTimers({ assembly: deps.assembly });
  const subject = { type: "order_item", id: t.orderItemId },
    end = dateOf(t.orderItem.usageEndDate)!;
  for (const kind of ["usage.end", "takedown.create"] as const)
    await timers.cancel(tx, {
      subject,
      kinds: [kind],
      keyPrefix: `${kind}:order_item:${t.orderItemId}:`,
    });
  if (
    ["takedown", "archived", "terminated"].includes(t.step) ||
    !(await tx.deliveryRelease.count({ where: { orderItemId: t.orderItemId } }))
  )
    return;
  await timers.arm(tx, {
    kind: "usage.end",
    subject,
    key: timerKey("usage.end", subject, end),
    fireAt: dayRange(addDays(end, 1)).start,
    entityId: t.entityId,
    storeId: t.storeId,
    payload: { usageEndDate: end },
  });
  const fireAt = dayRange(addDays(end, -30)).start;
  if (fireAt > deps.clock.now())
    await timers.arm(tx, {
      kind: "takedown.create",
      subject,
      key: timerKey("takedown.create", subject, end),
      fireAt,
      entityId: t.entityId,
      storeId: t.storeId,
      payload: { usageEndDate: end },
    });
  else {
    await ensureTakedownTasks(
      tx,
      deps,
      ctx,
      await readDeliveryPublishTargets(tx, [t.orderItemId]),
      { deliveryTicketId: t.id, now: deps.clock.now() },
    );
  }
}

/** Date already changed under the complete lock graph; no new grant or historical evidence rewrite. */
export async function extendDeliveryUsage(
  tx: Tx,
  deps: DeliveryCoreDeps,
  ctx: IdentityContext,
  ticketId: string,
) {
  const t = await ticketOf(tx, ticketId);
  await extendDeliveryPublishUsage(
    tx,
    deps,
    ctx,
    await readDeliveryPublishTargets(tx, [t.orderItemId]),
    { deliveryTicketId: t.id, now: deps.clock.now() },
  );
  const last = await tx.deliveryRelease.findFirst({
    where: { orderItemId: t.orderItemId },
    orderBy: { releaseNo: "desc" },
  });
  if (
    last?.state === "closed" &&
    last.closeReason === "usage_ended" &&
    calendarDate(deps.clock.now()) <= dateOf(t.orderItem.usageEndDate)!
  ) {
    const ids = manifestOf(last.manifestSnapshot).map((entry) => entry.fileId);
    if (
      ids.length &&
      (await tx.fileObject.count({
        where: { id: { in: ids }, status: "stored", moderationState: { not: "block" } },
      })) === new Set(ids).size
    ) {
      if (!deps.media)
        throw new AppError("INTERNAL", { message: "重开成片包缺少真实媒体引用writer" });
      for (const fileId of [...new Set(ids)].sort())
        await deps.media.link(tx, {
          fileId,
          entityId: t.entityId,
          storeId: t.storeId,
          refType: "delivery_release",
          refId: last.id,
          role: "ep",
        });
      await tx.deliveryRelease.update({
        where: { id: last.id },
        data: {
          state: "pushed",
          closedAt: null,
          closeReason: null,
          updatedAt: deps.clock.now(),
        },
      });
    }
  }
  await scheduleDeliveryUsage(tx, deps, ctx, ticketId);
}

/** Called only after the checked takedown→archived transition, with its complete graph prelocked. */
export async function closeArchivedDeliveryUsage(tx: Tx, deps: DeliveryCoreDeps, ticketId: string) {
  const t = await ticketOf(tx, ticketId);
  if (t.step !== "archived") throw new AppError("STATE_NOT_ALLOWED");
  const releases = await tx.deliveryRelease.findMany({
    where: { orderItemId: t.orderItemId, state: "pushed" },
    select: { id: true },
  });
  const targets = await readCancelZipTargets(
    tx,
    releases.map((r) => r.id),
  );
  await tx.deliveryRelease.updateMany({
    where: { id: { in: releases.map((r) => r.id) } },
    data: {
      state: "closed",
      closeReason: "usage_ended",
      closedAt: deps.clock.now(),
      updatedAt: deps.clock.now(),
    },
  });
  await tx.downloadGrant.updateMany({
    where: { orderItemId: t.orderItemId, state: "active" },
    data: { state: "revoked", endedAt: deps.clock.now(), updatedAt: deps.clock.now() },
  });
  await invalidateZipBundles(tx, targets, deps.clock.now());
  // Early archival still retains the manifest through the original usage end + 90 days.
  // ZIP invalidation/releasedAt use actual now; release preserves any longer existing deadline.
  const keepUntil = dayRange(addDays(dateOf(t.orderItem.usageEndDate)!, 91)).start;
  for (const ref of targets.refs.filter(
    (r) => r.refType === "delivery_release" && r.role === "ep",
  )) {
    if (!deps.media?.release)
      throw new AppError("INTERNAL", { message: "归档成片留存缺少真实媒体释放writer" });
    await deps.media.release(tx, {
      fileId: ref.fileId,
      refType: ref.refType,
      refId: ref.refId,
      role: ref.role,
      entityId: t.entityId,
      storeId: t.storeId,
      keepUntil,
    });
  }
  await createTimers({ assembly: deps.assembly }).cancel(tx, {
    subject: { type: "order_item", id: t.orderItemId },
    kinds: ["usage.end", "takedown.create"],
  });
}
