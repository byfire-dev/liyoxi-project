import { AppError, LockSetChanged } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { lockCalendarImport } from "../sla/index.js";
import type { AdOrderReferenceReader } from "./ad-order-reference.types.js";
import type { DeliveryCoreDeps } from "./context.js";
import { prepareReevaluation, readReevaluationTargets } from "./reevaluate-locks.js";
import { reevaluate } from "./reevaluate.js";

export type { AdOrderReferenceReader } from "./ad-order-reference.types.js";

type Scope = { entityId: string; storeId: string };
export async function readAdTicketDetails(tx: Tx, itemIds: readonly string[]) {
  const rows = await tx.deliveryTicket.findMany({
    where: { orderItemId: { in: [...itemIds] } },
    select: {
      id: true,
      ticketNo: true,
      orderItemId: true,
      step: true,
      pauseCount: true,
      deliveryManagerId: true,
    },
    orderBy: { orderItemId: "asc" },
  });
  return rows.map((row) => ({
    deliveryTicketId: row.id,
    ticketNo: row.ticketNo,
    itemId: row.orderItemId,
    step: row.step,
    isPaused: row.pauseCount > 0,
    managerId: row.deliveryManagerId,
  }));
}
const readers = new WeakMap<object, AdOrderReferenceReader>();
type Input = Scope & { adId: string; mode: "confirm" | "reopen" };
export async function readAdDeliveryImpact(
  tx: Tx,
  input: Input,
  readReferences: AdOrderReferenceReader,
) {
  const references = (await readReferences(tx, { ...input, adIds: [input.adId] })).filter(
    (row) => row.active && row.boundVersionNo === null,
  );
  const tickets = await tx.deliveryTicket.findMany({
    where: {
      entityId: input.entityId,
      storeId: input.storeId,
      orderItemId: { in: references.map((row) => row.orderItemId) },
      step: { in: input.mode === "confirm" ? ["ad_prep"] : ["sample_making", "sample_confirm"] },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const ticketIds = tickets.map((row) => row.id);
  const targets = await readReevaluationTargets(tx, ticketIds);
  const impact = {
    input,
    references,
    ticketIds,
    targets: Object.fromEntries(
      Object.entries(targets)
        .filter(([key]) => key.endsWith("Ids"))
        .map(([key, ids]) => [key, [...new Set(ids as readonly string[])].sort()]),
    ),
  };
  readers.set(impact, readReferences);
  return impact;
}
export type AdDeliveryImpact = Awaited<ReturnType<typeof readAdDeliveryImpact>>;
const locked = new WeakMap<Tx, Set<AdDeliveryImpact>>();
const signature = (impact: AdDeliveryImpact) =>
  JSON.stringify({
    references: impact.references,
    ticketIds: impact.ticketIds,
    targets: Object.fromEntries(
      Object.entries(impact.targets)
        .filter(([key]) => key.endsWith("Ids"))
        .map(([key, ids]) => [key, [...new Set(ids as readonly string[])].sort()]),
    ),
  });

/** Fixed confirm/reopen protocol; the first acquisition of every affected ad is UPDATE. */
export async function lockAdDeliveryImpact(
  tx: Tx,
  impact: AdDeliveryImpact,
  extras: {
    staffIds?: readonly string[];
    memberIds?: readonly string[];
    fileIds?: readonly string[];
  } = {},
) {
  await lockCalendarImport(tx);
  try {
    await prepareReevaluation(tx, impact.ticketIds, {
      ...extras,
      entityIds: [impact.input.entityId],
      storeIds: [impact.input.storeId],
      adIds: [impact.input.adId],
      adLock: "update",
    });
  } catch (error) {
    if (
      error instanceof AppError &&
      error.error === "PRECONDITION_CHANGED" &&
      ["同事务求值不能在已锁完整图后追加低序目标", "求值锁图变化，请重试整个事务"].includes(
        error.message,
      )
    )
      throw new LockSetChanged(error.message);
    throw error;
  }
  const reader = readers.get(impact);
  if (!reader) throw new AppError("INTERNAL", { message: "广告影响图不是本实例真实读取的目标" });
  const current = await readAdDeliveryImpact(tx, impact.input, reader);
  if (signature(impact) !== signature(current))
    throw new LockSetChanged("广告影响工单锁图已变化，请重试整个事务");
  const entries = locked.get(tx) ?? new Set<AdDeliveryImpact>();
  entries.add(impact);
  locked.set(tx, entries);
}

export async function applyAdDeliveryImpact(
  tx: Tx,
  deps: DeliveryCoreDeps,
  ctx: IdentityContext,
  impact: AdDeliveryImpact,
) {
  if (!locked.get(tx)?.has(impact))
    throw new AppError("INTERNAL", { message: "广告确认或重开尚未预锁完整工单影响图" });
  const supersededSampleIds: string[] = [],
    movedTicketIds: string[] = [];
  for (const id of impact.ticketIds) {
    const ticket = await tx.deliveryTicket.findUniqueOrThrow({ where: { id } });
    if (ticket.pauseCount) continue;
    const before = await tx.sample.findMany({
      where: { deliveryTicketId: id, status: { in: ["uploaded", "qc_passed", "pushed"] } },
      select: { id: true },
    });
    if ((await reevaluate(tx, deps, ctx, id)).moved) movedTicketIds.push(id);
    const after = await tx.sample.findMany({
      where: { id: { in: before.map((s) => s.id) }, status: "superseded" },
      select: { id: true },
    });
    supersededSampleIds.push(...after.map((s) => s.id));
  }
  return { supersededSampleIds, movedTicketIds };
}
