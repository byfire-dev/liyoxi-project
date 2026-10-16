import { createHash } from "node:crypto";
import {
  IdSchema,
  PaymentOrderCardSchema,
  PaymentOrderAdminRowSchema,
  PaymentTransactionRowSchema,
  PaymentTransactionSummarySchema,
  billingOrderContentSchema,
} from "@liyoxi/contract";
import type {
  PaymentOrderListQuery,
  PaymentOrderSummaryQuery,
  AdminPaymentOrderListQuery,
  AdminPaymentOrderSummaryQuery,
  PaymentTransactionListQuery,
  PaymentTransactionSummaryQuery,
} from "@liyoxi/contract";
import { Prisma } from "@liyoxi/db";
import type { BillingOrder } from "@liyoxi/db";
import { addDays, calendarDate, startOfDay } from "@liyoxi/shared/time";
import { byEntity, hasPermission, satisfiesLevel } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { paymentOrderTitle } from "./describe.js";
import { staffBrief } from "./purchase-read.js";
import type { BillingPurchaseDeps, PurchaseActor } from "./purchase-context.js";

const activeInvoice = ["pending", "issued", "red_pending"];
const orderInclude = {
  entity: {
    include: {
      stores: {
        select: { id: true, name: true, isPrimary: true, lifecycle: true, deliveryManagerId: true },
      },
    },
  },
  store: { select: { id: true, name: true } },
  invoiceRequests: {
    where: { status: { in: activeInvoice } },
    select: { id: true, requestNo: true, status: true },
  },
  paidPaymentTxn: {
    select: {
      refundRequests: {
        where: { closedAt: null, ruleCode: { not: "unapplied_receipt" } },
        select: { id: true },
      },
    },
  },
  transferProofs: { where: { reviewStatus: "pending" }, select: { id: true, checkResult: true } },
} satisfies Prisma.BillingOrderInclude;
type Order = Prisma.BillingOrderGetPayload<{ include: typeof orderInclude }>;
async function entityView(tx: Tx, e: Order["entity"]) {
  const primary = e.stores.find((store) => store.isPrimary);
  return {
    entityId: e.id,
    name: e.name ?? "",
    primaryStoreId: primary?.id ?? null,
    primaryStoreName: primary?.name ?? null,
    storeCount: e.stores.filter((store) => store.lifecycle === "active").length,
    verificationStatus: e.verificationStatus,
    managerStaff: await staffBrief(tx, primary?.deliveryManagerId ?? null),
  };
}
function requireModule(staff: StaffContext, module: "order" | "finance") {
  if (!satisfiesLevel(staff.moduleLevels[module], "view")) throw new AppError("PERMISSION_DENIED");
}
async function owner(tx: Tx, deps: BillingPurchaseDeps, actor: PurchaseActor) {
  if (
    actor.ctx.actor.type !== "merchant" ||
    !actor.ctx.actor.id ||
    actor.ctx.actor.role !== "owner" ||
    actor.membership.role !== "owner" ||
    actor.ctx.entityId !== actor.membership.entityId
  )
    throw new AppError("ROLE_FORBIDDEN");
  const current = await deps.tenant.resolveMembership(tx, {
    merchantUserId: actor.ctx.actor.id,
    storeId: actor.membership.storeId,
  });
  if (current?.role !== "owner" || current.entityId !== actor.membership.entityId)
    throw new AppError("NOT_FOUND");
}
function dateRange(from?: string, to?: string) {
  return {
    ...(from ? { gte: startOfDay(from) } : {}),
    ...(to ? { lt: startOfDay(addDays(to, 1)) } : {}),
  };
}
async function title(tx: Tx, order: BillingOrder) {
  const content = billingOrderContentSchema.parse(order.contentSnapshot);
  if (content.kind === "topup") return paymentOrderTitle(order.type, content);
  const plan =
    content.kind === "plan"
      ? await tx.plan.findUniqueOrThrow({ where: { id: content.planId }, select: { name: true } })
      : (
          await tx.planRevision.findUniqueOrThrow({
            where: { id: content.toPlanRevisionId },
            select: { plan: { select: { name: true } } },
          })
        ).plan;
  return paymentOrderTitle(order.type, content, plan.name);
}
function invoiceWhere(state: string, cutoff: Date | null): Prisma.BillingOrderWhereInput {
  const noActive = { invoiceRequests: { none: { status: { in: activeInvoice } } } };
  const eligible: Prisma.BillingOrderWhereInput = {
    status: "paid",
    fulfillmentStatus: "done",
    refundedAmountFen: 0,
    paidPaymentTxn: {
      is: { refundRequests: { none: { closedAt: null, ruleCode: { not: "unapplied_receipt" } } } },
    },
  };
  if (state === "applying") return { invoiceRequests: { some: { status: "pending" } } };
  if (state === "invoiced")
    return { invoiceRequests: { some: { status: { in: ["issued", "red_pending"] } } } };
  if (state === "not_eligible") return { AND: [noActive, { NOT: eligible }] };
  if (state === "expired")
    return cutoff ? { AND: [noActive, eligible, { paidAt: { lt: cutoff } }] } : { id: { in: [] } };
  return { AND: [noActive, eligible, ...(cutoff ? [{ paidAt: { gte: cutoff } }] : [])] };
}
function merchantWhere(
  entityId: string,
  query: PaymentOrderSummaryQuery,
  cutoff: Date | null,
): Prisma.BillingOrderWhereInput {
  return {
    entityId,
    ...(query.status ? { status: { in: query.status.split(",") } } : {}),
    ...(query.type ? { type: { in: query.type.split(",") } } : {}),
    ...(query.no ? { orderNo: query.no } : {}),
    ...(query.invoiceState
      ? { OR: query.invoiceState.split(",").map((state) => invoiceWhere(state, cutoff)) }
      : {}),
  };
}
function invoiceState(order: Order, cutoff: Date | null) {
  const request = order.invoiceRequests[0];
  if (request) return request.status === "pending" ? "applying" : "invoiced";
  if (
    order.status !== "paid" ||
    order.fulfillmentStatus !== "done" ||
    order.refundedAmountFen > 0 ||
    !order.paidPaymentTxn ||
    order.paidPaymentTxn.refundRequests.length > 0
  )
    return "not_eligible";
  return cutoff && order.paidAt && order.paidAt < cutoff ? "expired" : "eligible";
}
async function merchantCard(tx: Tx, order: Order, cutoff: Date | null, now: Date) {
  const state = invoiceState(order, cutoff),
    request = order.invoiceRequests[0];
  // 项目名参数由发票域补登；未配置时保持 null，不猜一个默认项目。
  const item =
    order.status === "paid"
      ? await tx.paramValue.findFirst({
          where: {
            key: `invoice.item_name.${order.type}`,
            cancelledAt: null,
            effectiveAt: { lte: now },
          },
          orderBy: { effectiveAt: "desc" },
          select: { value: true },
        })
      : null;
  return PaymentOrderCardSchema.parse({
    paymentOrderId: order.id,
    orderNo: order.orderNo,
    type: order.type,
    status: order.status,
    channel: order.channel,
    transferState: order.transferState,
    amountFen: order.amountFen,
    title: await title(tx, order),
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    invoiceItemName: typeof item?.value === "string" ? item.value : null,
    invoiceState: state,
    activeInvoiceRequest: request
      ? { invoiceRequestId: request.id, requestNo: request.requestNo, status: request.status }
      : null,
    actions: [
      ...(order.channel === "wechat_jsapi" && order.status === "pending_payment"
        ? ["sync", "cancel"]
        : []),
      ...(order.channel === "wechat_jsapi" &&
      order.status === "pending_payment" &&
      now.getTime() < order.expiresAt.getTime() - 60_000
        ? ["wechat-prepay"]
        : []),
      ...(order.channel === "bank_transfer" &&
      ((order.status === "pending_payment" && now < order.expiresAt) ||
        (order.status === "pending_confirmation" && order.transferState === "proof_submitted"))
        ? [...(order.status === "pending_payment" ? ["cancel"] : []), "submit-proof"]
        : []),
      ...(state === "eligible" && order.entity.verificationStatus === "verified"
        ? ["submit-invoice"]
        : []),
    ],
  });
}
function adminWhere(
  staff: StaffContext,
  query: AdminPaymentOrderSummaryQuery,
): Prisma.BillingOrderWhereInput {
  return {
    AND: [
      byEntity(staff.scope),
      {
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.storeId ? { storeId: query.storeId } : {}),
        ...(query.no ? { orderNo: query.no } : {}),
        ...(query.type ? { type: { in: query.type.split(",") } } : {}),
        ...(query.channel ? { channel: query.channel } : {}),
        ...(query.source ? { source: query.source } : {}),
        ...(query.hasOpenException === undefined
          ? {}
          : { hasOpenException: query.hasOpenException }),
        createdAt: dateRange(query.createdFrom, query.createdTo),
        ...(query.q
          ? {
              OR: [
                { orderNo: { contains: query.q, mode: "insensitive" } },
                { entity: { name: { contains: query.q, mode: "insensitive" } } },
                {
                  entity: {
                    stores: { some: { name: { contains: query.q, mode: "insensitive" } } },
                  },
                },
              ],
            }
          : {}),
      },
    ],
  };
}
async function adminRow(tx: Tx, order: Order, staff: StaffContext, now: Date) {
  const proof = order.transferProofs[0],
    confirm = hasPermission(staff, "finance.receipt.confirm");
  const checks = proof?.checkResult;
  const missingRemark =
    typeof checks === "object" &&
    checks !== null &&
    !Array.isArray(checks) &&
    Array.isArray(checks.items) &&
    checks.items.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        item.key === "remark_order_no" &&
        (item.result === "fail" || item.result === "warn"),
    );
  return PaymentOrderAdminRowSchema.parse({
    paymentOrderId: order.id,
    orderNo: order.orderNo,
    createdAt: order.createdAt.toISOString(),
    entity: await entityView(tx, order.entity),
    store: order.store ? { storeId: order.store.id, name: order.store.name } : null,
    type: order.type,
    title: await title(tx, order),
    contentNote: order.fulfillmentNote,
    amountFen: order.amountFen,
    paidAmountFen: order.paidAmountFen,
    refundedAmountFen: order.refundedAmountFen,
    channel: order.channel,
    status: order.status,
    transferState: order.transferState,
    fulfillmentStatus: order.fulfillmentStatus,
    hasOpenException: order.hasOpenException,
    source: order.source,
    pendingTransferProofId: proof?.id ?? null,
    statusNote:
      order.fulfillmentStatus === "blocked"
        ? "履约受阻"
        : order.hasOpenException
          ? "对账差异待处理"
          : order.transferState === "proof_rejected"
            ? "凭证被驳回"
            : order.status === "pending_confirmation"
              ? missingRemark
                ? "附言缺付款单号"
                : "待财务确认"
              : order.cancelReason === "timeout"
                ? "超时未支付，系统自动取消"
                : null,
    actions:
      confirm && order.channel === "bank_transfer"
        ? [
            ...(proof &&
            order.status === "pending_confirmation" &&
            order.transferState === "proof_submitted"
              ? ["confirm"]
              : []),
            ...((order.status === "pending_payment" && now < order.expiresAt) ||
            (order.status === "pending_confirmation" && order.transferState === "proof_submitted")
              ? ["submit-proof"]
              : []),
          ]
        : [],
  });
}
function transactionWhere(query: PaymentTransactionSummaryQuery) {
  const filters: Prisma.Sql[] = [Prisma.sql`t.status = 'succeeded'`];
  if (query.q) {
    const q = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
    filters.push(
      Prisma.sql`(o.order_no ILIKE ${q} OR t.channel_txn_no ILIKE ${q} OR t.bank_serial_raw ILIKE ${q} OR e.name ILIKE ${q} OR EXISTS (SELECT 1 FROM store s WHERE s.entity_id=t.entity_id AND s.name ILIKE ${q}))`,
    );
  }
  if (query.successFrom)
    filters.push(Prisma.sql`t.channel_success_at >= ${startOfDay(query.successFrom)}`);
  if (query.successTo)
    filters.push(Prisma.sql`t.channel_success_at < ${startOfDay(addDays(query.successTo, 1))}`);
  if (query.orderType) filters.push(Prisma.sql`o.type = ${query.orderType}`);
  if (query.channel) filters.push(Prisma.sql`t.channel = ${query.channel}`);
  if (query.reconState) filters.push(Prisma.sql`t.recon_state = ${query.reconState}`);
  if (query.isApplied !== undefined)
    filters.push(
      query.isApplied ? Prisma.sql`t.applied_at IS NOT NULL` : Prisma.sql`t.applied_at IS NULL`,
    );
  return Prisma.join(filters, " AND ");
}
async function receiptTotals(tx: Tx, from: Date, to: Date) {
  const [row] = await tx.$queryRaw<
    { amountFen: string; count: number; wechatCount: number; bankCount: number }[]
  >`
    SELECT COALESCE(SUM(channel_amount_fen),0)::text AS "amountFen", COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE channel='wechat_jsapi')::int AS "wechatCount", COUNT(*) FILTER (WHERE channel='bank_transfer')::int AS "bankCount"
    FROM payment_txn WHERE status='succeeded' AND channel_success_at>=${from} AND channel_success_at<${to}`;
  return row!;
}
export function createBillingChannelRead(deps: BillingPurchaseDeps) {
  const cutoffAt = async (now: Date) => {
    const days = await deps.config.params.getAt("invoice.apply_within_days", now);
    return days === null ? null : new Date(now.getTime() - days * 86_400_000);
  };
  return {
    listMerchantOrders: (actor: PurchaseActor, query: PaymentOrderListQuery) =>
      deps.tx.run(async (tx) => {
        await owner(tx, deps, actor);
        const cutoff = await cutoffAt(deps.clock.now()),
          where = merchantWhere(actor.membership.entityId, query, cutoff);
        const scope = createHash("sha256")
          .update(
            JSON.stringify([
              actor.membership.entityId,
              query.invoiceState,
              query.status,
              query.type,
              query.no,
            ]),
          )
          .digest("hex");
        let boundary: Prisma.BillingOrderWhereInput = {};
        try {
          const cursor: unknown = query.cursor
            ? JSON.parse(Buffer.from(query.cursor, "base64url").toString())
            : null;
          if (
            typeof cursor === "object" &&
            cursor !== null &&
            "scope" in cursor &&
            cursor.scope === scope &&
            "id" in cursor &&
            IdSchema.safeParse(cursor.id).success &&
            "at" in cursor &&
            typeof cursor.at === "string" &&
            Number.isFinite(Date.parse(cursor.at))
          ) {
            const at = new Date(cursor.at),
              id = String(cursor.id);
            boundary = { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] };
          }
        } catch {
          /* C42：损坏或不属于当前筛选的游标从首页开始。 */
        }
        const rows = await tx.billingOrder.findMany({
          where: { AND: [where, boundary] },
          include: orderInclude,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: query.limit + 1,
        });
        const hasMore = rows.length > query.limit,
          page = rows.slice(0, query.limit),
          last = page.at(-1);
        return {
          items: await Promise.all(
            page.map((row) => merchantCard(tx, row, cutoff, deps.clock.now())),
          ),
          hasMore,
          nextCursor:
            hasMore && last
              ? Buffer.from(
                  JSON.stringify({ scope, id: last.id, at: last.createdAt.toISOString() }),
                ).toString("base64url")
              : null,
        };
      }),
    merchantOrderSummary: (actor: PurchaseActor, query: PaymentOrderSummaryQuery) =>
      deps.tx.run(async (tx) => {
        await owner(tx, deps, actor);
        return {
          total: await tx.billingOrder.count({
            where: merchantWhere(
              actor.membership.entityId,
              query,
              await cutoffAt(deps.clock.now()),
            ),
          }),
        };
      }),
    listAdminOrders: (staff: StaffContext, query: AdminPaymentOrderListQuery) =>
      deps.tx.run(async (tx) => {
        requireModule(staff, "order");
        const where = {
          AND: [adminWhere(staff, query), ...(query.tab === "all" ? [] : [{ status: query.tab }])],
        };
        const rows = await tx.billingOrder.findMany({
          where,
          include: orderInclude,
          orderBy: [
            query.sort === "-amountFen" ? { amountFen: "desc" } : { createdAt: "desc" },
            { id: "desc" },
          ],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        });
        return {
          items: await Promise.all(rows.map((row) => adminRow(tx, row, staff, deps.clock.now()))),
          total: await tx.billingOrder.count({ where }),
          page: query.page,
          pageSize: query.pageSize,
        };
      }),
    adminOrderSummary: (staff: StaffContext, query: AdminPaymentOrderSummaryQuery) =>
      deps.tx.run(async (tx) => {
        requireModule(staff, "order");
        const rows = await tx.billingOrder.groupBy({
          by: ["status"],
          where: adminWhere(staff, query),
          _count: true,
        });
        const count = (status: string) => rows.find((row) => row.status === status)?._count ?? 0;
        return {
          all: rows.reduce((sum, row) => sum + row._count, 0),
          pending_payment: count("pending_payment"),
          pending_confirmation: count("pending_confirmation"),
          paid: count("paid"),
          cancelled: count("cancelled"),
          refunded: count("refunded"),
        };
      }),
    listPaymentTransactions: (staff: StaffContext, query: PaymentTransactionListQuery) =>
      deps.tx.run(async (tx) => {
        requireModule(staff, "finance");
        const where = transactionWhere(query),
          from = Prisma.sql`FROM payment_txn t LEFT JOIN billing_order o ON o.id=t.billing_order_id LEFT JOIN entity e ON e.id=t.entity_id WHERE ${where}`;
        const ids = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT t.id::text ${from} ORDER BY t.channel_success_at DESC,t.id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
        );
        const [total] = await tx.$queryRaw<{ count: number }[]>(
          Prisma.sql`SELECT COUNT(*)::int AS count ${from}`,
        );
        const rows = await tx.paymentTxn.findMany({
          where: { id: { in: ids.map((row) => row.id) } },
          include: {
            billingOrder: { select: { id: true, orderNo: true, type: true } },
            entity: orderInclude.entity,
          },
        });
        const items = await Promise.all(
          ids.map(async ({ id }) => {
            const row = rows.find((item) => item.id === id)!;
            return PaymentTransactionRowSchema.parse({
              paymentTransactionId: row.id,
              channelSuccessAt: row.channelSuccessAt?.toISOString(),
              channelTxnNo: row.channelTxnNo,
              channel: row.channel,
              paymentOrder: row.billingOrder
                ? {
                    paymentOrderId: row.billingOrder.id,
                    orderNo: row.billingOrder.orderNo,
                    type: row.billingOrder.type,
                  }
                : null,
              entity: row.entity ? await entityView(tx, row.entity) : null,
              channelAmountFen: row.channelAmountFen,
              feeFen: row.feeFen,
              refundedFen: row.refundedFen,
              isApplied: row.appliedAt !== null,
              reconState: row.reconState,
              payerName: row.channel === "bank_transfer" ? row.channelPayerRef : null,
            });
          }),
        );
        return { items, total: total!.count, page: query.page, pageSize: query.pageSize };
      }),
    paymentTransactionSummary: (staff: StaffContext, query: PaymentTransactionSummaryQuery) =>
      deps.tx.run(async (tx) => {
        requireModule(staff, "finance");
        const now = calendarDate(deps.clock.now()),
          month = `${now.slice(0, 7)}-01`,
          monthEnd = addDays(
            `${Number(month.slice(0, 4)) + (month.slice(5, 7) === "12" ? 1 : 0)}-${String((Number(month.slice(5, 7)) % 12) + 1).padStart(2, "0")}-01`,
            0,
          );
        const [filtered] = await tx.$queryRaw<{ count: number; channelAmountFen: string }[]>(
          Prisma.sql`SELECT COUNT(*)::int AS count, COALESCE(SUM(t.channel_amount_fen),0)::text AS "channelAmountFen" FROM payment_txn t LEFT JOIN billing_order o ON o.id=t.billing_order_id LEFT JOIN entity e ON e.id=t.entity_id WHERE ${transactionWhere(query)}`,
        );
        const [monthRefund] = await tx.$queryRaw<
          { count: number; amountFen: string }[]
        >`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_fen),0)::text AS "amountFen" FROM refund_txn WHERE status='succeeded' AND success_at>=${startOfDay(month)} AND success_at<${startOfDay(monthEnd)}`;
        const [openDiff] = await tx.$queryRaw<
          { count: number; amountFen: string; earliestBillDate: string | null }[]
        >`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_fen),0)::text AS "amountFen", MIN(bill_date)::text AS "earliestBillDate" FROM payment_exception WHERE status='open'`;
        return PaymentTransactionSummarySchema.parse({
          filtered,
          today: await receiptTotals(tx, startOfDay(now), startOfDay(addDays(now, 1))),
          month: await receiptTotals(tx, startOfDay(month), startOfDay(monthEnd)),
          monthRefund,
          openDiff,
        });
      }),
  };
}
