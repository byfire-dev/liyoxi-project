import {
  ApprovalSummarySchema,
  CancelRequestCardSchema,
  CancelRequestFiltersSchema,
  CancelRequestListQuerySchema,
  CancelRequestListSchema,
  CancelRequestSummarySchema,
  ReturnBreakdownSchema,
} from "@liyoxi/contract";
import type {
  AdminPage,
  CancelRequestCard,
  CancelRequestDetail,
  CancelRequestFilters,
  CancelRequestListQuery,
  CancelRequestSummary,
} from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { calendarDate, dayRange } from "@liyoxi/shared/time";
import { hasPermission, managedStore, satisfiesLevel, taskScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { CancelActor, CancelDeps } from "./cancel-context.js";
import { projectCancelRequestDetail } from "./cancel-execution-view.js";
import type { CancelReadRequest } from "./cancel-execution-view.js";

function readStaff(actor: CancelActor): StaffContext {
  if (
    !actor.staff ||
    actor.ctx.actor.type !== "staff" ||
    actor.ctx.actor.id !== actor.staff.staff.id
  )
    throw new AppError("PERMISSION_DENIED");
  if (
    !satisfiesLevel(actor.staff.moduleLevels.order, "view") &&
    !satisfiesLevel(actor.staff.moduleLevels.finance, "view")
  )
    throw new AppError("PERMISSION_DENIED");
  return actor.staff;
}
// Orders retain managed-store scope. Ads retain the owner's task predicate, including editors.
function domainScope(staff: StaffContext): Prisma.CancelRequestWhereInput {
  return {
    OR: [
      { kind: { in: ["order_cancel", "qualification_cancel"] }, store: managedStore(staff.scope) },
      {
        kind: "ad_cancel",
        ad: taskScope<Prisma.AdWhereInput>(staff.scope, {
          store: (store) => ({ store }),
          assignees: [{ col: "editorId", pool: "ad_editor" }],
        }),
      },
    ],
  };
}
function visibleScope(staff: StaffContext): Prisma.CancelRequestWhereInput {
  const mine = { approvalRequest: { requesterStaffId: staff.staff.id } };
  return { OR: [mine, domainScope(staff)] };
}
function normalized(query: CancelRequestFilters) {
  return {
    ...query,
    ...(query.kind === undefined ? {} : { kind: query.kind.join(",") }),
    ...(query.overdueOnly === undefined ? {} : { overdueOnly: String(query.overdueOnly) }),
  };
}
function filters(staff: StaffContext, query: CancelRequestFilters): Prisma.CancelRequestWhereInput {
  return {
    AND: [
      visibleScope(staff),
      {
        ...(query.kind === undefined ? {} : { kind: { in: query.kind } }),
        ...(query.reasonCode === undefined ? {} : { reasonCode: query.reasonCode }),
        ...(query.storeId === undefined ? {} : { storeId: query.storeId }),
        ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
        ...(query.requesterId === undefined
          ? {}
          : {
              approvalRequest: {
                requesterStaffId: query.requesterId === "me" ? staff.staff.id : query.requesterId,
              },
            }),
        ...(query.submittedFrom === undefined && query.submittedTo === undefined
          ? {}
          : {
              approvalRequest: {
                AND: [
                  ...(query.requesterId === undefined
                    ? []
                    : [
                        {
                          requesterStaffId:
                            query.requesterId === "me" ? staff.staff.id : query.requesterId,
                        },
                      ]),
                  {
                    submittedAt: {
                      ...(query.submittedFrom === undefined
                        ? {}
                        : { gte: dayRange(query.submittedFrom).start }),
                      ...(query.submittedTo === undefined
                        ? {}
                        : { lt: dayRange(query.submittedTo).end }),
                    },
                  },
                ],
              },
            }),
        ...(query.q === undefined
          ? {}
          : {
              OR: [
                { approvalRequest: { requestNo: { contains: query.q } } },
                { dramaOrder: { orderNo: { contains: query.q } } },
                { ad: { adNo: { contains: query.q } } },
                { store: { name: { contains: query.q } } },
                { entity: { name: { contains: query.q } } },
              ],
            }),
      },
    ],
  };
}
function checkRelations(r: CancelReadRequest) {
  const a = r.approvalRequest;
  const subject =
    r.kind === "order_cancel"
      ? ["drama_order", r.dramaOrderId]
      : r.kind === "ad_cancel"
        ? ["ad", r.adId]
        : ["store", r.storeId];
  const domain = ApprovalSummarySchema.parse(a.summarySnapshot).domain;
  if (
    !r.lineCount ||
    r.lineCount !== r.cancelRequestLines.length ||
    !["order_cancel", "ad_cancel", "qualification_cancel"].includes(r.kind) ||
    a.kind !== r.kind ||
    a.category !== "approval" ||
    a.roundNo !== 1 ||
    a.subjectType !== subject[0] ||
    a.subjectId !== subject[1] ||
    a.entityId !== r.entityId ||
    a.storeId !== r.storeId ||
    domain?.type !== "cancel_request" ||
    domain.id !== r.id ||
    (r.kind === "ad_cancel" && r.lineCount !== 1) ||
    r.cancelRequestLines.some(
      (l) =>
        l.entityId !== r.entityId ||
        l.storeId !== r.storeId ||
        (r.kind === "order_cancel" && l.targetType !== "order_item") ||
        (r.kind === "ad_cancel" && (l.targetType !== "ad" || l.targetId !== r.adId)),
    )
  )
    throw new AppError("PRECONDITION_CHANGED", { message: "取消申请、审批与明细关联不一致" });
}
async function actions(
  tx: Tx,
  staff: StaffContext,
  r: CancelReadRequest,
): Promise<CancelRequestDetail["actions"]> {
  const a = r.approvalRequest,
    mine = a.requesterStaffId === staff.staff.id;
  const scoped = !!(await tx.cancelRequest.findFirst({
    where: { AND: [{ id: r.id }, domainScope(staff)] },
    select: { id: true },
  }));
  const result: CancelRequestDetail["actions"] = [];
  const approve = scoped && hasPermission(staff, "finance.refund.approve");
  if (r.status === "pending_approval" && a.status === "pending") {
    if (approve && !mine && a.submitActorId !== staff.staff.id) result.push("approve", "reject");
    const requester = a.requesterStaffId
      ? await tx.staff.findUnique({ where: { id: a.requesterStaffId }, select: { status: true } })
      : null;
    const items = r.cancelRequestLines
      .filter((l) => l.targetType === "order_item")
      .map((l) => l.targetId);
    const ads = r.cancelRequestLines.filter((l) => l.targetType === "ad").map((l) => l.targetId);
    const invalid =
      (items.length > 0 &&
        !!(await tx.orderItem.findFirst({
          where: {
            id: { in: items },
            phase: { in: ["cancelled", "refunded", "terminated", "ended"] },
          },
          select: { id: true },
        }))) ||
      (ads.length > 0 &&
        !!(await tx.ad.findFirst({
          where: { id: { in: ads }, status: { in: ["confirmed", "cancelled"] } },
          select: { id: true },
        })));
    if (
      mine ||
      (approve && ((a.requesterStaffId !== null && requester?.status !== "active") || invalid))
    )
      result.push("withdraw");
  }
  if (r.status === "pending_execution" && a.status === "approved") {
    if (mine && hasPermission(staff, "order.refund.request")) result.push("void");
    if (scoped && hasPermission(staff, "finance.refund.execute")) result.push("execute");
  }
  return result;
}
const include = {
  cancelRequestLines: { orderBy: { id: "asc" } },
  approvalRequest: true,
} satisfies Prisma.CancelRequestInclude;
async function detail(tx: Tx, deps: CancelDeps, staff: StaffContext, r: CancelReadRequest) {
  checkRelations(r);
  return projectCancelRequestDetail(tx, deps, r, await actions(tx, staff, r));
}
export async function readCancelRequestDetail(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  id: string,
): Promise<CancelRequestDetail> {
  const staff = readStaff(actor);
  const row = await tx.cancelRequest.findFirst({
    where: { AND: [{ id }, visibleScope(staff)] },
    include,
  });
  if (!row) throw new AppError("NOT_FOUND");
  return detail(tx, deps, staff, row);
}
async function entries(tx: Tx, deps: CancelDeps, staff: StaffContext, query: CancelRequestFilters) {
  const rows = await tx.cancelRequest.findMany({ where: filters(staff, query), include });
  const now = deps.clock.now();
  const result = rows.map((row) => {
    checkRelations(row);
    const due =
      row.status === "pending_approval"
        ? row.approvalRequest.dueAt
        : row.status === "pending_execution"
          ? row.execDueAt
          : null;
    return { row, overdue: due !== null && due < now };
  });
  return query.overdueOnly ? result.filter(({ overdue }) => overdue) : result;
}
export async function listCancelRequests(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  input: CancelRequestListQuery,
): Promise<AdminPage<CancelRequestCard>> {
  const staff = readStaff(actor),
    query = CancelRequestListQuerySchema.parse(normalized(input));
  let rows = await entries(tx, deps, staff, query);
  if (query.tab !== "all")
    rows = rows.filter(({ row }) =>
      query.tab === "processed"
        ? ["done", "not_executed"].includes(row.status)
        : row.status === query.tab,
    );
  rows.sort((a, b) => {
    const time = (entry: typeof a) =>
      query.sort === "-submittedAt"
        ? -entry.row.approvalRequest.submittedAt.getTime()
        : query.sort === "execDueAt"
          ? (entry.row.execDueAt?.getTime() ?? Infinity)
          : ((entry.row.status === "pending_approval"
              ? entry.row.approvalRequest.dueAt
              : entry.row.status === "pending_execution"
                ? entry.row.execDueAt
                : null
            )?.getTime() ?? Infinity);
    if (query.sort === "urgency" && a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const delta = time(a) - time(b);
    return Number.isNaN(delta) || delta === 0 ? a.row.id.localeCompare(b.row.id) : delta;
  });
  return CancelRequestListSchema.parse({
    items: await Promise.all(
      rows
        .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
        .map(async ({ row }) => CancelRequestCardSchema.parse(await detail(tx, deps, staff, row))),
    ),
    page: query.page,
    pageSize: query.pageSize,
    total: rows.length,
  });
}
export async function summarizeCancelRequests(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  input: CancelRequestFilters,
): Promise<CancelRequestSummary> {
  const staff = readStaff(actor),
    query = CancelRequestFiltersSchema.parse(normalized(input));
  const rows = await entries(tx, deps, staff, query),
    month = calendarDate(deps.clock.now()).slice(0, 7);
  const done = rows.filter(
    ({ row }) =>
      row.status === "done" && row.executedAt && calendarDate(row.executedAt).slice(0, 7) === month,
  );
  const pending = (status: string) => rows.filter(({ row }) => row.status === status).length;
  return CancelRequestSummarySchema.parse({
    tabs: {
      pending_approval: pending("pending_approval"),
      pending_execution: pending("pending_execution"),
      processed: pending("done") + pending("not_executed"),
    },
    monthReturnedPoints: done.reduce(
      (sum, { row }) =>
        sum +
        row.cancelRequestLines.reduce((n, line) => {
          const result = ReturnBreakdownSchema.parse(line.resultSnapshot);
          if (
            !line.executedAt ||
            result.qty !== line.refundPoints ||
            result.backToOriginal !== line.returnedPoints ||
            result.convertedToAddon !== line.convertedPoints ||
            result.forfeited !== line.forfeitedPoints
          )
            throw new AppError("PRECONDITION_CHANGED", { message: "已执行取消缺少真实明细结果" });
          return n + result.backToOriginal + result.convertedToAddon;
        }, 0),
      0,
    ),
    monthDoneCount: done.length,
    inProgressCount: pending("pending_approval") + pending("pending_execution"),
    monthRejectedCount: rows.filter(
      ({ row }) =>
        row.closeReason === "rejected" &&
        row.closedAt &&
        calendarDate(row.closedAt).slice(0, 7) === month,
    ).length,
    overdueCount: rows.filter(({ overdue }) => overdue).length,
  });
}
