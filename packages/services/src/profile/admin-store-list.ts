import { StaffBriefSchema, StoreRowSchema } from "@liyoxi/contract";
import type { StoreListFilters, StoreListQuery } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { hasPermission, storeScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { adminStoreListBillingPort, adminStoreListOrderPort } from "./admin-list-ports.js";
import { currentReviewStaff } from "./admin-authorization.js";
import type { ProfileDeps } from "./context.js";

const selection = {
  id: true,
  entityId: true,
  name: true,
  isPrimary: true,
  lifecycle: true,
  qualificationStatus: true,
  deliveryManagerId: true,
  createdAt: true,
  entity: { select: { id: true, name: true, sourceType: true } },
  storeProfileStore: {
    select: {
      provinceCode: true,
      cityCode: true,
      districtCode: true,
      zoneCode: true,
      industryCode: true,
      categoryCode: true,
    },
  },
} as const;
/** list/summary实际共用；后继stores.list导出只消费此带范围查询，不另造筛选口径。 */
export async function readAdminStoreSelection(
  tx: Tx,
  deps: ProfileDeps,
  staff: StaffContext,
  q: StoreListFilters,
) {
  const now = deps.clock.now(),
    current = await currentReviewStaff(tx, staff, now);
  const region: Prisma.StoreProfileWhereInput = q.regionCode
    ? q.regionCode.startsWith("F")
      ? { zoneCode: q.regionCode }
      : {
          OR: [
            { provinceCode: q.regionCode },
            { cityCode: q.regionCode },
            { districtCode: q.regionCode },
          ],
        }
    : {};
  const profile: Prisma.StoreProfileWhereInput = {
    ...region,
    ...(q.industryCode ? { industryCode: q.industryCode } : {}),
    ...(q.categoryCode ? { categoryCode: q.categoryCode } : {}),
  };
  const where: Prisma.StoreWhereInput = {
    AND: [
      storeScope(current.scope),
      {
        lifecycle: q.lifecycle,
        ...(q.entityId ? { entityId: q.entityId } : {}),
        ...(q.qualificationStatus ? { qualificationStatus: { in: q.qualificationStatus } } : {}),
        ...(q.sourceType ? { entity: { sourceType: { in: q.sourceType } } } : {}),
        ...(q.deliveryManagerId
          ? { deliveryManagerId: q.deliveryManagerId }
          : q.isManagerUnassigned
            ? { deliveryManagerId: null }
            : {}),
        ...(Object.keys(profile).length ? { storeProfileStore: { is: profile } } : {}),
        ...(q.q
          ? {
              OR: [
                { name: { contains: q.q, mode: "insensitive" } },
                { entity: { name: { contains: q.q, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
    ],
  };
  const candidates = await tx.store.findMany({ where, select: selection });
  const billing = await deps.assembly.port(adminStoreListBillingPort)(tx, {
    entityIds: [...new Set(candidates.map((s) => s.entityId))],
    now,
  });
  const orders = await deps.assembly.port(adminStoreListOrderPort)(
    tx,
    candidates.map((s) => s.id),
  );
  for (const row of candidates)
    if (!billing.facts.has(row.entityId) || !orders.has(row.id))
      throw new AppError("INTERNAL", { message: "商家列表拥有者缺少候选事实" });
  const rows = candidates.filter((row) => {
    const b = billing.facts.get(row.entityId)!;
    return (
      (!q.subscriptionStatus || q.subscriptionStatus.includes(b.status)) &&
      (!q.planId || b.activePlanId === q.planId) &&
      (q.expiresWithinDays === undefined ||
        (b.status === "active" &&
          b.remainingDays !== null &&
          b.remainingDays >= 0 &&
          b.remainingDays <= q.expiresWithinDays))
    );
  });
  return { rows, billing, orders, current, now };
}
type Selection = Awaited<ReturnType<typeof readAdminStoreSelection>>;
type Row = Selection["rows"][number];

async function project(tx: Tx, selected: Selection, rows: readonly Row[]) {
  if (!rows.length) return [];
  const entityIds = [...new Set(rows.map((s) => s.entityId))];
  const managerIds = [
    ...new Set(rows.flatMap((s) => (s.deliveryManagerId ? [s.deliveryManagerId] : []))),
  ];
  const regionCodes = new Set<string>(),
    industryCodes = new Set<string>();
  for (const row of rows) {
    const p = row.storeProfileStore;
    for (const code of [p?.provinceCode, p?.cityCode, p?.districtCode, p?.zoneCode])
      if (code) regionCodes.add(code);
    for (const code of [p?.industryCode, p?.categoryCode]) if (code) industryCodes.add(code);
  }
  const [billing, siblings, managers, dicts] = await Promise.all([
    selected.billing.readRows(tx, entityIds),
    tx.store.findMany({
      where: { entityId: { in: entityIds } },
      select: { entityId: true, isPrimary: true, lifecycle: true, name: true },
    }),
    tx.staff.findMany({
      where: { id: { in: managerIds } },
      select: {
        id: true,
        staffNo: true,
        name: true,
        staffRoleKey: true,
        isLead: true,
        status: true,
      },
    }),
    tx.dictItem.findMany({
      where: {
        OR: [
          { dictTypeKey: "region", code: { in: [...regionCodes] } },
          { dictTypeKey: "industry", code: { in: [...industryCodes] } },
        ],
      },
      select: { dictTypeKey: true, code: true, name: true },
    }),
  ]);
  const managerBy = new Map(
    managers.map((s) => [
      s.id,
      StaffBriefSchema.parse({
        staffId: s.id,
        staffNo: s.staffNo,
        name: s.name,
        roleKey: s.staffRoleKey,
        isLead: s.isLead,
        status: s.status,
      }),
    ]),
  );
  const dictBy = new Map(dicts.map((d) => [`${d.dictTypeKey}:${d.code}`, d.name]));
  const dict = (type: string, code: string | null | undefined) =>
    code == null ? null : { code, name: dictBy.get(`${type}:${code}`) ?? code };
  const entityBy = new Map(
    entityIds.map((id) => [id, { activeStoreCount: 0, primaryStoreName: null as string | null }]),
  );
  for (const s of siblings) {
    const e = entityBy.get(s.entityId)!;
    if (s.lifecycle === "active") e.activeStoreCount++;
    if (s.isPrimary) e.primaryStoreName = s.name;
  }
  return rows.map((s) => {
    const bill = billing.get(s.entityId);
    if (!bill) throw new AppError("INTERNAL", { message: "商家列表缺少分页钱包事实" });
    const p = s.storeProfileStore;
    return StoreRowSchema.parse({
      storeId: s.id,
      name: s.name,
      isPrimary: s.isPrimary,
      lifecycle: s.lifecycle,
      entity: { entityId: s.entityId, name: s.entity.name, ...entityBy.get(s.entityId)! },
      region: {
        province: dict("region", p?.provinceCode),
        city: dict("region", p?.cityCode),
        district: dict("region", p?.districtCode),
        zone: dict("region", p?.zoneCode),
      },
      industry: dict("industry", p?.industryCode),
      category: dict("industry", p?.categoryCode),
      qualificationStatus: s.qualificationStatus,
      sourceType: s.entity.sourceType,
      deliveryManager: s.deliveryManagerId ? (managerBy.get(s.deliveryManagerId) ?? null) : null,
      subscription: bill.subscription,
      points: bill.points,
      totalPaidFen: s.isPrimary ? selected.billing.facts.get(s.entityId)!.totalPaidFen : null,
      lastOrderAt: selected.orders.get(s.id)?.toISOString() ?? null,
      registeredAt: s.createdAt.toISOString(),
      actions:
        s.deliveryManagerId === null
          ? hasPermission(selected.current, "merchant.manager.assign")
            ? ["assign-delivery-manager"]
            : []
          : hasPermission(selected.current, "merchant.manager.transfer")
            ? ["reassign-delivery-manager"]
            : [],
    });
  });
}
export async function adminStoreList(
  tx: Tx,
  deps: ProfileDeps,
  staff: StaffContext,
  q: StoreListQuery,
) {
  const selected = await readAdminStoreSelection(tx, deps, staff, q);
  const value = (s: Row) =>
    q.sort === "-lastOrderAt"
      ? (selected.orders.get(s.id)?.getTime() ?? null)
      : q.sort === "-totalPaidFen"
        ? s.isPrimary
          ? selected.billing.facts.get(s.entityId)!.totalPaidFen
          : null
        : s.createdAt.getTime();
  selected.rows.sort((a, b) => {
    const av = value(a),
      bv = value(b);
    if (av === null && bv !== null) return 1;
    if (av !== null && bv === null) return -1;
    return (
      (av !== null && bv !== null ? (av - bv) * (q.sort === "registeredAt" ? 1 : -1) : 0) ||
      a.id.localeCompare(b.id)
    );
  });
  const rows = selected.rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
  return {
    items: await project(tx, selected, rows),
    total: selected.rows.length,
    page: q.page,
    pageSize: q.pageSize,
  };
}
export async function adminStoreSummary(
  tx: Tx,
  deps: ProfileDeps,
  staff: StaffContext,
  q: StoreListFilters,
) {
  const selected = await readAdminStoreSelection(tx, deps, staff, q),
    month = calendarDate(selected.now).slice(0, 7);
  return {
    total: selected.rows.length,
    paidCount: selected.rows.filter((s) => selected.billing.facts.get(s.entityId)!.hasPaidOrder)
      .length,
    activePlanCount: selected.rows.filter(
      (s) => selected.billing.facts.get(s.entityId)!.status === "active",
    ).length,
    pendingReviewCount: selected.rows.filter((s) => s.qualificationStatus === "pending").length,
    newThisMonthCount: selected.rows.filter((s) => calendarDate(s.createdAt).startsWith(month))
      .length,
  };
}
