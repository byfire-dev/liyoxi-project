import { readAdCancelFacts } from "../ad/index.js";
import { managedStore } from "../authz/index.js";
import type { DataScope } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { readCancelReviewExecuteTargets } from "../delivery/index.js";
import { lockSystemFollowUpCloseTargets } from "../staff/index.js";
import { CLOSED_CANCEL_ITEMS } from "./cancel-quote.js";

const sorted = (ids: readonly string[]) => [...new Set(ids)].sort();
type LockedCancelGraph = { readonly ids: readonly string[]; readonly signature: string };
const lockedGraphs = new WeakMap<Tx, Map<string, LockedCancelGraph>>();
/** Unified execution graph. Read every owner before taking any business/account lock. */
export async function readCancelExecutionGraph(tx: Tx, requestId: string) {
  const request = await tx.cancelRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { cancelRequestLines: { orderBy: { id: "asc" } }, approvalRequest: true },
  });
  const selectedItemIds = sorted(
    request.cancelRequestLines.filter((l) => l.targetType === "order_item").map((l) => l.targetId),
  );
  const adIds = sorted(
    request.cancelRequestLines.filter((l) => l.targetType === "ad").map((l) => l.targetId),
  );
  const selected = await tx.orderItem.findMany({
    where: { id: { in: selectedItemIds } },
    select: { dramaOrderId: true },
  });
  const bindings = await adBindings(tx, adIds);
  const orderIds = sorted([...selected.map((i) => i.dramaOrderId), ...bindings.orderIds]);
  // Parent derivation reads every sibling, so the whole parent/item union is stable.
  const items = await tx.orderItem.findMany({
    where: { dramaOrderId: { in: orderIds } },
    select: { id: true, dramaId: true },
    orderBy: { id: "asc" },
  });
  const delivery = await readCancelReviewExecuteTargets(tx, selectedItemIds);
  return {
    requestId,
    staffIds: sorted(
      [
        ...delivery.staffIds,
        request.approvalRequest.requesterStaffId,
        request.approvalRequest.decidedByStaffId,
      ].filter((id): id is string => id !== null),
    ),
    approvalIds: sorted([request.approvalRequestId, ...delivery.approvalRequestIds]),
    lineIds: request.cancelRequestLines.map((l) => l.id),
    entityId: request.entityId,
    storeId: request.storeId,
    adIds,
    orderIds,
    itemIds: sorted(items.map((i) => i.id)),
    dramaIds: sorted([...items.map((i) => i.dramaId), ...delivery.dramaIds]),
    bindings: bindings.bindings,
    delivery,
  };
}
export type CancelExecutionGraph = Awaited<ReturnType<typeof readCancelExecutionGraph>>;
export async function prelockCancelExecutionGraph(
  tx: Tx,
  graph: CancelExecutionGraph,
  staffId?: string,
  freshAd?: { readonly requestId: string; readonly approvalId: string; readonly lineId: string },
) {
  if (
    freshAd &&
    (graph.requestId !== freshAd.requestId ||
      graph.approvalIds.length !== 1 ||
      graph.approvalIds[0] !== freshAd.approvalId ||
      graph.lineIds.length !== 1 ||
      graph.lineIds[0] !== freshAd.lineId ||
      graph.adIds.length !== 1 ||
      graph.orderIds.length !== 0 ||
      graph.itemIds.length !== 0)
  )
    throw new AppError("INTERNAL", { message: "本事务新广告取消的执行见证与目标图不一致" });
  await lockRows(tx, "staff", sorted([...graph.staffIds, ...(staffId ? [staffId] : [])]), "share");
  if (!freshAd) {
    await lockRows(tx, "approval_request", graph.approvalIds);
    await lockRows(tx, "cancel_request", [graph.requestId]);
    await lockRows(tx, "cancel_request_line", graph.lineIds);
  }
  // A concurrent executor may have finished while we waited on the low locks.
  // Its now closed children are irrelevant to a serialized result replay.
  if (
    (
      await tx.cancelRequest.findUniqueOrThrow({
        where: { id: graph.requestId },
        select: { status: true },
      })
    ).status === "done"
  )
    return;
  for (const [table, values] of [
    ["entity", [graph.entityId]],
    ["store", [graph.storeId]],
    ["drama", graph.dramaIds],
    ["ad", graph.adIds],
    ["drama_order", graph.orderIds],
    ["order_item", graph.itemIds],
    ["delivery_ticket", graph.delivery.deliveryTicketIds],
    ["channel_account", graph.delivery.channelAccountIds],
    ["delivery_release", graph.delivery.deliveryReleaseIds],
    ["launch_task", graph.delivery.launchTaskIds],
    ["patrol_task", graph.delivery.patrolTaskIds],
    ["takedown_task", graph.delivery.takedownTaskIds],
    ["zip_bundle", graph.delivery.zipBundleIds],
    ["file_object", graph.delivery.fileObjectIds],
  ] as const)
    await lockRows(tx, table, values);
  if (JSON.stringify(graph) !== JSON.stringify(await readCancelExecutionGraph(tx, graph.requestId)))
    throw new AppError("PRECONDITION_CHANGED", { message: "取消执行目标图已变化，请重试整个事务" });
  await lockSystemFollowUpCloseTargets(tx, graph.delivery.followUpIds);
  // Timer children have no global rank. Parents now exclude competing producers.
  await tx.$queryRaw`SELECT id FROM timer WHERE
    (subject_type = 'approval_request' AND subject_id = ANY(${graph.approvalIds}::uuid[])) OR
    (subject_type = 'ad' AND subject_id = ANY(${graph.adIds}::uuid[])) OR
    (subject_type = 'drama_order' AND subject_id = ANY(${graph.orderIds}::uuid[])) OR
    (subject_type = 'delivery_ticket' AND subject_id = ANY(${graph.delivery.deliveryTicketIds}::uuid[])) OR
    (subject_type = 'delivery_ticket_stage' AND subject_id IN
      (SELECT id FROM delivery_ticket_stage WHERE delivery_ticket_id = ANY(${graph.delivery.deliveryTicketIds}::uuid[]))) OR
    (subject_type = 'takedown_task' AND subject_id = ANY(${graph.delivery.takedownTaskIds}::uuid[]))
    ORDER BY id FOR UPDATE`;
}
export async function assertAdCancelTargetsLocked(tx: Tx, requestId: string) {
  const locked = lockedGraphs.get(tx)?.get(requestId);
  if (!locked) throw new AppError("INTERNAL", { message: "取消目标必须已完整预锁" });
  if (locked.signature !== JSON.stringify(await readAdCancelTargetGraph(tx, locked.ids)))
    throw new AppError("PRECONDITION_CHANGED", { message: "取消目标图已变化，请重试" });
}
export async function readAdCancelTargetGraph(tx: Tx, requestIds: readonly string[]) {
  const rows = await tx.cancelRequest.findMany({
    where: { id: { in: [...requestIds] }, kind: "ad_cancel" },
    include: { cancelRequestLines: { orderBy: { id: "asc" } } },
    orderBy: { id: "asc" },
  });
  if (
    rows.length !== sorted(requestIds).length ||
    rows.some(
      (r) =>
        !r.adId ||
        r.lineCount !== 1 ||
        r.cancelRequestLines.length !== 1 ||
        r.cancelRequestLines[0]!.targetType !== "ad" ||
        r.cancelRequestLines[0]!.targetId !== r.adId,
    )
  )
    throw new AppError("PRECONDITION_CHANGED");
  const adIds = sorted(rows.map((r) => r.adId!));
  return {
    staffIds: sorted(
      (
        await tx.approvalRequest.findMany({
          where: { id: { in: rows.map((r) => r.approvalRequestId) } },
          select: { requesterStaffId: true },
        })
      ).flatMap((r) => (r.requesterStaffId ? [r.requesterStaffId] : [])),
    ),
    approvalIds: sorted(rows.map((r) => r.approvalRequestId)),
    requestIds: sorted(rows.map((r) => r.id)),
    lineIds: sorted(rows.flatMap((r) => r.cancelRequestLines.map((l) => l.id))),
    entityIds: sorted(rows.map((r) => r.entityId)),
    storeIds: sorted(rows.map((r) => r.storeId)),
    adIds,
    ...(await adBindings(tx, adIds)),
  };
}
async function adBindings(tx: Tx, adIds: string[]) {
  const bound = await tx.orderItemPlacement.findMany({
    where: { adId: { in: adIds }, orderItem: { phase: { notIn: CLOSED_CANCEL_ITEMS } } },
    select: { adId: true, orderItemId: true, orderItem: { select: { dramaOrderId: true } } },
    orderBy: [{ adId: "asc" }, { orderItemId: "asc" }],
  });
  return {
    orderIds: sorted(bound.map((r) => r.orderItem.dramaOrderId)),
    itemIds: sorted(bound.map((r) => r.orderItemId)),
    bindings: bound.map((r) => [r.adId, r.orderItemId, r.orderItem.dramaOrderId]),
  };
}
export async function prelockAdCancelLowTargets(
  tx: Tx,
  graph: Awaited<ReturnType<typeof readAdCancelTargetGraph>>,
  actorStaffIds: readonly string[] = [],
) {
  await lockRows(tx, "staff", sorted([...graph.staffIds, ...actorStaffIds]), "share");
  await lockRows(tx, "approval_request", graph.approvalIds);
  await lockRows(tx, "cancel_request", graph.requestIds);
  await lockRows(tx, "cancel_request_line", graph.lineIds);
}
export async function prelockAdCancelTargets(
  tx: Tx,
  graph: Awaited<ReturnType<typeof readAdCancelTargetGraph>>,
  actorStaffIds: readonly string[] = [],
) {
  await prelockAdCancelLowTargets(tx, graph, actorStaffIds);
  await lockRows(tx, "entity", graph.entityIds);
  await lockRows(tx, "store", graph.storeIds);
  await lockRows(tx, "ad", graph.adIds);
  await lockRows(tx, "drama_order", graph.orderIds);
  await lockRows(tx, "order_item", graph.itemIds);
  if (JSON.stringify(graph) !== JSON.stringify(await readAdCancelTargetGraph(tx, graph.requestIds)))
    throw new AppError("PRECONDITION_CHANGED", { message: "取消目标图已变化，请重试" });
  // timer 不在 rank 表；先整体按 id 预锁，再进账户，回调只重入这些锁。
  await tx.$queryRaw`SELECT id FROM timer WHERE
    ((subject_type = 'approval_request' AND subject_id = ANY(${graph.approvalIds}::uuid[]) AND kind = 'sla.breach') OR
     (subject_type = 'ad' AND subject_id = ANY(${graph.adIds}::uuid[]) AND kind IN ('sla.breach','ad.returned_stale')))
    ORDER BY id FOR UPDATE`;
  const locked = lockedGraphs.get(tx) ?? new Map<string, LockedCancelGraph>();
  const witness = { ids: [...graph.requestIds], signature: JSON.stringify(graph) };
  for (const id of graph.requestIds) locked.set(id, witness);
  lockedGraphs.set(tx, locked);
}
export async function lockAdCancelSubmission(tx: Tx, adId: string, scope: DataScope) {
  const ad = await readAdCancelFacts(tx, adId, scope);
  if (!ad) throw new AppError("NOT_FOUND");
  const before = await adBindings(tx, [adId]);
  await lockRows(tx, "entity", [ad.entityId]);
  await lockRows(tx, "store", [ad.storeId]);
  await lockRows(tx, "ad", [ad.id]);
  await lockRows(tx, "drama_order", before.orderIds);
  await lockRows(tx, "order_item", before.itemIds);
  if (JSON.stringify(before) !== JSON.stringify(await adBindings(tx, [adId])))
    throw new AppError("PRECONDITION_CHANGED", { message: "广告绑定图已变化，请重试" });
  const store = await tx.store.findFirst({
    where: { id: ad.storeId, ...managedStore(scope) },
    include: { entity: true },
  });
  if (!store) throw new AppError("NOT_FOUND");
  if (store.lifecycle !== "active" || store.entity.lifecycle !== "active")
    throw new AppError("PRECONDITION_CHANGED");
  await tx.$queryRaw`SELECT id FROM timer WHERE subject_type = 'ad' AND subject_id = ${adId}::uuid
    AND kind IN ('sla.breach','ad.returned_stale') ORDER BY id FOR UPDATE`;
  return ad;
}
