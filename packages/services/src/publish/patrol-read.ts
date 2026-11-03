import { ChecklistItemsSchema } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { hasPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import type { Tx } from "../kernel/index.js";
import { dateOf, dictRef, episodeUrlsOf, iso, snapshotOf, staffBrief } from "./repo.js";
import { brief, storeBrief } from "./views.js";
import { patrolInclude, patrolOf, patrolWhere, weekOf } from "./patrol-repo.js";
import type { PatrolRow } from "./patrol-repo.js";
import type { PatrolDeps, PatrolFilter, PatrolPage } from "./patrol-context.js";

export async function patrolRow(tx: Tx, row: PatrolRow) {
  const previous = await tx.patrolTask.findFirst({
    where: {
      launchTaskId: row.launchTaskId,
      OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }],
      checkedAt: { not: null },
    },
    orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
  });
  return {
    patrolTaskId: row.id,
    weekStartDate: dateOf(row.patrolBatch.weekStartDate),
    source: row.source,
    status: row.status,
    store: await storeBrief(tx, row.storeId),
    orderItemId: row.orderItemId,
    dramaTitle: snapshotOf(row.orderItem.dramaSnapshot).title ?? "",
    episodeCount: row.orderItem.episodeCount,
    usageEndDate: dateOf(row.orderItem.usageEndDate),
    launchTaskId: row.launchTaskId,
    account: brief(row.launchTask.channelAccount),
    previousPatrol: previous
      ? { patrolTaskId: previous.id, status: previous.status, checkedAt: iso(previous.checkedAt) }
      : null,
    abnormalKind: await dictRef(tx, "patrol_issue", row.abnormalKindCode),
    checkedAt: iso(row.checkedAt),
    foundAt: iso(row.foundAt),
    recoveredAt: iso(row.recoveredAt),
    publisher: await staffBrief(tx, row.deliveryTicket.publisherId),
  };
}
export async function patrolDetail(tx: Tx, deps: PatrolDeps, staff: StaffContext, id: string) {
  const row = await patrolOf(tx, id, staff),
    item = row.orderItem,
    ticket = row.deliveryTicket,
    now = deps.clock.now();
  const link = await tx.launchSubmission.findFirst({
    where: { launchTaskId: row.launchTaskId, result: { in: ["passed", "passed_partial"] } },
    orderBy: { roundNo: "desc" },
  });
  const template =
    row.checklistCode && row.checklistVersionNo
      ? await tx.checklistTemplate.findUnique({
          where: { code_versionNo: { code: row.checklistCode, versionNo: row.checklistVersionNo } },
        })
      : null;
  const items = template ? ChecklistItemsSchema.parse(template.items) : [];
  const results = (row.results ?? []) as Array<{ key: string; result: string; note?: string }>;
  const reminder = await tx.manualReminderLog.findFirst({
    where: { subjectType: "patrol_task", subjectId: id, scene: "patrol_fix" },
    orderBy: { createdAt: "desc" },
  });
  const reminded = reminder?.bizDate.toISOString().slice(0, 10) === calendarDate(now);
  const timer = await tx.timer.findFirst({
    where: {
      subjectType: "patrol_task",
      subjectId: id,
      kind: "patrol.followup",
      status: "scheduled",
    },
    orderBy: { fireAt: "asc" },
  });
  const history = await tx.patrolTask.findMany({
    where: { launchTaskId: row.launchTaskId, id: { not: id } },
    include: { patrolBatch: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 10,
  });
  const allowed =
    hasPermission(staff, "publish.patrol.do") &&
    (staff.moduleLevels.publish !== "o" || ticket.publisherId === staff.staff.id);
  return {
    ...(await patrolRow(tx, row)),
    orderItem: {
      orderItemId: item.id,
      orderId: item.dramaOrderId,
      orderNo: item.dramaOrder.orderNo,
      orderedAt: iso(item.dramaOrder.submittedAt),
      dramaTitle: snapshotOf(item.dramaSnapshot).title ?? "",
      episodeCount: item.episodeCount,
      productionModel: item.productionModel,
      phase: item.phase,
      agreedLaunchDate: dateOf(item.agreedLaunchDate),
      usageStartDate: dateOf(item.usageStartDate),
      usageEndDate: dateOf(item.usageEndDate),
      usageEndSource: item.usageEndSource,
      liveEpisodeCount: item.liveEpisodeCount,
    },
    ticket: {
      deliveryTicketId: ticket.id,
      ticketNo: ticket.ticketNo,
      step: ticket.step,
      isPaused: ticket.pauseCount > 0,
      pauseReasons: ticket.deliveryTicketPauses.filter((p) => !p.releasedAt).map((p) => p.reason),
      deliveryManager: await staffBrief(tx, ticket.deliveryManagerId),
      publisher: await staffBrief(tx, ticket.publisherId),
      deliveryTargetAt: iso(ticket.deliveryTargetAt),
      deliveredAt: iso(ticket.deliveredAt),
    },
    liveLink: link
      ? {
          linkKind: link.linkKind,
          collectionUrl: link.collectionUrl,
          episodeUrls: episodeUrlsOf(link.episodeUrls),
        }
      : null,
    checklistCode: row.checklistCode,
    checklistVersionNo: row.checklistVersionNo,
    results: results.map((r) => {
      const item = items.find((i) => i.key === r.key);
      return {
        key: r.key,
        label: item?.label ?? r.key,
        result: r.result,
        note: r.note ?? null,
        merchantVisible: item?.merchantVisible ?? false,
      };
    }),
    note: row.note,
    evidenceFileIds: row.evidenceFileIds,
    checkedBy: await staffBrief(tx, row.checkedByStaffId),
    notifiedAt: iso(row.notifiedAt),
    remindCount: row.remindCount,
    lastRemindedAt: iso(reminder?.createdAt ?? null),
    isRemindedToday: reminded,
    followUpDueAt: iso(timer?.fireAt ?? null),
    history: await Promise.all(
      history.map(async (h) => ({
        patrolTaskId: h.id,
        weekStartDate: dateOf(h.patrolBatch.weekStartDate),
        status: h.status,
        checkedAt: iso(h.checkedAt),
        abnormalKind: await dictRef(tx, "patrol_issue", h.abnormalKindCode),
      })),
    ),
    actions: !allowed
      ? []
      : row.status === "pending"
        ? ["mark-normal", "mark-abnormal"]
        : row.status === "abnormal"
          ? ["recover", ...(!reminded ? ["remind"] : [])]
          : [],
  };
}
export async function listPatrols(
  tx: Tx,
  deps: PatrolDeps,
  staff: StaffContext,
  query: PatrolPage,
) {
  const rows = await tx.patrolTask.findMany({
    where: patrolWhere(staff, query, deps.clock.now()),
    include: patrolInclude,
  });
  const rank = ["abnormal", "pending", "recovered", "normal"];
  const filtered = rows.filter(
    (r) =>
      !query.tab ||
      query.tab === "all" ||
      (query.tab === "normal"
        ? ["normal", "recovered"].includes(r.status)
        : r.status === query.tab),
  );
  filtered.sort(
    (a, b) =>
      rank.indexOf(a.status) - rank.indexOf(b.status) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  return {
    items: await Promise.all(
      filtered
        .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
        .map((r) => patrolRow(tx, r)),
    ),
    total: filtered.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}
export async function patrolSummary(
  tx: Tx,
  deps: PatrolDeps,
  staff: StaffContext,
  query: PatrolFilter,
) {
  const week = weekOf(deps.clock.now(), query.weekStartDate),
    batch = await tx.patrolBatch.findUnique({ where: { weekStartDate: new Date(week) } });
  const rows = await tx.patrolTask.findMany({
    where: patrolWhere(staff, query, deps.clock.now()),
    select: { status: true },
  });
  const count = (statuses: string[]) => rows.filter((r) => statuses.includes(r.status)).length;
  return {
    weekStartDate: week,
    weekEndDate: addDays(week, 6),
    batch: batch
      ? {
          patrolBatchId: batch.id,
          liveTotal: batch.liveTotal,
          sampledCount: batch.sampledCount,
          generatedAt: iso(batch.generatedAt),
        }
      : null,
    all: rows.length,
    pending: count(["pending"]),
    abnormal: count(["abnormal"]),
    normal: count(["normal", "recovered"]),
    checked: count(["normal", "abnormal", "recovered"]),
  };
}
