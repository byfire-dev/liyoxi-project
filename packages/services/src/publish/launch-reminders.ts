import { addDays, calendarDate, dayOfWeek } from "@liyoxi/shared/time";
import { DateSchema, IdSchema } from "@liyoxi/contract";
import type { ReminderRule, Tx } from "../kernel/index.js";
import { listOverdueLaunchItems } from "./launch-overdue.js";

export async function listLaunchReminderTargets(
  tx: Tx,
  input: { launchDate: string; storeId?: string },
) {
  const launchDate = DateSchema.parse(input.launchDate);
  const rows = await tx.launchTask.findMany({
    where: {
      reviewStatus: { in: ["pending", "need_fix"] },
      isLive: false,
      ...(input.storeId ? { storeId: IdSchema.parse(input.storeId) } : {}),
      orderItem: {
        agreedLaunchDate: new Date(launchDate),
        phase: { in: ["to_launch", "live"] },
        usageEndDate: { gte: new Date(launchDate) },
      },
      deliveryTicket: {
        deliveredAt: { not: null },
        pauseCount: 0,
        step: { in: ["awaiting_launch", "launch_verify", "in_service"] },
      },
    },
    include: { orderItem: true, channelAccount: true },
    orderBy: [{ orderItemId: "asc" }, { id: "asc" }],
  });
  const grouped = new Map<
    string,
    {
      storeId: string;
      entityId: string;
      orderItemId: string;
      dramaName: string;
      episodes: number;
      launchTaskId: string;
      pendingAccounts: Array<{ platform: string; name: string }>;
    }
  >();
  for (const row of rows) {
    let item = grouped.get(row.orderItemId);
    if (!item) {
      item = {
        storeId: row.storeId,
        entityId: row.entityId,
        orderItemId: row.orderItemId,
        dramaName: (row.orderItem.dramaSnapshot as { title: string }).title,
        episodes: row.orderItem.episodeCount,
        launchTaskId: row.id,
        pendingAccounts: [],
      };
      grouped.set(row.orderItemId, item);
    }
    item.pendingAccounts.push({ platform: row.platform, name: row.channelAccount.accountName });
  }
  return [...grouped.values()];
}

async function launchFact(tx: Tx, storeId: string, launchDate: string) {
  const items = await listLaunchReminderTargets(tx, { storeId, launchDate });
  const first = items[0];
  if (!first) return null;
  return {
    bizType: "store",
    bizId: storeId,
    entityId: first.entityId,
    storeId,
    status: "pending",
    version: 0,
    name: "上线提醒",
    targetDate: launchDate,
    quantity: items.length,
    items: items.map((i) => ({
      orderItemId: i.orderItemId,
      dramaName: i.dramaName,
      pendingAccounts: i.pendingAccounts,
    })),
    summary:
      `${launchDate}有${items.length}部短剧待上线：${items.map((i) => i.dramaName).join("、")}`.slice(
        0,
        200,
      ),
    link: { route: "publish.task", params: { launchTaskId: first.launchTaskId, storeId } },
  };
}

export const launchReminderRule: ReminderRule = {
  async targets(tx, query) {
    const launchDate = DateSchema.parse(query.launchDate);
    const rows = await listLaunchReminderTargets(tx, { launchDate });
    return [...new Set(rows.map((r) => r.storeId))]
      .sort()
      .map((storeId) => ({ storeId, launchDate }));
  },
  async revalidate(tx, query) {
    const now = query.now instanceof Date ? query.now : null;
    const launchDate = DateSchema.parse(query.launchDate ?? query.targetDate),
      storeId = IdSchema.parse(query.storeId);
    if (!now || calendarDate(now) > launchDate) return { valid: false };
    const fact = await launchFact(tx, storeId, launchDate);
    return fact ? { valid: true, vars: fact } : { valid: false };
  },
};

async function overdueFacts(tx: Tx, date: string) {
  const day = await tx.workCalendarDay.findUnique({ where: { day: new Date(date) } });
  const workday = day?.isWorkday ?? dayOfWeek(date) <= 5;
  const items = await listOverdueLaunchItems(tx, new Date(`${date}T01:00:00Z`));
  return items.filter((i) => workday || addDays(i.agreedLaunchDate!, 1) === date);
}

export const overdueLaunchReminderRule: ReminderRule = {
  async targets(tx, query) {
    const date = DateSchema.parse(query.date);
    const items = await overdueFacts(tx, date);
    return [...new Set(items.flatMap((r) => (r.deliveryManagerId ? [r.deliveryManagerId] : [])))]
      .sort()
      .map((staffId) => ({ staffId, date }));
  },
  async revalidate(tx, query) {
    const date = DateSchema.parse(query.date ?? query.targetDate),
      staffId = IdSchema.parse(query.staffId ?? query.bizId);
    const now = query.now instanceof Date ? query.now : null;
    if (!now || calendarDate(now) !== date) return { valid: false };
    const staff = await tx.staff.findUnique({ where: { id: staffId } });
    if (staff?.status !== "active") return { valid: false };
    const items = (await overdueFacts(tx, date)).filter((r) => r.deliveryManagerId === staffId);
    if (!items.length) return { valid: false };
    return {
      valid: true,
      vars: {
        bizType: "staff",
        bizId: staffId,
        entityId: null,
        storeId: null,
        status: "overdue",
        version: 0,
        name: "上线逾期",
        targetDate: date,
        staffIds: [staffId],
        items: items.map((i) => ({
          orderItemId: i.orderItemId,
          dramaName: i.dramaTitle,
          overdueDays: i.overdueDays,
          reason: i.reason,
        })),
        quantity: items.length,
        summary:
          `${items.length}部短剧逾期未上线：${items.map((i) => i.dramaTitle).join("、")}`.slice(
            0,
            200,
          ),
      },
    };
  },
};
