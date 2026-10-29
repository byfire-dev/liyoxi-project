import { managedStore } from "../authz/index.js";
import type { DataScope } from "../authz/index.js";
import {
  getTicketBriefByOrderItem,
  readCancelReviewPauseTargets,
  readCancelReviewExecuteTargets,
} from "../delivery/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { lockSystemFollowUpCloseTargets } from "../staff/index.js";
import { readCancelExecutionGraph } from "./cancel-locks.js";

export const cancelIds = (ids: readonly string[]) => [...new Set(ids)].sort();

/** Parent/item union includes unselected siblings because parent derivation reads all of them. */
export async function readCancelSubmissionGraph(
  tx: Tx,
  input: {
    entityId: string;
    storeId: string;
    orderIds: readonly string[];
    adIds: readonly string[];
  },
) {
  const items = await tx.orderItem.findMany({
    where: { dramaOrderId: { in: [...input.orderIds] } },
    select: { id: true, dramaOrderId: true, dramaId: true },
    orderBy: { id: "asc" },
  });
  const tickets = [];
  for (const item of items) {
    const ticket = await getTicketBriefByOrderItem(tx, item.id);
    if (ticket) tickets.push([item.id, ticket.deliveryTicketId]);
  }
  return {
    entityId: input.entityId,
    storeId: input.storeId,
    orderIds: cancelIds(input.orderIds),
    adIds: cancelIds(input.adIds),
    items,
    ticketIds: cancelIds(tickets.map((t) => t[1]!)),
    tickets,
    delivery: await readCancelReviewExecuteTargets(
      tx,
      items.map((i) => i.id),
    ),
  };
}
export type CancelSubmissionGraph = Awaited<ReturnType<typeof readCancelSubmissionGraph>>;
export async function reserveCancelSubmission(
  tx: Tx,
  input: {
    approvalId: string;
    requestId: string;
    lineIds: readonly string[];
    approvalIds?: readonly string[];
    requestIds?: readonly string[];
  },
) {
  // These IDs belong to rows created later by this same transaction. Recording them now
  // permits owner callbacks to reenter their real parent locks after the account lock.
  await lockRows(
    tx,
    "approval_request",
    cancelIds([input.approvalId, ...(input.approvalIds ?? [])]),
  );
  await lockRows(tx, "cancel_request", cancelIds([input.requestId, ...(input.requestIds ?? [])]));
  await lockRows(tx, "cancel_request_line", input.lineIds);
}
export async function prelockCancelSubmission(
  tx: Tx,
  graph: CancelSubmissionGraph,
  atServiceRank?: () => Promise<void>,
  isNoop?: () => Promise<boolean>,
) {
  const d = graph.delivery;
  for (const [table, ids] of [
    ["entity", [graph.entityId]],
    ["store", [graph.storeId]],
    ["drama", cancelIds(graph.items.map((i) => i.dramaId))],
    ["ad", graph.adIds],
    ["drama_order", graph.orderIds],
    ["order_item", graph.items.map((i) => i.id)],
    ["delivery_ticket", graph.ticketIds],
    ["channel_account", d.channelAccountIds],
    ["delivery_release", d.deliveryReleaseIds],
    ["launch_task", d.launchTaskIds],
    ["patrol_task", d.patrolTaskIds],
    ["takedown_task", d.takedownTaskIds],
    ["zip_bundle", d.zipBundleIds],
    ["file_object", d.fileObjectIds],
  ] as const) {
    if (table === "takedown_task" && atServiceRank) await atServiceRank();
    await lockRows(tx, table, ids);
  }
  if (JSON.stringify(graph) !== JSON.stringify(await readCancelSubmissionGraph(tx, graph))) {
    if (isNoop && (await isNoop())) return false;
    throw new AppError("PRECONDITION_CHANGED", { message: "取消申请目标图已变化，请重试整个事务" });
  }
  await lockSystemFollowUpCloseTargets(tx, d.followUpIds);
  await tx.$queryRaw`SELECT id FROM timer WHERE
    (subject_type = 'drama_order' AND subject_id = ANY(${graph.orderIds}::uuid[])) OR
    (subject_type = 'ad' AND subject_id = ANY(${graph.adIds}::uuid[])) OR
    (subject_type = 'delivery_ticket_stage' AND subject_id IN
      (SELECT id FROM delivery_ticket_stage WHERE delivery_ticket_id = ANY(${graph.ticketIds}::uuid[])))
    ORDER BY id FOR UPDATE`;
  return true;
}
export async function scopedCancelOrder(tx: Tx, scope: DataScope, id: string) {
  const order = await tx.dramaOrder.findFirst({ where: { id, store: managedStore(scope) } });
  if (!order) throw new AppError("NOT_FOUND");
  return order;
}

export async function readCancelDecisionGraph(tx: Tx, id: string) {
  const execution = await readCancelExecutionGraph(tx, id);
  // Read by the request's actual approval rather than any nested publish approval.
  const request = await tx.cancelRequest.findUniqueOrThrow({ where: { id } });
  return {
    execution,
    pauses: await readCancelReviewPauseTargets(tx, [request.approvalRequestId]),
  };
}
export type CancelDecisionGraph = Awaited<ReturnType<typeof readCancelDecisionGraph>>;
const witnesses = new WeakMap<Tx, Map<string, CancelDecisionGraph>>();
export async function prelockCancelDecision(
  tx: Tx,
  graph: CancelDecisionGraph,
  actorIds: readonly string[],
) {
  const g = graph.execution,
    p = graph.pauses,
    d = g.delivery;
  for (const [table, ids, mode] of [
    ["staff", cancelIds([...g.staffIds, ...actorIds]), "share"],
    ["approval_request", g.approvalIds, "update"],
    ["cancel_request", [g.requestId], "update"],
    ["cancel_request_line", g.lineIds, "update"],
    ["entity", [g.entityId], "update"],
    ["store", [g.storeId], "update"],
    ["drama", cancelIds([...g.dramaIds, ...p.dramaIds]), "update"],
    ["ad", g.adIds, "update"],
    ["drama_order", cancelIds([...g.orderIds, ...p.dramaOrderIds]), "update"],
    ["order_item", cancelIds([...g.itemIds, ...p.orderItemIds]), "update"],
    ["delivery_ticket", cancelIds([...d.deliveryTicketIds, ...p.deliveryTicketIds]), "update"],
    ["channel_account", d.channelAccountIds, "update"],
    ["delivery_plan", p.deliveryPlanIds, "update"],
    ["delivery_release", d.deliveryReleaseIds, "update"],
    ["launch_task", d.launchTaskIds, "update"],
    ["patrol_task", d.patrolTaskIds, "update"],
    ["takedown_task", d.takedownTaskIds, "update"],
    ["zip_bundle", d.zipBundleIds, "update"],
    ["file_object", cancelIds([...d.fileObjectIds, ...p.coverFileIds]), "update"],
  ] as const)
    await lockRows(tx, table, ids, mode);
  await lockSystemFollowUpCloseTargets(tx, d.followUpIds);
  if (JSON.stringify(graph) !== JSON.stringify(await readCancelDecisionGraph(tx, g.requestId)))
    throw new AppError("PRECONDITION_CHANGED", { message: "取消决定目标图已变化，请重试整个事务" });
  await tx.$queryRaw`SELECT id FROM timer WHERE
    (subject_type = 'approval_request' AND subject_id = ANY(${g.approvalIds}::uuid[])) OR
    (subject_type = 'drama_order' AND subject_id = ANY(${g.orderIds}::uuid[])) OR
    (subject_type = 'ad' AND subject_id = ANY(${g.adIds}::uuid[])) OR
    (subject_type = 'delivery_ticket_stage' AND subject_id IN
      (SELECT id FROM delivery_ticket_stage WHERE delivery_ticket_id = ANY(${d.deliveryTicketIds}::uuid[])))
    ORDER BY id FOR UPDATE`;
  const entries = witnesses.get(tx) ?? new Map<string, CancelDecisionGraph>();
  entries.set(g.requestId, graph);
  witnesses.set(tx, entries);
}
export function cancelDecisionGraph(tx: Tx, id: string) {
  const graph = witnesses.get(tx)?.get(id);
  if (!graph) throw new AppError("INTERNAL", { message: "取消决定尚未预锁完整目标" });
  return graph;
}
