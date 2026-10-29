import { readQualificationCancelAds } from "../ad/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { readOrderQualificationRound } from "../profile/index.js";
import {
  cancelIds,
  prelockCancelSubmission,
  readCancelSubmissionGraph,
  reserveCancelSubmission,
} from "./cancel-request-locks.js";

/** Read all low-rank cancellation owners before a subscriber can take store130. */
export async function readQualificationGraph(tx: Tx, input: { entityId: string; storeId: string }) {
  const scope = { entityId: input.entityId, storeId: input.storeId };
  const round = await readOrderQualificationRound(tx, scope);
  const requests = await tx.cancelRequest.findMany({
    where: { ...scope, closedAt: null },
    orderBy: { id: "asc" },
    select: {
      id: true,
      kind: true,
      approvalRequestId: true,
      approvalRequest: { select: { requesterStaffId: true, decidedByStaffId: true } },
      cancelRequestLines: {
        select: { id: true, targetType: true, targetId: true },
        orderBy: { id: "asc" },
      },
    },
  });
  const orders = await tx.dramaOrder.findMany({
    where: { ...scope, status: { notIn: ["ended", "cancelled", "refunded"] } },
    orderBy: { id: "asc" },
    select: { id: true, status: true, openCancelRequestId: true },
  });
  const ads = await readQualificationCancelAds(tx, scope);
  const graph = await readCancelSubmissionGraph(tx, {
    ...scope,
    orderIds: orders.map((o) => o.id),
    adIds: cancelIds([
      ...ads.map((ad) => ad.id),
      ...requests.flatMap((r) =>
        r.cancelRequestLines.filter((l) => l.targetType === "ad").map((l) => l.targetId),
      ),
    ]),
  });
  return {
    ...scope,
    round,
    requests,
    graph,
    orderIds: orders
      .filter((o) => o.status === "pending_start" && o.openCancelRequestId === null)
      .map((o) => o.id),
    adIds: ads.map((ad) => ad.id),
    staffIds: cancelIds(
      [
        ...graph.delivery.staffIds,
        ...requests.flatMap((r) => [
          r.approvalRequest.requesterStaffId,
          r.approvalRequest.decidedByStaffId,
        ]),
        round?.decidedByStaffId,
      ].filter((id): id is string => !!id),
    ),
    approvalIds: cancelIds([
      ...graph.delivery.approvalRequestIds,
      ...requests.map((r) => r.approvalRequestId),
      ...(round ? [round.approvalRequestId] : []),
    ]),
    requestIds: requests.map((r) => r.id),
    lineIds: cancelIds(requests.flatMap((r) => r.cancelRequestLines.map((l) => l.id))),
  };
}
export type QualificationGraph = Awaited<ReturnType<typeof readQualificationGraph>>;
const submissions = new WeakMap<Tx, QualificationGraph>();
export const rememberQualificationGraph = (tx: Tx, graph: QualificationGraph) =>
  submissions.set(tx, graph);
export function qualificationSubmissionGraph(tx: Tx) {
  const graph = submissions.get(tx);
  if (!graph) throw new AppError("INTERNAL", { message: "整店取消缺少资格预锁图" });
  return graph;
}
export async function lockQualificationGraph(
  tx: Tx,
  plan: QualificationGraph,
  fresh?: { approvalId: string; requestId: string; lineIds: readonly string[] },
) {
  await lockRows(tx, "staff", plan.staffIds, "share");
  if (fresh)
    await reserveCancelSubmission(tx, {
      ...fresh,
      approvalIds: plan.approvalIds,
      requestIds: plan.requestIds,
      lineIds: cancelIds([...fresh.lineIds, ...plan.lineIds]),
    });
  else {
    await lockRows(tx, "approval_request", plan.approvalIds);
    await lockRows(tx, "cancel_request", plan.requestIds);
    await lockRows(tx, "cancel_request_line", plan.lineIds);
  }
  // A delayed decision has no effect after every pending order has been started or
  // covered. Return without discovering/locking the new descendants created meanwhile.
  const isNoop = fresh
    ? undefined
    : async () =>
        (await tx.dramaOrder.count({
          where: {
            entityId: plan.entityId,
            storeId: plan.storeId,
            status: "pending_start",
            openCancelRequestId: null,
          },
        })) === 0;
  if (!(await prelockCancelSubmission(tx, plan.graph, undefined, isNoop))) return false;
  if (JSON.stringify(plan) !== JSON.stringify(await readQualificationGraph(tx, plan))) {
    if (isNoop && (await isNoop())) return false;
    throw new AppError("PRECONDITION_CHANGED", {
      message: "资质轮次或取消目标图已变化，请重试整个事务",
    });
  }
  return true;
}
