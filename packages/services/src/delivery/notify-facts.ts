import type { Tx } from "../kernel/index.js";
export async function planForNotify(tx: Tx, id: string) {
  const row = await tx.deliveryPlan.findUnique({ where: { id } });
  return row
    ? {
        bizType: "delivery_plan",
        bizId: row.id,
        entityId: row.entityId,
        storeId: row.storeId,
        status: row.status,
        version: row.currentVersionNo,
        name: "定制方案",
        orderId: row.dramaOrderId,
      }
    : null;
}
export async function sampleForNotify(tx: Tx, id: string) {
  const row = await tx.sample.findUnique({
    where: { id },
    include: {
      deliveryTicket: {
        select: {
          orderItemId: true,
          dramaOrderId: true,
          step: true,
          pausedAt: true,
          currentSampleVersionNo: true,
        },
      },
    },
  });
  return row
    ? {
        bizType: "sample",
        bizId: row.id,
        entityId: row.entityId,
        storeId: row.storeId,
        status:
          row.deliveryTicket.pausedAt === null &&
          row.deliveryTicket.step === "sample_confirm" &&
          row.deliveryTicket.currentSampleVersionNo === row.versionNo
            ? row.status
            : "inactive",
        version: row.versionNo,
        name: `第${row.versionNo}版样片`,
        orderId: row.deliveryTicket.dramaOrderId,
        orderItemId: row.deliveryTicket.orderItemId,
        deliveryTicketId: row.deliveryTicketId,
      }
    : null;
}
export async function releaseForNotify(tx: Tx, id: string) {
  const row = await tx.deliveryRelease.findUnique({
    where: { id },
    include: {
      deliveryTicket: { select: { dramaOrderId: true } },
    },
  });
  return row
    ? {
        bizType: "delivery_release",
        bizId: row.id,
        entityId: row.entityId,
        storeId: row.storeId,
        status: row.state,
        version: row.releaseNo,
        name: "定制成片",
        orderId: row.deliveryTicket.dramaOrderId,
        orderItemId: row.orderItemId,
      }
    : null;
}
export async function samplesAwaitingMerchant(tx: Tx, query: Readonly<Record<string, unknown>>) {
  if (!(query.pushedFrom instanceof Date) || !(query.pushedTo instanceof Date))
    throw new TypeError("样片提醒时间范围缺失");
  const rows = await tx.sample.findMany({
    where: {
      status: "pushed",
      pushedAt: { gte: query.pushedFrom, lte: query.pushedTo },
      deliveryTicket: { step: "sample_confirm", pausedAt: null },
    },
    select: {
      id: true,
      versionNo: true,
      deliveryTicket: { select: { currentSampleVersionNo: true } },
    },
    orderBy: { id: "asc" },
  });
  return rows
    .filter((row) => row.versionNo === row.deliveryTicket.currentSampleVersionNo)
    .map((row) => ({ sampleId: row.id, version: row.versionNo }));
}

export async function ticketForNotify(tx: Tx, id: string) {
  const row = await tx.deliveryTicket.findUnique({ where: { id } });
  if (!row) return null;
  const owner = ["sample_making", "batch_compose"].includes(row.step)
    ? row.editorId
    : ["delivering", "launch_verify", "takedown"].includes(row.step)
      ? (row.publisherId ?? row.deliveryManagerId)
      : row.deliveryManagerId;
  return {
    bizType: "delivery_ticket",
    bizId: row.id,
    entityId: row.entityId,
    storeId: row.storeId,
    status: row.step,
    version: row.lockVersion,
    name: "交付工单",
    orderId: row.dramaOrderId,
    orderItemId: row.orderItemId,
    deliveryTicketId: row.id,
    staffIds: owner ? [owner] : [],
  };
}
export async function ticketManagerForNotify(tx: Tx, id: string) {
  const row = await tx.deliveryTicket.findUnique({ where: { id } });
  const fact = await ticketForNotify(tx, id);
  return row && fact
    ? { ...fact, staffIds: row.deliveryManagerId ? [row.deliveryManagerId] : [] }
    : null;
}
export async function ticketEditorForNotify(tx: Tx, id: string) {
  const row = await tx.deliveryTicket.findUnique({ where: { id } });
  const fact = await ticketForNotify(tx, id);
  return row && fact ? { ...fact, staffIds: row.editorId ? [row.editorId] : [] } : null;
}
export async function planManagerForNotify(tx: Tx, id: string) {
  const fact = await planForNotify(tx, id);
  if (!fact) return null;
  const order = await tx.dramaOrder.findUnique({
    where: { id: fact.orderId },
    select: { deliveryManagerId: true },
  });
  const ticket = await tx.deliveryTicket.findFirst({
    where: { dramaOrderId: fact.orderId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return order && ticket
    ? {
        ...fact,
        deliveryTicketId: ticket.id,
        staffIds: order.deliveryManagerId ? [order.deliveryManagerId] : [],
      }
    : null;
}
export async function sampleManagerForNotify(tx: Tx, id: string) {
  const fact = await sampleForNotify(tx, id);
  const ticket = fact ? await ticketManagerForNotify(tx, fact.deliveryTicketId) : null;
  return fact && ticket ? { ...fact, staffIds: ticket.staffIds } : null;
}
export async function sampleEditorForNotify(tx: Tx, id: string) {
  const fact = await sampleForNotify(tx, id);
  const ticket = fact ? await ticketEditorForNotify(tx, fact.deliveryTicketId) : null;
  return fact && ticket ? { ...fact, staffIds: ticket.staffIds } : null;
}
