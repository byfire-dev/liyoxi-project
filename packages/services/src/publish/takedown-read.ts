import {
  ChecklistItemsSchema,
  TakedownTaskRowSchema,
  TakedownTaskDetailSchema,
  TakedownTaskCardSchema,
} from "@liyoxi/contract";
import type {
  AdminTakedownTaskListQuery,
  AdminTakedownTaskSummaryQuery,
  MerchantTakedownTaskListQuery,
  MerchantTakedownTaskSummaryQuery,
} from "@liyoxi/contract";
import { calendarDate, diffDays } from "@liyoxi/shared/time";
import type { StaffContext } from "../authz/index.js";
import type { Tx } from "../kernel/index.js";
import type { PublishViewer } from "./context.js";
import type { TakedownDeps } from "./takedown-context.js";
import { actorName, dateOf, iso, snapshotOf, staffBrief } from "./repo.js";
import { brief, storeBrief } from "./views.js";
import { invalid, owner } from "./validate.js";
import {
  allowedMethods,
  expectedChecklist,
  mayWrite,
  takedownAccess,
  takedownInclude,
  takedownOf,
  takedownWhere,
} from "./takedown-repo.js";
import type { TakedownRow } from "./takedown-repo.js";
import { takedownTimeline } from "./takedown-timeline.js";
const overdue = (row: TakedownRow, now: Date) =>
  row.status === "pending_merchant" && dateOf(row.dueDate)! < calendarDate(now);
function common(row: TakedownRow, now: Date) {
  return {
    takedownTaskId: row.id,
    status: row.status,
    triggerKind: row.triggerKind,
    basis: row.basis,
    orderNo: row.orderItem.dramaOrder.orderNo,
    orderItemId: row.orderItemId,
    dramaTitle: snapshotOf(row.orderItem.dramaSnapshot).title ?? "",
    episodeCount: row.orderItem.episodeCount,
    usageEndDate: dateOf(row.usageEndDate),
    dueDate: dateOf(row.dueDate),
    isOverdue: overdue(row, now),
    merchantMethod: row.merchantMethod,
    merchantConfirmedAt: iso(row.merchantConfirmedAt),
    checkedAt: iso(row.checkedAt),
    stillOnlineCount: row.stillOnlineCount,
    escalatedAt: iso(row.escalatedAt),
  };
}
async function breachToday(tx: Tx, row: TakedownRow, now: Date) {
  return (
    (await tx.manualReminderLog.count({
      where: {
        subjectType: "takedown_task",
        subjectId: row.id,
        scene: "breach",
        bizDate: new Date(calendarDate(now)),
      },
    })) > 0
  );
}
export async function takedownRow(tx: Tx, row: TakedownRow, staff: StaffContext, now: Date) {
  const isOverdue = overdue(row, now),
    write = mayWrite(staff, row);
  return TakedownTaskRowSchema.parse({
    ...common(row, now),
    store: await storeBrief(tx, row.storeId),
    account: brief(row.channelAccount),
    overdueDays: isOverdue ? diffDays(calendarDate(now), dateOf(row.dueDate)!) : null,
    checkDueAt: iso(row.checkDueAt),
    isCheckOverdue:
      row.status === "merchant_confirmed" && row.checkDueAt !== null && row.checkDueAt < now,
    breachNoticeCount: row.breachNoticeCount,
    checkMethod: row.checkMethod,
    publisher: await staffBrief(tx, row.deliveryTicket.publisherId),
    actions: [
      ...(write && ["pending_merchant", "merchant_confirmed"].includes(row.status)
        ? ["check"]
        : []),
      ...(write && row.status === "merchant_confirmed" ? ["mark-online"] : []),
      ...(write && isOverdue ? ["escalate"] : []),
      ...(mayWrite(staff, row, true) && isOverdue && !(await breachToday(tx, row, now))
        ? ["send-breach-notice"]
        : []),
    ],
  });
}
export async function takedownDetail(tx: Tx, deps: TakedownDeps, staff: StaffContext, id: string) {
  takedownAccess(staff);
  const row = await takedownOf(tx, id, staff),
    item = row.orderItem,
    ticket = row.deliveryTicket,
    now = deps.clock.now();
  const template =
    row.checklistCode && row.checklistVersionNo
      ? await tx.checklistTemplate.findUnique({
          where: { code_versionNo: { code: row.checklistCode, versionNo: row.checklistVersionNo } },
        })
      : null;
  const items = template ? ChecklistItemsSchema.parse(template.items) : [];
  const results = (row.results ?? []) as Array<{ key: string; result: string; note?: string }>;
  return TakedownTaskDetailSchema.parse({
    ...(await takedownRow(tx, row, staff, now)),
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
    launchTaskId: row.launchTaskId,
    merchantConfirmedByName: await actorName(
      tx,
      "merchant",
      row.merchantConfirmedByUserId,
      row.entityId,
    ),
    expectedChecklistCode: expectedChecklist(row),
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
    evidenceFileIds: row.evidenceFileIds,
    checkedBy: await staffBrief(tx, row.checkedByStaffId),
    isBreachNoticedToday: await breachToday(tx, row, now),
    timeline: await takedownTimeline(tx, row),
  });
}
export async function listTakedowns(
  tx: Tx,
  deps: TakedownDeps,
  staff: StaffContext,
  query: AdminTakedownTaskListQuery,
) {
  takedownAccess(staff);
  const now = deps.clock.now(),
    tab = query.tab ?? "pending";
  const rows = (
    await tx.takedownTask.findMany({
      where: takedownWhere(staff, query, now),
      include: takedownInclude,
    })
  ).filter(
    (row) =>
      (tab === "checked"
        ? row.status === "checked"
        : tab === "waiting"
          ? row.status === "pending_merchant" && !overdue(row, now)
          : row.status === "merchant_confirmed" || overdue(row, now)) &&
      (!query.status ||
        query.status.includes(row.status as "pending_merchant" | "merchant_confirmed" | "checked")),
  );
  rows.sort((a, b) => {
    if (tab === "checked")
      return (
        (b.checkedAt?.getTime() ?? 0) - (a.checkedAt?.getTime() ?? 0) || a.id.localeCompare(b.id)
      );
    if (tab === "pending" && a.status !== b.status) return a.status === "pending_merchant" ? -1 : 1;
    return (
      (a.status === "merchant_confirmed"
        ? (a.checkDueAt?.getTime() ?? 0) - (b.checkDueAt?.getTime() ?? 0)
        : a.dueDate.getTime() - b.dueDate.getTime()) || a.id.localeCompare(b.id)
    );
  });
  return {
    items: await Promise.all(
      rows
        .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
        .map((row) => takedownRow(tx, row, staff, now)),
    ),
    total: rows.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}
export async function takedownSummary(
  tx: Tx,
  deps: TakedownDeps,
  staff: StaffContext,
  query: AdminTakedownTaskSummaryQuery,
) {
  takedownAccess(staff);
  const now = deps.clock.now(),
    rows = await tx.takedownTask.findMany({
      where: takedownWhere(staff, query, now),
      include: takedownInclude,
    });
  return {
    pending: rows.filter((r) => r.status === "merchant_confirmed" || overdue(r, now)).length,
    waiting: rows.filter((r) => r.status === "pending_merchant" && !overdue(r, now)).length,
    checked: rows.filter((r) => r.status === "checked").length,
    overdue: rows.filter((r) => overdue(r, now)).length,
    dueToday: rows.filter(
      (r) =>
        r.status === "merchant_confirmed" &&
        r.checkDueAt &&
        calendarDate(r.checkDueAt) === calendarDate(now),
    ).length,
    checkOverdue: rows.filter(
      (r) => r.status === "merchant_confirmed" && r.checkDueAt && r.checkDueAt < now,
    ).length,
  };
}
export function takedownCard(row: TakedownRow, now: Date) {
  return TakedownTaskCardSchema.parse({
    ...common(row, now),
    orderId: row.orderItem.dramaOrderId,
    posterUrl: null,
    channelAccount: brief(row.channelAccount),
    allowedMethods: [...allowedMethods(row)],
    actions: row.status === "pending_merchant" ? ["confirm"] : [],
  });
}
async function merchantRows(
  tx: Tx,
  viewer: PublishViewer,
  query: MerchantTakedownTaskSummaryQuery,
) {
  owner(viewer);
  return tx.takedownTask.findMany({
    where: {
      entityId: viewer.membership.entityId,
      storeId: viewer.membership.storeId,
      status: { not: "void" },
      ...(query.orderId ? { orderItem: { dramaOrderId: query.orderId } } : {}),
    },
    include: takedownInclude,
  });
}
export async function merchantTakedownList(
  tx: Tx,
  deps: TakedownDeps,
  viewer: PublishViewer,
  query: MerchantTakedownTaskListQuery,
) {
  const tab = query.tab ?? "pending",
    desc = tab === "done";
  const rows = (await merchantRows(tx, viewer, query)).filter((r) =>
    tab === "pending"
      ? r.status === "pending_merchant"
      : ["merchant_confirmed", "checked"].includes(r.status),
  );
  const key = (r: TakedownRow) =>
    `${desc ? (r.merchantConfirmedAt ?? r.checkedAt)!.toISOString() : dateOf(r.dueDate)}:${r.id}`;
  rows.sort((a, b) => (desc ? -1 : 1) * key(a).localeCompare(key(b)));
  const fingerprint = JSON.stringify({
    storeId: viewer.membership.storeId,
    entityId: viewer.membership.entityId,
    tab,
    orderId: query.orderId ?? null,
  });
  let after: string | null = null;
  if (query.cursor)
    try {
      const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as {
        v: number;
        filter: string;
        key: string;
      };
      if (cursor.v !== 1 || cursor.filter !== fingerprint || typeof cursor.key !== "string")
        throw new Error();
      after = cursor.key;
    } catch {
      throw invalid("cursor", "游标不属于当前筛选");
    }
  const available =
    after === null ? rows : rows.filter((r) => (desc ? key(r) < after! : key(r) > after!));
  const selected = available.slice(0, query.limit),
    hasMore = available.length > selected.length;
  return {
    items: selected.map((r) => ({
      card: takedownCard(r, deps.clock.now()),
      posterFileId: snapshotOf(r.orderItem.dramaSnapshot).posterFileId ?? null,
    })),
    hasMore,
    nextCursor: hasMore
      ? Buffer.from(
          JSON.stringify({ v: 1, filter: fingerprint, key: key(selected.at(-1)!) }),
        ).toString("base64url")
      : null,
  };
}
export async function merchantTakedownSummary(
  tx: Tx,
  deps: TakedownDeps,
  viewer: PublishViewer,
  query: MerchantTakedownTaskSummaryQuery,
) {
  const now = deps.clock.now(),
    rows = await merchantRows(tx, viewer, query),
    pending = rows.filter((r) => r.status === "pending_merchant").length;
  const next = pending
    ? null
    : await tx.orderItem.findFirst({
        where: {
          entityId: viewer.membership.entityId,
          storeId: viewer.membership.storeId,
          ...(query.orderId ? { dramaOrderId: query.orderId } : {}),
          deliveryTicket: {
            step: { notIn: ["terminated", "archived"] },
            deliveredAt: { not: null },
          },
          takedownTasks: { none: { status: { not: "void" } } },
        },
        orderBy: [{ usageEndDate: "asc" }, { id: "asc" }],
      });
  const timer = next
    ? await tx.timer.findFirst({
        where: {
          kind: "takedown.create",
          subjectType: "order_item",
          subjectId: next.id,
          status: "scheduled",
        },
        orderBy: { fireAt: "asc" },
      })
    : null;
  return {
    pending,
    done: rows.filter((r) => ["merchant_confirmed", "checked"].includes(r.status)).length,
    overdue: rows.filter((r) => overdue(r, now)).length,
    nextTakedown:
      next && timer
        ? {
            orderItemId: next.id,
            dramaTitle: snapshotOf(next.dramaSnapshot).title ?? "",
            usageEndDate: dateOf(next.usageEndDate)!,
            createDate: calendarDate(timer.fireAt),
          }
        : null,
  };
}
