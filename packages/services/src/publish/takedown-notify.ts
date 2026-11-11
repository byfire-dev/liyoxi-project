import { DateSchema, IdSchema } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import type { ReminderRule, Tx } from "../kernel/index.js";

/** R3 groups the current pending accounts by store and licensed end date. */
export async function listTakedownReminderTargets(
  tx: Tx,
  query: { usageEndDate: string; storeId?: string },
) {
  const rows = await tx.takedownTask.findMany({
    where: {
      status: "pending_merchant",
      usageEndDate: new Date(query.usageEndDate),
      ...(query.storeId ? { storeId: query.storeId } : {}),
    },
    include: { orderItem: true, channelAccount: true },
    orderBy: { id: "asc" },
  });
  const grouped = new Map<
    string,
    {
      storeId: string;
      entityId: string;
      orderItemId: string;
      takedownTaskId: string;
      dramaName: string;
      pendingAccounts: { platform: string; name: string }[];
    }
  >();
  for (const row of rows) {
    if (
      !row.orderItem.usageEndDate ||
      row.orderItem.usageEndDate.getTime() !== row.usageEndDate.getTime()
    )
      continue;
    let item = grouped.get(row.orderItemId);
    if (!item) {
      item = {
        storeId: row.storeId,
        entityId: row.entityId,
        orderItemId: row.orderItemId,
        takedownTaskId: row.id,
        dramaName: (row.orderItem.dramaSnapshot as { title: string }).title,
        pendingAccounts: [],
      };
      grouped.set(row.orderItemId, item);
    }
    item.pendingAccounts.push({
      platform: row.channelAccount.platform,
      name: row.channelAccount.accountName,
    });
  }
  return [...grouped.values()];
}
export async function takedownReminderFact(tx: Tx, storeId: string, usageEndDate: string) {
  const items = await listTakedownReminderTargets(tx, { storeId, usageEndDate }),
    first = items[0];
  if (!first) return null;
  return {
    bizType: "store",
    bizId: storeId,
    entityId: first.entityId,
    storeId,
    status: "pending",
    version: 0,
    name: "下架提醒",
    targetDate: usageEndDate,
    quantity: items.length,
    items: items.map(({ orderItemId, dramaName, pendingAccounts }) => ({
      orderItemId,
      dramaName,
      pendingAccounts,
    })),
    summary:
      `${usageEndDate}有${items.length}部短剧待下架：${items.map((i) => i.dramaName).join("、")}`.slice(
        0,
        200,
      ),
    link: {
      route: "offline.task" as const,
      params: { takedownTaskId: first.takedownTaskId, storeId },
    },
  };
}
export const takedownReminderRule: ReminderRule = {
  async targets(tx, query) {
    const usageEndDate = DateSchema.parse(query.usageEndDate);
    const items = await listTakedownReminderTargets(tx, { usageEndDate });
    return [...new Set(items.map((r) => r.storeId))]
      .sort()
      .map((storeId) => ({ storeId, usageEndDate }));
  },
  async revalidate(tx, query) {
    const usageEndDate = DateSchema.parse(query.usageEndDate ?? query.targetDate),
      storeId = IdSchema.parse(query.storeId);
    if (!(query.now instanceof Date) || calendarDate(query.now) > usageEndDate)
      return { valid: false };
    const fact = await takedownReminderFact(tx, storeId, usageEndDate);
    return fact ? { valid: true, vars: fact } : { valid: false };
  },
};
export async function takedownNoticeFact(tx: Tx, id: string) {
  const row = await tx.takedownTask.findUnique({
    where: { id: IdSchema.parse(id) },
    include: { deliveryTicket: true, orderItem: true },
  });
  if (!row || row.status === "void") return null;
  const version = await tx.statusTransition.count({
    where: { machine: "takedown_task", subjectId: row.id, event: { not: "sla.recalculated" } },
  });
  return {
    bizType: "takedown_task",
    bizId: row.id,
    entityId: row.entityId,
    storeId: row.storeId,
    status: row.status,
    version,
    name: "下架任务",
    orderItemId: row.orderItemId,
    deliveryTicketId: row.deliveryTicketId,
    targetDate: row.usageEndDate.toISOString().slice(0, 10),
    dueDate: row.dueDate.toISOString().slice(0, 10),
    ...(row.escalatedAt ? { occurredAt: row.escalatedAt.toISOString() } : {}),
    staffIds: row.deliveryTicket.publisherId ? [row.deliveryTicket.publisherId] : [],
    link: {
      route: "offline.task" as const,
      params: { takedownTaskId: row.id, storeId: row.storeId },
    },
  };
}
/** Event consumption rejects history from before a later confirmation/reopen cycle. */
export async function takedownEventCurrentForNotify(
  tx: Tx,
  input: { eventId: string; type: string; payload: Readonly<Record<string, unknown>> },
) {
  const id = IdSchema.safeParse(input.payload.takedownTaskId);
  if (!id.success) return false;
  const row = await tx.takedownTask.findUnique({ where: { id: id.data } });
  const event = await tx.outboxEvent.findUnique({ where: { id: input.eventId } });
  if (
    !row ||
    row.status === "void" ||
    !event ||
    event.aggregateId !== row.id ||
    event.eventType !== input.type
  )
    return false;
  const expected: Record<string, string> = {
    "takedown.created": "pending_merchant",
    "takedown.merchant_confirmed": "merchant_confirmed",
    "takedown.checked": "checked",
    "takedown.found_online": "pending_merchant",
    "takedown.basis_reopened": "pending_merchant",
    "takedown.escalated": "pending_merchant",
  };
  if (row.status !== expected[input.type]) return false;
  if (
    input.type === "takedown.escalated" &&
    input.payload.dueDate !== row.dueDate.toISOString().slice(0, 10)
  )
    return false;
  const latest = await tx.outboxEvent.findFirst({
    where: { aggregateId: row.id, eventType: { in: Object.keys(expected) } },
    orderBy: { seq: "desc" },
  });
  // Creation can be coalesced with the same pending generation's reminders.
  return latest?.id === event.id;
}
