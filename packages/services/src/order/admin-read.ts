import {
  AdminOrderCardSchema,
  AdminOrderDetailSchema,
  AdminOrderSummarySchema,
} from "@liyoxi/contract";
import type { AdminOrderFilters, AdminOrderListQuery } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { quoteDramaItem } from "@liyoxi/shared/pricing";
import { dayRange } from "@liyoxi/shared/time";
import { managedStore } from "../authz/index.js";
import type { DataScope } from "../authz/index.js";
import { getWalletView } from "../billing/index.js";
import { paramsAt } from "../config/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { dictRefs } from "./quote.js";
import { detail } from "./read.js";
const iso = (d: Date | null) => d?.toISOString() ?? null;
const date = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
// 订单范围按其负责门店；不使用让剪辑师/发布专员因任务看到门店的宽 storeScope。
export async function adminOrderWhere(
  tx: Tx,
  scope: DataScope,
  query: AdminOrderFilters,
  at: Date,
): Promise<Prisma.DramaOrderWhereInput> {
  const filters: Prisma.DramaOrderWhereInput[] = [{ store: managedStore(scope) }];
  if (query.storeId) filters.push({ storeId: query.storeId });
  if (query.entityId) filters.push({ entityId: query.entityId });
  if (query.deliveryManagerId)
    filters.push({
      deliveryManagerId: query.deliveryManagerId === "none" ? null : query.deliveryManagerId,
    });
  if (query.dramaId) filters.push({ orderItems: { some: { dramaId: query.dramaId } } });
  if (query.q)
    filters.push({
      OR: [
        { orderNo: { startsWith: query.q } },
        { store: { name: { contains: query.q } } },
        { orderItems: { some: { dramaSnapshot: { path: ["title"], string_contains: query.q } } } },
      ],
    });
  if (query.submittedFrom || query.submittedTo)
    filters.push({
      submittedAt: {
        ...(query.submittedFrom ? { gte: dayRange(query.submittedFrom).start } : {}),
        ...(query.submittedTo ? { lt: dayRange(query.submittedTo).end } : {}),
      },
    });
  if (query.isRejectedStale) {
    const days = Number(
        (await paramsAt(tx, ["order.rejected_stale_days"], at))["order.rejected_stale_days"],
      ),
      latest = await tx.approvalRequest.groupBy({
        by: ["storeId"],
        where: { kind: "qualification", status: "rejected", storeId: { not: null } },
        _max: { decidedAt: true },
      }),
      cutoff = new Date(at.getTime() - days * 86400000),
      ids = latest
        .filter((r) => r._max.decidedAt && r._max.decidedAt < cutoff)
        .map((r) => r.storeId!);
    filters.push({
      status: "pending_start",
      subStatus: "qualification_rejected",
      storeId: { in: ids },
    });
  }
  return { AND: filters };
}
const include = {
  store: { include: { entity: true, storeProfileStore: true } },
  subscriptionTerm: { include: { plan: true } },
  deliveryManager: true,
  openCancelRequest: { include: { approvalRequest: true } },
  orderItems: { orderBy: { itemNo: "asc" }, include: { orderItemAccounts: true } },
} satisfies Prisma.DramaOrderInclude;
type Order = Prisma.DramaOrderGetPayload<{ include: typeof include }>;
async function card(tx: Tx, o: Order) {
  const s = o.store,
    p = s.storeProfileStore,
    manager = o.deliveryManager,
    first = o.orderItems[0]!,
    snapshot = first.dramaSnapshot as { title: string };
  return AdminOrderCardSchema.parse({
    orderId: o.id,
    orderNo: o.orderNo,
    submittedAt: iso(o.submittedAt),
    store: {
      storeId: s.id,
      storeName: s.name,
      entityId: s.entityId,
      entityName: s.entity.name,
      city: p?.cityCode ? (await dictRefs(tx, "region", [p.cityCode]))[0] : null,
      district: p?.districtCode ? (await dictRefs(tx, "region", [p.districtCode]))[0] : null,
      qualificationStatus: s.qualificationStatus,
    },
    planCode: o.planCode,
    planName: o.subscriptionTerm.plan.name,
    itemCount: o.itemCount,
    firstDramaTitle: snapshot.title,
    firstEpisodeCount: first.episodeCount,
    platforms: [
      ...new Set(o.orderItems.flatMap((i) => i.orderItemAccounts.map((a) => a.platform))),
    ],
    productionModels: [...new Set(o.orderItems.map((i) => i.productionModel))],
    discountBp: o.discountBp,
    isTopModel: o.isTopModel,
    surchargeBp: o.surchargeBp,
    totalChargePoints: o.totalChargePoints,
    status: o.status,
    subStatus: o.subStatus,
    statusChangedAt: iso(o.statusChangedAt),
    deliveryManager: manager
      ? {
          staffId: manager.id,
          staffNo: manager.staffNo,
          name: manager.name,
          roleKey: manager.staffRoleKey,
          isLead: manager.isLead,
          status: manager.status,
        }
      : null,
    openCancelRequest: o.openCancelRequest
      ? {
          cancelRequestId: o.openCancelRequest.id,
          requestNo: o.openCancelRequest.approvalRequest.requestNo,
          status: o.openCancelRequest.status,
          totalRefundPoints: o.openCancelRequest.totalRefundPoints,
        }
      : null,
    actions: [],
  }); // cancel 依赖 M5；当前没有可执行的取消接口。
}
export async function adminList(tx: Tx, scope: DataScope, query: AdminOrderListQuery, at: Date) {
  const base = await adminOrderWhere(tx, scope, query, at),
    where: Prisma.DramaOrderWhereInput = {
      AND: [base, ...(query.tab === "all" ? [] : [{ status: query.tab }])],
    },
    total = await tx.dramaOrder.count({ where }),
    rows = await tx.dramaOrder.findMany({
      where,
      include,
      orderBy:
        query.sort === "submittedAt"
          ? [{ submittedAt: "asc" }, { id: "asc" }]
          : query.sort === "-statusChangedAt"
            ? [{ statusChangedAt: "desc" }, { id: "asc" }]
            : [{ submittedAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
  const items = [];
  for (const row of rows) items.push(await card(tx, row));
  return { items, page: query.page, pageSize: query.pageSize, total };
}
export async function adminSummary(tx: Tx, scope: DataScope, query: AdminOrderFilters, at: Date) {
  const rows = await tx.dramaOrder.groupBy({
      by: ["status"],
      where: await adminOrderWhere(tx, scope, query, at),
      _count: true,
    }),
    tabs = {
      all: 0,
      pending_start: 0,
      producing: 0,
      to_launch: 0,
      live: 0,
      ended: 0,
      cancelled: 0,
      after_sale: 0,
      refunded: 0,
    };
  for (const row of rows) {
    tabs.all += row._count;
    if (row.status in tabs) tabs[row.status as keyof typeof tabs] = row._count;
  }
  return AdminOrderSummarySchema.parse({ tabs });
}
export async function adminDetail(tx: Tx, scope: DataScope, id: string, at: Date) {
  const o = await tx.dramaOrder.findFirst({ where: { id, store: managedStore(scope) }, include });
  if (!o) throw new AppError("NOT_FOUND");
  const common = await detail(tx, { membership: { storeId: o.storeId, entityId: o.entityId } }, id),
    wallet = await getWalletView(tx, o.entityId, at),
    itemRows = await tx.orderItem.findMany({
      where: { dramaOrderId: id },
      orderBy: { itemNo: "asc" },
      include: {
        pointHold: { include: { pointHoldAllocs: true } },
        orderItemAccounts: { include: { channelAccount: true } },
      },
    });
  const allocations = itemRows.flatMap((i) => i.pointHold.pointHoldAllocs),
    items = [];
  for (const row of itemRows) {
    const old = common.items.find((i) => i.orderItemId === row.id)!;
    items.push({
      ...old,
      capturedAt: iso(row.capturedAt),
      accounts: row.orderItemAccounts.map((a) => ({
        channelAccountId: a.channelAccountId,
        platform: a.platform,
        accountName: a.channelAccount.accountName,
        accountUid: a.channelAccount.accountUid,
        status: a.channelAccount.status,
      })),
      placements: [],
      ...old.returnPoints,
      ticket: null,
      pointHold: {
        pointHoldId: row.pointHoldId,
        status: row.pointHold.status,
        heldAt: iso(row.pointHold.heldAt),
        capturedAt: iso(row.pointHold.capturedAt),
      },
    });
  }
  const bases = itemRows.map(
    (i) =>
      quoteDramaItem({
        listPricePoints: i.listPricePoints,
        discountBp: i.discountBp,
        topModelSurchargeBp: 0,
        isTopModelIncluded: true,
        isTopModelSelected: false,
      }).chargePoints,
  );
  const consent = await tx.agreementConsent.findUniqueOrThrow({
    where: { id: o.agreementConsentId },
  });
  return AdminOrderDetailSchema.parse({
    ...(await card(tx, o)),
    startedAt: iso(o.startedAt),
    closedAt: iso(o.closedAt),
    focus: common.focus,
    note: o.note,
    expectedLaunchDate: date(o.expectedLaunchDate),
    referenceFiles: [],
    subscriptionTerm: {
      subscriptionTermId: o.subscriptionTermId,
      startDate: date(o.subscriptionTerm.startDate),
      endDate: date(o.subscriptionTerm.endDate),
    },
    items,
    deliveryPlan: null,
    pointsBreakdown: {
      listPriceTotalPoints: itemRows.reduce((n, i) => n + i.listPricePoints, 0),
      discountDeltaPoints: itemRows.reduce((n, i, k) => n + bases[k]! - i.listPricePoints, 0),
      surchargeDeltaPoints: itemRows.reduce((n, i, k) => n + i.chargePoints - bases[k]!, 0),
      totalChargePoints: o.totalChargePoints,
      planPoints: allocations.filter((a) => a.lotKind === "plan").reduce((n, a) => n + a.qty, 0),
      addonPoints: allocations.filter((a) => a.lotKind === "addon").reduce((n, a) => n + a.qty, 0),
    },
    pointsEvents: common.pointsEvents,
    agreements: common.agreements.map((a) => ({
      agreementKey: a.agreementKey,
      title: a.name,
      versionLabel: a.versionLabel,
      consentedAt: a.consentedAt,
      method: consent.method,
    })),
    licenseLetterCount: 0,
    licenseLetters: [],
    merchant: {
      contactName: o.store.storeProfileStore?.contactName ?? null,
      contactPhoneMask: o.store.storeProfileStore?.contactPhoneMask ?? null,
      currentPlanName:
        wallet.subscription.status === "active" ? (wallet.subscription.plan?.name ?? null) : null,
      currentTermEndDate:
        wallet.subscription.status === "active" ? wallet.subscription.endDate : null,
      spendablePoints: wallet.points.spendablePoints,
      planAvailablePoints: wallet.points.planAvailablePoints,
      addonAvailablePoints: wallet.points.addonAvailablePoints,
      sourceType: o.store.entity.sourceType,
    },
    cancelRequests: [],
    lockVersion: o.lockVersion,
  });
}
