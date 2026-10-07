// 只读 M1 本轮业务终态；应用层不接触数据库客户端。
import type { PrismaClient } from "@liyoxi/db";
export interface M1StateIds {
  readonly entityId: string;
  readonly storeId: string;
  readonly orderId?: string;
  readonly orderItemId?: string;
  readonly deliveryTicketId?: string;
  readonly sampleId?: string;
  readonly launchTaskId?: string;
  readonly paymentOrderId?: string;
}

export async function readM1State(db: PrismaClient, ids: M1StateIds) {
  const owned = { entityId: ids.entityId, storeId: ids.storeId };
  const [entity, store, wallet, order, item, ticket, sample, launchTask, payment] =
    await Promise.all([
      db.entity.findUniqueOrThrow({ where: { id: ids.entityId } }),
      db.store.findFirstOrThrow({ where: { id: ids.storeId, entityId: ids.entityId } }),
      db.billingAccount.findUnique({ where: { entityId: ids.entityId } }),
      ids.orderId ? db.dramaOrder.findFirstOrThrow({ where: { id: ids.orderId, ...owned } }) : null,
      ids.orderItemId
        ? db.orderItem.findFirstOrThrow({ where: { id: ids.orderItemId, ...owned } })
        : null,
      ids.deliveryTicketId
        ? db.deliveryTicket.findFirstOrThrow({ where: { id: ids.deliveryTicketId, ...owned } })
        : null,
      ids.sampleId
        ? db.sample.findFirstOrThrow({ where: { id: ids.sampleId, deliveryTicket: owned } })
        : null,
      ids.launchTaskId
        ? db.launchTask.findFirstOrThrow({ where: { id: ids.launchTaskId, ...owned } })
        : null,
      ids.paymentOrderId
        ? db.billingOrder.findFirstOrThrow({
            where: { id: ids.paymentOrderId, entityId: ids.entityId },
          })
        : null,
    ]);
  const [
    items,
    tickets,
    plans,
    launchTasks,
    holds,
    ledger,
    terms,
    timers,
    qualifications,
    approvalRequests,
  ] = await Promise.all([
    db.orderItem.findMany({
      where: { ...owned, ...(ids.orderId ? { dramaOrderId: ids.orderId } : {}) },
      orderBy: { itemNo: "asc" },
    }),
    db.deliveryTicket.findMany({
      where: { ...owned, ...(ids.orderId ? { dramaOrderId: ids.orderId } : {}) },
    }),
    db.deliveryPlan.findMany({
      where: { ...owned, ...(ids.orderId ? { dramaOrderId: ids.orderId } : {}) },
    }),
    db.launchTask.findMany({
      where: { ...owned, ...(ids.orderItemId ? { orderItemId: ids.orderItemId } : {}) },
    }),
    db.pointHold.findMany({ where: { entityId: ids.entityId } }),
    db.pointLedgerEntry.findMany({ where: { entityId: ids.entityId } }),
    db.subscriptionTerm.findMany({ where: { entityId: ids.entityId } }),
    db.timer.findMany({
      where: { ...(ids.orderId ? { subjectId: ids.orderId } : { subjectId: ids.entityId }) },
    }),
    db.qualificationSubmission.findMany({ where: { storeId: ids.storeId } }),
    db.approvalRequest.findMany({
      where: { entityId: ids.entityId },
      orderBy: { submittedAt: "desc" },
    }),
  ]);
  return {
    entity,
    store,
    wallet,
    order,
    item,
    ticket,
    sample,
    launchTask,
    payment,
    items,
    tickets,
    plans,
    launchTasks,
    holds,
    ledger,
    terms,
    timers,
    qualifications,
    approvalRequests,
  };
}
