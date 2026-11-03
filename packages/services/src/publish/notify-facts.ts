import type { Tx } from "../kernel/index.js";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";

export async function launchRevokedForNotify(tx: Tx, id: string) {
  const task = await tx.launchTask.findUnique({
    where: { id },
    include: {
      deliveryTicket: { include: { publisher: true } },
      launchSubmissions: {
        orderBy: { roundNo: "desc" },
        take: 1,
        include: { approvalRequest: true },
      },
    },
  });
  const ticket = task?.deliveryTicket,
    current = task?.launchSubmissions[0];
  if (
    !task ||
    !ticket ||
    ticket.pauseCount ||
    !["launch_verify", "in_service"].includes(ticket.step) ||
    task.reviewStatus !== "verifying" ||
    !current ||
    current.roundNo !== task.currentRoundNo ||
    current.result !== "pending" ||
    !current.reopenOfLaunchSubmissionId ||
    current.approvalRequest.status !== "pending"
  )
    return null;
  const revoked = await tx.launchSubmission.findUnique({
    where: { id: current.reopenOfLaunchSubmissionId },
    include: { approvalRequest: true },
  });
  if (
    !revoked ||
    revoked.launchTaskId !== id ||
    revoked.result !== "revoked" ||
    revoked.approvalRequest.status !== "approved"
  )
    return null;
  const publisher = ticket.publisher;
  return {
    bizType: "launch_task",
    bizId: task.id,
    entityId: task.entityId,
    storeId: task.storeId,
    status: "verifying",
    version: task.currentRoundNo,
    name: "上线核验已撤销，请重新核验",
    orderItemId: task.orderItemId,
    deliveryTicketId: ticket.id,
    staffIds:
      publisher?.status === "active" && publisher.staffRoleKey === "publisher"
        ? [publisher.id]
        : [],
  };
}

export async function launchRevokeEventCurrentForNotify(
  tx: Tx,
  input: { eventId: string; payload: Record<string, unknown> },
) {
  const schema = EVENT_PAYLOAD_SCHEMAS["launch.verify_revoked"],
    payload = schema.parse(input.payload);
  const fact = await launchRevokedForNotify(tx, payload.launchTaskId);
  if (!fact || fact.orderItemId !== payload.orderItemId) return false;
  const [task, latest] = await Promise.all([
    tx.launchTask.findUnique({ where: { id: fact.bizId }, select: { isLive: true } }),
    tx.outboxEvent.findFirst({
      where: {
        eventType: "launch.verify_revoked",
        aggregateType: "launch_task",
        aggregateId: fact.bizId,
      },
      orderBy: { seq: "desc" },
    }),
  ]);
  return (
    task?.isLive === payload.isLive &&
    latest?.id === input.eventId &&
    JSON.stringify(schema.parse(latest.payload)) === JSON.stringify(payload)
  );
}
export async function accountNoticeFact(tx: Tx, id: string) {
  const row = await tx.channelAccount.findUnique({ where: { id } });
  return row
    ? {
        bizType: "channel_account",
        bizId: row.id,
        entityId: row.entityId,
        storeId: row.storeId,
        status: row.status,
        version: 0,
        name: "发布账号",
      }
    : null;
}
export async function launchNoticeFact(tx: Tx, id: string) {
  const row = await tx.launchTask.findUnique({ where: { id } });
  return row
    ? {
        bizType: "launch_task",
        bizId: row.id,
        entityId: row.entityId,
        storeId: row.storeId,
        status: row.reviewStatus,
        version: row.currentRoundNo,
        name: "上线核验",
        orderItemId: row.orderItemId,
        deliveryTicketId: row.deliveryTicketId,
      }
    : null;
}

export async function launchLinkForItem(tx: Tx, orderItemId: string) {
  const task = await tx.launchTask.findFirst({
    where: { orderItemId, reviewStatus: { not: "void" } },
    select: { id: true, storeId: true },
    orderBy: { id: "asc" },
  });
  return task
    ? { route: "publish.task", params: { launchTaskId: task.id, storeId: task.storeId } }
    : null;
}
