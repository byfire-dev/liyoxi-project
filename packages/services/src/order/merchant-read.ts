import {
  DramaSnapshotSchema,
  OrderCardSchema,
  OrderItemRowSchema,
  OrderItemDetailSchema,
} from "@liyoxi/contract";
import type {
  MerchantOrderListQuery,
  MerchantOrderItemQuery,
  OrderCard,
  OrderItemRow,
} from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { calendarDate, diffDays } from "@liyoxi/shared/time";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { OrderActor, OrderDeps } from "./context.js";
import { dictRefs } from "./quote.js";
import { ITEM_GROUPS, countOrderItemsByPhase } from "./counts.js";
import { cursorScope, decodeCursor, encodeCursor } from "./cursor.js";
const iso = (d: Date | null) => d?.toISOString() ?? null;
const date = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
export const orderTab = (status: string) =>
  status === "pending_start" || status === "producing"
    ? "producing"
    : status === "cancelled" || status === "refunded"
      ? "after_sale"
      : status;
export const orderTabStatuses = (tab: string) =>
  tab === "all"
    ? undefined
    : tab === "producing"
      ? ["pending_start", "producing"]
      : tab === "after_sale"
        ? ["after_sale", "cancelled", "refunded"]
        : [tab];
export async function requireOrder(tx: Tx, actor: OrderActor, id: string) {
  const row = await tx.dramaOrder.findFirst({
    where: { id, storeId: actor.membership.storeId, entityId: actor.membership.entityId },
    select: { id: true },
  });
  if (!row) throw new AppError("NOT_FOUND");
}
export async function listOrders(tx: Tx, actor: OrderActor, query: MerchantOrderListQuery) {
  const { storeId, entityId } = actor.membership,
    scope = cursorScope({ storeId, entityId, tab: query.tab, no: query.no }),
    cursor = decodeCursor(query.cursor, scope),
    statuses = orderTabStatuses(query.tab),
    where: Prisma.DramaOrderWhereInput = {
      storeId,
      entityId,
      ...(statuses ? { status: { in: statuses } } : {}),
      ...(query.no ? { orderNo: query.no } : {}),
      ...(cursor?.at
        ? {
            OR: [
              { submittedAt: { lt: new Date(cursor.at) } },
              { submittedAt: new Date(cursor.at), id: { gt: cursor.id } },
            ],
          }
        : {}),
    };
  const rows = await tx.dramaOrder.findMany({
    where,
    orderBy: [{ submittedAt: "desc" }, { id: "asc" }],
    take: query.limit + 1,
    include: { orderItems: { orderBy: { itemNo: "asc" }, include: { orderItemAccounts: true } } },
  });
  const hasMore = rows.length > query.limit,
    page = rows.slice(0, query.limit),
    items: OrderCard[] = [];
  for (const o of page) {
    const live = o.orderItems.filter((i) => i.phase === "live");
    items.push(
      OrderCardSchema.parse({
        orderId: o.id,
        orderNo: o.orderNo,
        submittedAt: iso(o.submittedAt),
        status: o.status,
        subStatus: o.subStatus,
        tab: orderTab(o.status),
        itemCount: o.itemCount,
        firstDramaTitle: DramaSnapshotSchema.parse(o.orderItems[0]!.dramaSnapshot).title,
        platforms: [
          ...new Set(o.orderItems.flatMap((i) => i.orderItemAccounts.map((a) => a.platform))),
        ],
        totalChargePoints: o.totalChargePoints,
        pinnedTodo: null,
        liveSummary: live.length
          ? {
              liveItemCount: live.length,
              liveEpisodeCount: live.reduce((n, i) => n + i.liveEpisodeCount, 0),
              earliestUsageEndDate: live.map((i) => date(i.usageEndDate)!).sort()[0],
              firstLiveOrderItemId: live[0]!.id,
            }
          : null,
        returnedPoints: o.orderItems.reduce((n, i) => n + i.returnedPoints + i.convertedPoints, 0),
        actions: [],
      }),
    );
  }
  const last = page.at(-1);
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({ group: 0, at: iso(last.submittedAt), id: last.id }, scope)
        : null,
  };
}
const itemInclude = {
  dramaOrder: true,
  orderItemAccounts: {
    orderBy: [{ platform: "asc" }, { channelAccountId: "asc" }],
    include: { channelAccount: true },
  },
} satisfies Prisma.OrderItemInclude;
type Item = Prisma.OrderItemGetPayload<{ include: typeof itemInclude }>;
async function itemHeader(tx: Tx, i: Item, at: Date) {
  const snapshot = DramaSnapshotSchema.parse(i.dramaSnapshot);
  return {
    orderItemId: i.id,
    orderId: i.dramaOrderId,
    orderNo: i.dramaOrder.orderNo,
    dramaId: i.dramaId,
    dramaTitle: snapshot.title,
    posterUrl: null,
    genres: await dictRefs(tx, "genre", snapshot.genreCodes),
    episodeCount: i.episodeCount,
    phase: i.phase,
    ticketStep: null,
    accounts: i.orderItemAccounts.map((a) => ({
      channelAccountId: a.channelAccountId,
      platform: a.platform,
      accountName: a.channelAccount.accountName,
    })),
    agreedLaunchDate: date(i.agreedLaunchDate),
    usageStartDate: date(i.usageStartDate),
    usageEndDate: date(i.usageEndDate),
    remainingDays:
      i.phase === "live" ? Math.max(0, diffDays(date(i.usageEndDate)!, calendarDate(at))) : null,
    liveEpisodeCount: i.liveEpisodeCount,
  };
}
export async function itemDetail(tx: Tx, actor: OrderActor, id: string, at: Date) {
  const row = await tx.orderItem.findFirst({
    where: { id, storeId: actor.membership.storeId, entityId: actor.membership.entityId },
    include: itemInclude,
  });
  if (!row) throw new AppError("NOT_FOUND");
  return OrderItemDetailSchema.parse({
    ...(await itemHeader(tx, row, at)),
    phaseChangedAt: iso(row.phaseChangedAt),
    usageEndSource: row.usageEndSource,
    accounts: row.orderItemAccounts.map((a) => ({
      channelAccountId: a.channelAccountId,
      platform: a.platform,
      accountName: a.channelAccount.accountName,
      accountUid: a.channelAccount.accountUid,
      accountType: a.channelAccount.accountType,
    })),
  });
}
export async function itemSummary(tx: Tx, actor: OrderActor, orderId?: string) {
  if (orderId) await requireOrder(tx, actor, orderId);
  return countOrderItemsByPhase(tx, actor.membership.storeId, orderId);
}
export async function listItems(
  tx: Tx,
  actor: OrderActor,
  query: MerchantOrderItemQuery,
  at: Date,
) {
  if (query.orderId) await requireOrder(tx, actor, query.orderId);
  const { storeId, entityId } = actor.membership,
    scope = cursorScope({ storeId, entityId, tab: query.tab, orderId: query.orderId }),
    cursor = decodeCursor(query.cursor, scope),
    rows: Item[] = [],
    groups =
      query.tab === "all"
        ? [0, 1, 2]
        : [query.tab === "live" ? 0 : query.tab === "to_launch" ? 1 : 2];
  for (const group of groups) {
    if (cursor && group < cursor.group) continue;
    let after: Prisma.OrderItemWhereInput = {};
    if (cursor && group === cursor.group) {
      const cdate = cursor.at ? new Date(cursor.at) : null;
      after =
        group === 0 && cdate
          ? {
              OR: [{ usageEndDate: { gt: cdate } }, { usageEndDate: cdate, id: { gt: cursor.id } }],
            }
          : group === 1
            ? cdate
              ? {
                  OR: [
                    { agreedLaunchDate: { gt: cdate } },
                    { agreedLaunchDate: null },
                    { agreedLaunchDate: cdate, id: { gt: cursor.id } },
                  ],
                }
              : { agreedLaunchDate: null, id: { gt: cursor.id } }
            : group === 2 && cdate
              ? {
                  OR: [
                    { dramaOrder: { submittedAt: { lt: cdate } } },
                    { dramaOrder: { submittedAt: cdate }, id: { gt: cursor.id } },
                  ],
                }
              : {};
    }
    rows.push(
      ...(await tx.orderItem.findMany({
        where: {
          AND: [
            {
              storeId,
              entityId,
              phase: { in: [...ITEM_GROUPS[group as 0 | 1 | 2]] },
              ...(query.orderId ? { dramaOrderId: query.orderId } : {}),
            },
            after,
          ],
        },
        orderBy:
          group === 0
            ? [{ usageEndDate: "asc" }, { id: "asc" }]
            : group === 1
              ? [{ agreedLaunchDate: { sort: "asc", nulls: "last" } }, { id: "asc" }]
              : [{ dramaOrder: { submittedAt: "desc" } }, { id: "asc" }],
        take: query.limit + 1 - rows.length,
        include: itemInclude,
      })),
    );
    if (rows.length > query.limit) break;
  }
  const hasMore = rows.length > query.limit,
    page = rows.slice(0, query.limit),
    items: OrderItemRow[] = [];
  for (const row of page)
    items.push(OrderItemRowSchema.parse({ ...(await itemHeader(tx, row, at)), pendingTodo: null }));
  const last = page.at(-1),
    group = last ? ITEM_GROUPS.findIndex((g) => (g as readonly string[]).includes(last.phase)) : 0;
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor(
            {
              group,
              id: last.id,
              at: iso(
                group === 0
                  ? last.usageEndDate
                  : group === 1
                    ? last.agreedLaunchDate
                    : last.dramaOrder.submittedAt,
              ),
            },
            scope,
          )
        : null,
  };
}
export async function signItems<
  T extends { orderItemId: string; posterUrl: { url: string; expiresAt: string } | null },
>(deps: OrderDeps, items: T[]) {
  const files = await deps.tx.run((tx) =>
    tx.orderItem.findMany({
      where: { id: { in: items.map((i) => i.orderItemId) } },
      select: { id: true, dramaSnapshot: true },
    }),
  );
  for (const item of items) {
    const fileId = DramaSnapshotSchema.parse(
      files.find((i) => i.id === item.orderItemId)!.dramaSnapshot,
    ).posterFileId;
    if (fileId) item.posterUrl = await deps.media.signRead({ fileId });
  }
  return items;
}
