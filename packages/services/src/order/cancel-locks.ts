import { readAdCancelFacts } from "../ad/index.js";
import { managedStore } from "../authz/index.js";
import type { DataScope } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { CLOSED_CANCEL_ITEMS } from "./cancel-quote.js";

const sorted = (ids: readonly string[]) => [...new Set(ids)].sort();
type LockedCancelGraph = { readonly ids: readonly string[]; readonly signature: string };
const lockedGraphs = new WeakMap<Tx, Map<string, LockedCancelGraph>>();
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
export async function prelockAdCancelTargets(
  tx: Tx,
  graph: Awaited<ReturnType<typeof readAdCancelTargetGraph>>,
  actorStaffIds: readonly string[] = [],
) {
  await lockRows(tx, "staff", sorted([...graph.staffIds, ...actorStaffIds]), "share");
  await lockRows(tx, "approval_request", graph.approvalIds);
  await lockRows(tx, "cancel_request", graph.requestIds);
  await lockRows(tx, "cancel_request_line", graph.lineIds);
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
