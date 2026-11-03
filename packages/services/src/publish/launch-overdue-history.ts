import type { Prisma } from "@liyoxi/db";
import { divRoundHalfUp } from "@liyoxi/shared/pricing";
import { addDays, calendarDate, endOfDay, startOfDay } from "@liyoxi/shared/time";
import { paramsAt } from "../config/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

export interface LaunchHistoryItem {
  orderItemId: string;
  agreedLaunchDate: Date | null;
  deliveredAt: Date | null;
  episodeCount: number;
  tasks: readonly { id: string; isLive: boolean }[];
}
export interface LaunchHistoryTransition {
  occurredAt: Date;
  toState: string;
  event: string;
  isLive: boolean;
}
export interface LaunchHistoryReschedule {
  at: Date;
  prevDate: string | null;
}

/** 按自然日计数，同一天多次退回/提交不重复计日；区间末端为开区间。 */
export function overdueHistoryDays(
  item: Pick<LaunchHistoryItem, "agreedLaunchDate" | "deliveredAt">,
  transitions: readonly LaunchHistoryTransition[],
  reschedules: readonly LaunchHistoryReschedule[],
  now: Date,
): number {
  if (!item.deliveredAt) return 0;
  const today = calendarDate(now);
  const windowStart = startOfDay(addDays(today, -29)).getTime();
  const deliveredNext = startOfDay(addDays(calendarDate(item.deliveredAt), 1)).getTime();
  const currentAgreed = item.agreedLaunchDate?.toISOString().slice(0, 10) ?? null;
  const days = new Set<string>();
  for (let index = 0; index < transitions.length; index++) {
    const transition = transitions[index]!;
    if (transition.isLive || !["pending", "need_fix"].includes(transition.toState)) continue;
    const from = Math.max(windowStart, transition.occurredAt.getTime());
    const to = Math.min(
      now.getTime(),
      transitions[index + 1]?.occurredAt.getTime() ?? now.getTime(),
    );
    if (from >= to) continue;
    const boundaries = [
      from,
      ...reschedules.map((row) => row.at.getTime()).filter((at) => at > from && at < to),
      to,
    ];
    for (let part = 0; part < boundaries.length - 1; part++) {
      const begin = boundaries[part]!;
      const end = boundaries[part + 1]!;
      const laterChange = reschedules.find((row) => row.at.getTime() > begin);
      const agreed = laterChange ? laterChange.prevDate : currentAgreed;
      if (!agreed) continue;
      const overdueFrom = Math.max(begin, deliveredNext, startOfDay(addDays(agreed, 1)).getTime());
      if (overdueFrom >= end) continue;
      for (
        let date = calendarDate(new Date(overdueFrom));
        startOfDay(date).getTime() < end;
        date = addDays(date, 1)
      ) {
        if (endOfDay(date).getTime() > overdueFrom) days.add(date);
      }
    }
  }
  return days.size;
}

const object = (value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue | undefined> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};

/** 旧历史未存 isLive 时，沿实际写入规则读取当次参数；不套用今天的配置。 */
export async function launchOverdueHistory(tx: Tx, items: readonly LaunchHistoryItem[], now: Date) {
  const taskIds = items.flatMap((item) => item.tasks.map((task) => task.id));
  if (!taskIds.length) return { overdueItemCount: 0, avgOverdueDays: 0, liveItemCount: 0 };
  const histories = await tx.statusTransition.findMany({
    where: {
      machine: "launch_task",
      stateField: "review_status",
      subjectId: { in: taskIds },
      occurredAt: { lte: now },
    },
    orderBy: [{ occurredAt: "asc" }, { seq: "asc" }],
  });
  const changes = await tx.auditLog.findMany({
    where: {
      stream: "activity",
      category: "delivery",
      action: "delivery.order_item.reschedule_launch",
      targetType: "order_item",
      targetId: { in: items.map((item) => item.orderItemId) },
    },
    orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
    select: { targetId: true, createdAt: true, meta: true },
  });
  const parameters = new Map<number, Promise<boolean>>();
  const partialAt = (at: Date) => {
    let result = parameters.get(at.getTime());
    if (!result) {
      result = paramsAt(tx, ["launch.partial_goes_live"], at).then(
        (values) => values["launch.partial_goes_live"],
      );
      parameters.set(at.getTime(), result);
    }
    return result;
  };
  let overdueItemCount = 0;
  let liveItemCount = 0;
  let totalDays = 0;
  for (const item of items) {
    const reschedules = changes
      .filter((row) => row.targetId === item.orderItemId)
      .map((row) => {
        const previous = object(row.meta).prevDate;
        if (
          previous !== null &&
          (typeof previous !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(previous))
        ) {
          throw new AppError("INTERNAL", { message: "上线改期审计缺少真实 prevDate" });
        }
        return { at: row.createdAt, prevDate: previous };
      });
    let maxDays = 0;
    for (const task of item.tasks) {
      let isLive = false;
      const timeline: LaunchHistoryTransition[] = [];
      for (const history of histories.filter((row) => row.subjectId === task.id)) {
        const payload = object(history.payload);
        if (typeof payload.isLive === "boolean") isLive = payload.isLive;
        else if (history.event === "launch.verify_pass") {
          const count = payload.verifiedEpisodeCount;
          if (typeof count !== "number")
            throw new AppError("INTERNAL", { message: "上线核验历史缺少真实核验集数" });
          isLive = isLive || count >= item.episodeCount || (await partialAt(history.occurredAt));
        } else if (history.event === "launch.verify_revoke") {
          throw new AppError("INTERNAL", { message: "撤销核验历史缺少 isLive 事实" });
        }
        timeline.push({
          occurredAt: history.occurredAt,
          toState: history.toState,
          event: history.event,
          isLive,
        });
      }
      maxDays = Math.max(maxDays, overdueHistoryDays(item, timeline, reschedules, now));
    }
    if (maxDays > 0) {
      overdueItemCount++;
      totalDays += maxDays;
      if (item.tasks.some((task) => task.isLive)) liveItemCount++;
    }
  }
  return {
    overdueItemCount,
    avgOverdueDays: overdueItemCount ? divRoundHalfUp([totalDays, 10], [overdueItemCount]) / 10 : 0,
    liveItemCount,
  };
}
