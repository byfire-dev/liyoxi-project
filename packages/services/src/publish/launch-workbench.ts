import {
  FollowUpItemSchema,
  LaunchCalendarItemSchema,
  LaunchTrackItemSchema,
  PlanContentSchema,
} from "@liyoxi/contract";
import type {
  LaunchCalendarQuery,
  LaunchTaskListQuery,
  LaunchTaskSummaryQuery,
} from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { addDays, calendarDate, diffDays } from "@liyoxi/shared/time";
import { assertAccess, satisfiesLevel } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Clock, Tx, TxRunner } from "../kernel/index.js";
import { dateOf, iso, snapshotOf, staffBrief, ticketScope } from "./repo.js";
import { brief, storeBrief, taskBrief } from "./views.js";
import { deriveLaunchOverdue } from "./launch-overdue.js";
import { launchOverdueHistory } from "./launch-overdue-history.js";
import { readLaunchWorkCalendar } from "./launch-work-calendar.js";

const include = {
  store: true,
  orderItem: { include: { orderItemAccounts: { include: { channelAccount: true } } } },
  dramaOrder: { include: { deliveryPlan: { include: { deliveryPlanVersions: true } } } },
  deliveryTicketPauses: { where: { releasedAt: null } },
  launchTasks: {
    include: {
      channelAccount: true,
      launchSubmissions: {
        include: { approvalRequest: true },
        orderBy: { roundNo: "desc" as const },
      },
    },
  },
} satisfies Prisma.DeliveryTicketInclude;
type Row = Prisma.DeliveryTicketGetPayload<{ include: typeof include }>;
type Filters = Pick<LaunchTaskSummaryQuery, "managerId" | "deliveryTicketId" | "orderItemId" | "q">;
const activeTasks = (row: Row) => row.launchTasks.filter((task) => task.reviewStatus !== "void");
const overdueOf = (row: Row, now: Date) =>
  deriveLaunchOverdue(
    {
      orderItemId: row.orderItemId,
      agreedLaunchDate: row.orderItem.agreedLaunchDate,
      usageEndDate: row.orderItem.usageEndDate,
      phase: row.orderItem.phase,
      deliveredAt: row.deliveredAt,
      pauseCount: row.pauseCount,
      tasks: row.launchTasks,
    },
    now,
  );

async function rowsFor(tx: Tx, staff: StaffContext, query: Filters) {
  const filters: Prisma.DeliveryTicketWhereInput = {
    ...(query.managerId ? { deliveryManagerId: query.managerId } : {}),
    ...(query.deliveryTicketId ? { id: query.deliveryTicketId } : {}),
    ...(query.orderItemId ? { orderItemId: query.orderItemId } : {}),
    ...(query.q
      ? {
          OR: [
            { ticketNo: { contains: query.q, mode: "insensitive" } },
            { store: { name: { contains: query.q, mode: "insensitive" } } },
            { dramaOrder: { orderNo: { contains: query.q, mode: "insensitive" } } },
            { orderItem: { dramaSnapshot: { path: ["title"], string_contains: query.q } } },
          ],
        }
      : {}),
  };
  return tx.deliveryTicket.findMany({
    where: { AND: [ticketScope(staff), filters] },
    include,
    orderBy: { id: "asc" },
  });
}

function upcoming(row: Row, now: Date, days: number, readyOnly: boolean) {
  const today = calendarDate(now);
  const agreed = dateOf(row.orderItem.agreedLaunchDate);
  return (
    agreed !== null &&
    agreed >= today &&
    agreed <= addDays(today, days - 1) &&
    ["producing", "to_launch"].includes(row.orderItem.phase) &&
    !row.launchTasks.some((task) => task.isLive) &&
    (!readyOnly || row.deliveredAt !== null)
  );
}

/** 对象已按 publish 的工单范围筛过；只投影同主体同门店的跟进，绝不写 staff 的表。 */
async function followUps(tx: Tx, row: Row, staff: StaffContext) {
  const where = {
    subjectType: "order_item",
    subjectId: row.orderItemId,
    entityId: row.entityId,
    storeId: row.storeId,
  };
  const total = await tx.followUp.count({ where });
  const found = await tx.followUp.findMany({
    where,
    include: { ownerStaff: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 3,
  });
  const items = [];
  for (const follow of found) {
    const isOpen = follow.nextFollowAt !== null && follow.doneAt === null;
    const canChange =
      staff.scope.kind === "all" ||
      staff.staff.id === follow.ownerStaffId ||
      (staff.staff.isLead &&
        staff.staff.staffGroupId !== null &&
        staff.staff.staffGroupId === follow.ownerStaff?.staffGroupId);
    items.push(
      FollowUpItemSchema.parse({
        followUpId: follow.id,
        subjectType: follow.subjectType,
        subjectId: follow.subjectId,
        entityId: follow.entityId,
        storeId: follow.storeId,
        channel: follow.channel,
        content: follow.content,
        intent: follow.intent,
        nextFollowAt: iso(follow.nextFollowAt),
        isOpen,
        owner: await staffBrief(tx, follow.ownerStaffId),
        doneAt: iso(follow.doneAt),
        doneNote: follow.doneNote,
        recorder: {
          actorType: follow.actorType,
          staff: follow.actorType === "staff" ? await staffBrief(tx, follow.actorId) : null,
        },
        createdAt: follow.createdAt.toISOString(),
        lockVersion: follow.lockVersion,
        actions:
          isOpen && canChange && staff.moduleLevels.publish !== "n" ? ["update", "complete"] : [],
      }),
    );
  }
  return { items, total };
}

async function sharedView(tx: Tx, row: Row, staff: StaffContext, now: Date) {
  const overdue = overdueOf(row, now);
  const today = calendarDate(now);
  const follow = await followUps(tx, row, staff);
  const reminder = await tx.manualReminderLog.findFirst({
    where: { subjectType: "order_item", subjectId: row.orderItemId, scene: "golive" },
    orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
  });
  const isRemindedToday = reminder !== null && dateOf(reminder.bizDate) === today;
  // 与 a05 的 delivery=view、本人/主管、操作级数据范围及 golive 场景守卫一致。
  const ownsReminder =
    staff.staff.isLead ||
    staff.staff.roleKey === "super_admin" ||
    row.deliveryManagerId === staff.staff.id ||
    row.publisherId === staff.staff.id;
  const operationScope =
    staff.moduleLevels.delivery !== "o" ||
    row.editorId === staff.staff.id ||
    row.publisherId === staff.staff.id;
  const canRemind =
    satisfiesLevel(staff.moduleLevels.delivery, "view") &&
    ownsReminder &&
    operationScope &&
    row.pauseCount === 0 &&
    ["awaiting_launch", "launch_verify"].includes(row.step) &&
    !isRemindedToday &&
    activeTasks(row).some(
      (task) => !task.isLive && ["pending", "need_fix"].includes(task.reviewStatus),
    );
  return {
    ticket: {
      deliveryTicketId: row.id,
      ticketNo: row.ticketNo,
      step: row.step,
      isPaused: row.pauseCount > 0,
      pauseReasons: row.deliveryTicketPauses.map((pause) => pause.reason),
      deliveryManager: await staffBrief(tx, row.deliveryManagerId),
      publisher: await staffBrief(tx, row.publisherId),
      deliveryTargetAt: row.deliveryTargetAt.toISOString(),
      deliveredAt: iso(row.deliveredAt),
    },
    store: await storeBrief(tx, row.storeId),
    tasks: activeTasks(row).map((task) => ({
      ...taskBrief(
        {
          ...task,
          orderItem: { ...row.orderItem, dramaOrder: row.dramaOrder },
          deliveryTicket: row,
        },
        now,
      ),
      isOverdue: overdue?.overdueTaskIds.includes(task.id) ?? false,
      currentSubmissionId:
        task.launchSubmissions.find((submission) => submission.roundNo === task.currentRoundNo)
          ?.id ?? null,
    })),
    followUpCount: follow.total,
    followUps: follow.items,
    lastRemindedAt: iso(reminder?.createdAt ?? null),
    isRemindedToday,
    actions: canRemind ? ["remind" as const] : [],
  };
}

async function trackView(tx: Tx, row: Row, staff: StaffContext, now: Date) {
  const item = row.orderItem;
  const agreed = dateOf(item.agreedLaunchDate);
  const today = calendarDate(now);
  const overdue = overdueOf(row, now);
  return LaunchTrackItemSchema.parse({
    ...(await sharedView(tx, row, staff, now)),
    orderItem: {
      orderItemId: item.id,
      orderId: row.dramaOrderId,
      orderNo: row.dramaOrder.orderNo,
      orderedAt: iso(row.dramaOrder.submittedAt),
      dramaTitle: snapshotOf(item.dramaSnapshot).title ?? "",
      episodeCount: item.episodeCount,
      productionModel: item.productionModel,
      phase: item.phase,
      agreedLaunchDate: agreed,
      usageStartDate: dateOf(item.usageStartDate),
      usageEndDate: dateOf(item.usageEndDate),
      usageEndSource: item.usageEndSource,
      liveEpisodeCount: item.liveEpisodeCount,
    },
    isDelivered: row.deliveredAt !== null,
    overdue: overdue
      ? { startDate: overdue.overdueStartDate, days: overdue.overdueDays, reason: overdue.reason }
      : null,
    daysUntilLaunch: agreed !== null && agreed >= today ? diffDays(agreed, today) : null,
  });
}

function tentative(row: Row) {
  const plan = row.dramaOrder.deliveryPlan;
  if (!plan || plan.currentVersionNo === 0) return null;
  const version = plan.deliveryPlanVersions.find(
    (candidate) => candidate.versionNo === plan.currentVersionNo,
  );
  if (!version) throw new AppError("INTERNAL", { message: "当前已推送方案版本缺失" });
  return (
    PlanContentSchema.parse(version.contentSnapshot).items.find(
      (item) => item.orderItemId === row.orderItemId,
    ) ?? null
  );
}
const producingSteps = [
  "assigning",
  "plan_confirm",
  "ad_prep",
  "sample_making",
  "sample_confirm",
  "batch_compose",
  "delivering",
];
function calendarStatus(row: Row, now: Date) {
  if (overdueOf(row, now)) return "overdue" as const;
  if (row.step === "launch_verify") return "verifying" as const;
  if (row.step === "awaiting_launch") return "to_launch" as const;
  return producingSteps.includes(row.step) ? ("producing" as const) : null;
}
export function launchCalendarBounds(query: LaunchCalendarQuery) {
  if (query.month && (query.from || query.to)) throw new AppError("VALIDATION_FAILED");
  if (query.month) {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(query.month)) throw new AppError("VALIDATION_FAILED");
    const date = new Date(`${query.month}-01T00:00:00.000Z`);
    date.setUTCMonth(date.getUTCMonth() + 1, 0);
    return { from: `${query.month}-01`, to: date.toISOString().slice(0, 10) };
  }
  if (!query.from || !query.to || query.from > query.to || diffDays(query.to, query.from) >= 42)
    throw new AppError("VALIDATION_FAILED");
  return { from: query.from, to: query.to };
}

export function createLaunchWorkbench(deps: { tx: TxRunner; clock: Clock }) {
  const access = (staff: StaffContext) =>
    assertAccess(staff, { module: { module: "publish", need: "view" }, permission: null });
  return {
    async list(staff: StaffContext, query: LaunchTaskListQuery) {
      access(staff);
      return deps.tx.run(async (tx) => {
        const now = deps.clock.now();
        const rows = (await rowsFor(tx, staff, query)).filter((row) =>
          query.tab === "overdue"
            ? overdueOf(row, now) !== null
            : query.tab === "upcoming"
              ? upcoming(row, now, query.days, query.readyOnly)
              : activeTasks(row).length > 0,
        );
        rows.sort(
          (a, b) =>
            (query.tab === "overdue"
              ? overdueOf(b, now)!.overdueDays - overdueOf(a, now)!.overdueDays
              : (dateOf(a.orderItem.agreedLaunchDate) ?? "9999").localeCompare(
                  dateOf(b.orderItem.agreedLaunchDate) ?? "9999",
                )) || a.orderItemId.localeCompare(b.orderItemId),
        );
        const page = rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
        const items = [];
        for (const row of page) items.push(await trackView(tx, row, staff, now));
        return { items, total: rows.length, page: query.page, pageSize: query.pageSize };
      });
    },
    async summary(staff: StaffContext, query: LaunchTaskSummaryQuery) {
      access(staff);
      return deps.tx.run(async (tx) => {
        const now = deps.clock.now();
        const rows = await rowsFor(tx, staff, query);
        const upcomingRows = rows.filter((row) => upcoming(row, now, query.days, false));
        return {
          overdue: rows.filter((row) => overdueOf(row, now) !== null).length,
          upcoming: upcomingRows.filter((row) => row.deliveredAt !== null).length,
          deliveringSoon: query.readyOnly
            ? 0
            : upcomingRows.filter((row) => row.deliveredAt === null).length,
          all: rows.filter((row) => activeTasks(row).length > 0).length,
          last30Days: await launchOverdueHistory(
            tx,
            rows.map((row) => ({
              orderItemId: row.orderItemId,
              agreedLaunchDate: row.orderItem.agreedLaunchDate,
              deliveredAt: row.deliveredAt,
              episodeCount: row.orderItem.episodeCount,
              tasks: row.launchTasks,
            })),
            now,
          ),
        };
      });
    },
    async calendar(staff: StaffContext, query: LaunchCalendarQuery) {
      access(staff);
      const { from, to } = launchCalendarBounds(query);
      return deps.tx.run(async (tx) => {
        const now = deps.clock.now();
        const candidates = (await rowsFor(tx, staff, query))
          .flatMap((row) => {
            const status = calendarStatus(row, now);
            const date =
              dateOf(row.orderItem.agreedLaunchDate) ?? tentative(row)?.agreedLaunchDate ?? null;
            return status !== null && date !== null && date >= from && date <= to
              ? [{ row, status, date }]
              : [];
          })
          .sort(
            (a, b) =>
              a.date.localeCompare(b.date) ||
              (a.row.store.name ?? "").localeCompare(b.row.store.name ?? "", "zh-CN") ||
              a.row.orderItemId.localeCompare(b.row.orderItemId),
          );
        const stats = {
          total: candidates.length,
          producing: 0,
          toLaunch: 0,
          verifying: 0,
          overdue: 0,
        };
        for (const candidate of candidates)
          stats[candidate.status === "to_launch" ? "toLaunch" : candidate.status]++;
        const days: Array<{
          date: string;
          items: ReturnType<typeof LaunchCalendarItemSchema.parse>[];
        }> = [];
        for (const { row, status, date } of candidates.slice(0, query.limit)) {
          const common = await sharedView(tx, row, staff, now);
          let accounts = row.orderItem.orderItemAccounts.map((account) =>
            brief(account.channelAccount),
          );
          if (!accounts.length) {
            const plan = tentative(row);
            if (plan) {
              const found = await tx.channelAccount.findMany({
                where: {
                  id: { in: plan.accounts.map((account) => account.channelAccountId) },
                  entityId: row.entityId,
                  storeId: row.storeId,
                },
              });
              accounts = found.map(brief);
            }
          }
          const item = LaunchCalendarItemSchema.parse({
            orderItemId: row.orderItemId,
            ticket: common.ticket,
            store: common.store,
            dramaTitle: snapshotOf(row.orderItem.dramaSnapshot).title ?? "",
            episodeCount: row.orderItem.episodeCount,
            agreedLaunchDate: date,
            isDateTentative: row.orderItem.agreedLaunchDate === null,
            calendarStatus: status,
            accounts,
            tasks: common.tasks,
            isDeliveryLate: row.deliveredAt === null && now > row.deliveryTargetAt,
            overdueDays: overdueOf(row, now)?.overdueDays ?? null,
            latestFollowUp: common.followUps[0] ?? null,
            actions: common.actions,
          });
          let day = days.find((entry) => entry.date === date);
          if (!day) {
            day = { date, items: [] };
            days.push(day);
          }
          day.items.push(item);
        }
        return {
          from,
          to,
          today: calendarDate(now),
          stats,
          days,
          workCalendar: await readLaunchWorkCalendar(tx, deps.clock, from, to),
          total: candidates.length,
          isTruncated: candidates.length > days.reduce((sum, day) => sum + day.items.length, 0),
        };
      });
    },
  };
}
