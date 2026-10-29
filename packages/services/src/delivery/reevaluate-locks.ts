import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { lockSystemFollowUpCloseTargets } from "../staff/index.js";
import { readCancelReviewExecuteTargets } from "./cancel-review-execute.js";
const prepared = new WeakMap<
  Tx,
  {
    ticketIds: ReadonlySet<string>;
    staffIds: ReadonlySet<string>;
    approvalIds: ReadonlySet<string>;
    fileIds: ReadonlySet<string>;
    graph: Awaited<ReturnType<typeof readCancelReviewExecuteTargets>>;
  }
>();
const targetKeys = [
  "staffIds",
  "approvalRequestIds",
  "dramaIds",
  "adIds",
  "dramaOrderIds",
  "orderItemIds",
  "deliveryTicketIds",
  "channelAccountIds",
  "deliveryPlanIds",
  "deliveryReleaseIds",
  "launchTaskIds",
  "patrolTaskIds",
  "sampleIds",
  "takedownTaskIds",
  "followUpIds",
  "zipBundleIds",
  "fileObjectIds",
] as const;
function lockTargetSignature(targets: Awaited<ReturnType<typeof readReevaluationTargets>>) {
  return JSON.stringify(targetKeys.map((key) => [...new Set(targets[key])].sort()));
}

/** One complete graph, before any owner begins. Reentries can only reuse these locks. */
export async function prepareReevaluation(
  tx: Tx,
  ticketIds: readonly string[],
  extras: {
    staffIds?: readonly string[];
    approvalRequestId?: string;
    approvalRequestIds?: readonly string[];
    fileIds?: readonly string[];
  } = {},
) {
  const existing = prepared.get(tx);
  if (existing) {
    if (
      ticketIds.some((id) => !existing.ticketIds.has(id)) ||
      extras.staffIds?.some((id) => !existing.staffIds.has(id)) ||
      (extras.approvalRequestId && !existing.approvalIds.has(extras.approvalRequestId)) ||
      extras.approvalRequestIds?.some((id) => !existing.approvalIds.has(id)) ||
      extras.fileIds?.some((id) => !existing.fileIds.has(id))
    )
      throw new AppError("PRECONDITION_CHANGED", {
        message: "同事务求值不能在已锁完整图后追加低序目标",
      });
    // Parent rows exclude concurrent additions. A subsequent owner's submit may create
    // a new in-Tx approval; approval's own fresh-row witness handles it, never a late lock.
    return existing.graph;
  }
  const targets = await readReevaluationTargets(tx, ticketIds);
  const { tickets, graph, samples, posters } = targets;
  for (const [table, ids, mode] of [
    ["staff", [...graph.staffIds, ...(extras.staffIds ?? [])], "share"],
    [
      "approval_request",
      [
        ...graph.approvalRequestIds,
        ...(extras.approvalRequestIds ?? []),
        ...(extras.approvalRequestId ? [extras.approvalRequestId] : []),
      ],
      "update",
    ],
    ["drama", tickets.map((t) => t.dramaId), "share"],
    ["ad", tickets.flatMap((t) => t.orderItem.orderItemPlacements.map((p) => p.adId)), "share"],
    ["drama_order", tickets.map((t) => t.dramaOrderId), "update"],
    ["order_item", tickets.map((t) => t.orderItemId), "update"],
    ["delivery_ticket", tickets.map((t) => t.id), "update"],
    ["channel_account", graph.channelAccountIds, "update"],
    [
      "delivery_plan",
      tickets.flatMap((t) => (t.dramaOrder.deliveryPlan ? [t.dramaOrder.deliveryPlan.id] : [])),
      "update",
    ],
    ["delivery_release", graph.deliveryReleaseIds, "update"],
    ["launch_task", graph.launchTaskIds, "update"],
    ["patrol_task", graph.patrolTaskIds, "update"],
    ["sample", samples.map((s) => s.id), "update"],
    ["takedown_task", graph.takedownTaskIds, "update"],
  ] as const)
    await lockRows(tx, table, ids, mode === "share" ? "share" : "update");
  await lockSystemFollowUpCloseTargets(tx, graph.followUpIds);
  await lockRows(tx, "zip_bundle", graph.zipBundleIds);
  await lockRows(tx, "file_object", [
    ...graph.fileObjectIds,
    ...(extras.fileIds ?? []),
    ...posters,
  ]);
  const fresh = await readReevaluationTargets(tx, ticketIds);
  // A writer may have committed new business facts while we waited on its parent lock.
  // Only a changed lock target set requires a retry; evaluate the now serialized fresh facts.
  if (lockTargetSignature(fresh) !== lockTargetSignature(targets))
    throw new AppError("PRECONDITION_CHANGED", { message: "求值锁图变化，请重试整个事务" });
  prepared.set(tx, {
    ticketIds: new Set(ticketIds),
    staffIds: new Set([...graph.staffIds, ...(extras.staffIds ?? [])]),
    approvalIds: new Set([
      ...graph.approvalRequestIds,
      ...(extras.approvalRequestIds ?? []),
      ...(extras.approvalRequestId ? [extras.approvalRequestId] : []),
    ]),
    fileIds: new Set([...graph.fileObjectIds, ...(extras.fileIds ?? []), ...posters]),
    graph: fresh.graph,
  });
  return fresh.graph;
}

/** Read-only complete union for callers that coordinate other owners before invoking delivery. */
export async function readReevaluationTargets(tx: Tx, ticketIds: readonly string[]) {
  const tickets = await tx.deliveryTicket.findMany({
    where: { id: { in: [...ticketIds] } },
    include: {
      drama: { select: { posterFileId: true } },
      orderItem: { include: { orderItemPlacements: true } },
      dramaOrder: { include: { deliveryPlan: true } },
    },
    orderBy: { id: "asc" },
  });
  const graph = await readCancelReviewExecuteTargets(
    tx,
    tickets
      .filter((t) =>
        ["awaiting_launch", "launch_verify", "in_service", "takedown"].includes(t.step),
      )
      .map((t) => t.orderItemId),
  );
  const samples = await tx.sample.findMany({
    where: {
      deliveryTicketId: { in: tickets.map((t) => t.id) },
      status: { in: ["uploaded", "qc_passed", "pushed"] },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const posters = tickets.flatMap((t) => {
    const id =
      (t.orderItem.dramaSnapshot as { posterFileId?: string }).posterFileId ?? t.drama.posterFileId;
    return id ? [id] : [];
  });
  return {
    tickets,
    graph,
    samples,
    posters,
    staffIds: graph.staffIds,
    approvalRequestIds: graph.approvalRequestIds,
    dramaIds: tickets.map((t) => t.dramaId),
    adIds: tickets.flatMap((t) => t.orderItem.orderItemPlacements.map((p) => p.adId)),
    dramaOrderIds: tickets.map((t) => t.dramaOrderId),
    orderItemIds: tickets.map((t) => t.orderItemId),
    deliveryTicketIds: tickets.map((t) => t.id),
    channelAccountIds: graph.channelAccountIds,
    deliveryPlanIds: tickets.flatMap((t) =>
      t.dramaOrder.deliveryPlan ? [t.dramaOrder.deliveryPlan.id] : [],
    ),
    deliveryReleaseIds: graph.deliveryReleaseIds,
    launchTaskIds: graph.launchTaskIds,
    patrolTaskIds: graph.patrolTaskIds,
    sampleIds: samples.map((s) => s.id),
    takedownTaskIds: graph.takedownTaskIds,
    followUpIds: graph.followUpIds,
    zipBundleIds: graph.zipBundleIds,
    fileObjectIds: [...graph.fileObjectIds, ...posters],
  };
}
