import type { Tx } from "../kernel/index.js";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";

/** Only delivery owns these rows; notify asks a boolean before projecting the current fact. */
export async function deliveryEventCurrentForNotify(
  tx: Tx,
  input: { type: string; payload: Record<string, unknown> },
) {
  if (input.type === "package.reissue_opened") {
    const p = EVENT_PAYLOAD_SCHEMAS["package.reissue_opened"].parse(input.payload);
    const row = await tx.deliveryReissue.findUnique({
      where: { id: p.deliveryReissueId },
      include: { deliveryTicket: true },
    });
    return (
      !!row &&
      row.deliveryTicketId === p.deliveryTicketId &&
      row.deliveryTicket.orderItemId === p.orderItemId &&
      row.reasonCode === p.reasonCode &&
      [...row.episodeNos].sort((a, b) => a - b).join() ===
        [...p.episodeNos].sort((a, b) => a - b).join()
    );
  }
  if (input.type === "package.reissued") {
    const p = EVENT_PAYLOAD_SCHEMAS["package.reissued"].parse(input.payload);
    const row = await tx.deliveryReissue.findUnique({
      where: { id: p.deliveryReissueId },
      include: { deliveryTicket: true },
    });
    return (
      !!row &&
      row.status === "published" &&
      row.publishedDeliveryReleaseId === p.deliveryReleaseId &&
      row.deliveryTicketId === p.deliveryTicketId &&
      row.deliveryTicket.orderItemId === p.orderItemId &&
      [...row.episodeNos].sort((a, b) => a - b).join() ===
        [...p.episodeNos].sort((a, b) => a - b).join()
    );
  }
  if (input.type === "order.item.launch_rescheduled") {
    const p = EVENT_PAYLOAD_SCHEMAS["order.item.launch_rescheduled"].parse(input.payload);
    const item = await tx.orderItem.findUnique({
      where: { id: p.orderItemId },
      select: { dramaOrderId: true, agreedLaunchDate: true },
    });
    return (
      !!item &&
      item.dramaOrderId === p.dramaOrderId &&
      item.agreedLaunchDate?.toISOString().slice(0, 10) === p.newDate
    );
  }
  return false;
}
export async function reissueEditorForNotify(tx: Tx, id: string) {
  const row = await tx.deliveryReissue.findUnique({
    where: { id },
    include: { deliveryTicket: { include: { editor: true, orderItem: true } } },
  });
  const ticket = row?.deliveryTicket;
  if (
    !row ||
    row.status !== "open" ||
    !ticket ||
    ticket.pauseCount ||
    !["awaiting_launch", "launch_verify", "in_service"].includes(ticket.step) ||
    ticket.editor?.status !== "active" ||
    ticket.editor.staffRoleKey !== "editor"
  )
    return null;
  return {
    bizType: "delivery_reissue",
    bizId: row.id,
    entityId: row.entityId,
    storeId: row.storeId,
    status: row.status,
    version: 0,
    name: "成片补发待处理",
    orderId: ticket.dramaOrderId,
    orderItemId: ticket.orderItemId,
    deliveryTicketId: ticket.id,
    staffIds: [ticket.editor.id],
    targetDate: ticket.orderItem.usageEndDate.toISOString().slice(0, 10),
  };
}
export async function reissuedReleaseForNotify(tx: Tx, id: string) {
  const release = await tx.deliveryRelease.findUnique({
    where: { id },
    include: { orderItem: true, deliveryTicket: true },
  });
  if (
    !release ||
    release.kind !== "reissue" ||
    release.state !== "pushed" ||
    release.deliveryTicket.pauseCount ||
    !["awaiting_launch", "launch_verify", "in_service"].includes(release.deliveryTicket.step)
  )
    return null;
  const published = await tx.deliveryReissue.findFirst({
    where: {
      status: "published",
      deliveryTicketId: release.deliveryTicketId,
      publishedDeliveryReleaseId: id,
    },
  });
  const latest = await tx.deliveryRelease.findFirst({
    where: { orderItemId: release.orderItemId, state: "pushed" },
    orderBy: { releaseNo: "desc" },
    select: { id: true },
  });
  if (
    !published ||
    latest?.id !== id ||
    release.orderItem.id !== release.deliveryTicket.orderItemId
  )
    return null;
  return {
    bizType: "delivery_release",
    bizId: id,
    entityId: release.entityId,
    storeId: release.storeId,
    status: release.state,
    version: release.releaseNo,
    name: "补发成片已更新",
    orderId: release.deliveryTicket.dramaOrderId,
    orderItemId: release.orderItemId,
    deliveryTicketId: release.deliveryTicketId,
    targetDate: release.orderItem.usageEndDate.toISOString().slice(0, 10),
  };
}
export async function launchRescheduledItemForNotify(tx: Tx, id: string) {
  const item = await tx.orderItem.findUnique({ where: { id }, include: { deliveryTicket: true } });
  if (
    !item ||
    !item.agreedLaunchDate ||
    item.usageStartDate ||
    !["producing", "awaiting_launch"].includes(item.phase) ||
    !item.deliveryTicket ||
    ["archived", "terminated", "takedown", "in_service"].includes(item.deliveryTicket.step)
  )
    return null;
  return {
    bizType: "order_item",
    bizId: id,
    entityId: item.entityId,
    storeId: item.storeId,
    status: "scheduled",
    version: 0,
    name: "约定上线日已调整",
    orderId: item.dramaOrderId,
    orderItemId: id,
    deliveryTicketId: item.deliveryTicket.id,
    targetDate: item.agreedLaunchDate.toISOString().slice(0, 10),
  };
}

export async function manualReminderTargetForNotify(
  tx: Tx,
  input: { subjectId: string; scene: string },
) {
  const t = await tx.deliveryTicket.findFirst({
    where: input.scene === "golive" ? { orderItemId: input.subjectId } : { id: input.subjectId },
    include: { dramaOrder: { include: { deliveryPlan: true } }, launchTasks: true },
  });
  if (!t || t.pauseCount) return null;
  if (input.scene === "confirm_plan")
    return t.step === "plan_confirm" && t.dramaOrder.deliveryPlan?.status === "pending_confirm"
      ? { refId: t.dramaOrder.deliveryPlan.id }
      : null;
  if (input.scene === "confirm_sample") {
    const sample = await tx.sample.findFirst({
      where: { deliveryTicketId: t.id, versionNo: t.currentSampleVersionNo ?? 0, status: "pushed" },
    });
    return t.step === "sample_confirm" && sample ? { refId: sample.id } : null;
  }
  return input.scene === "golive" &&
    ["awaiting_launch", "launch_verify"].includes(t.step) &&
    t.launchTasks.some((l) => !l.isLive && ["pending", "need_fix"].includes(l.reviewStatus))
    ? { refId: t.id }
    : null;
}
export async function launchReminderForNotify(tx: Tx, id: string) {
  const row = await tx.deliveryTicket.findUnique({
    where: { id },
    include: { launchTasks: true, orderItem: true },
  });
  return row
    ? {
        bizType: "delivery_ticket",
        bizId: id,
        entityId: row.entityId,
        storeId: row.storeId,
        status:
          !row.pauseCount &&
          ["awaiting_launch", "launch_verify"].includes(row.step) &&
          row.launchTasks.some((l) => !l.isLive && ["pending", "need_fix"].includes(l.reviewStatus))
            ? "pending"
            : "inactive",
        version: row.lockVersion,
        name: "约定上线提醒",
        orderId: row.dramaOrderId,
        orderItemId: row.orderItemId,
        deliveryTicketId: id,
        ...(row.orderItem.agreedLaunchDate
          ? { targetDate: row.orderItem.agreedLaunchDate.toISOString().slice(0, 10) }
          : {}),
      }
    : null;
}
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
