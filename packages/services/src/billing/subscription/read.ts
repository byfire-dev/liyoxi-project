import { Prisma } from "@liyoxi/db";
import type { SubscriptionTerm } from "@liyoxi/db";
import { SubscriptionTermRowSchema, SubscriptionTermDetailSchema } from "@liyoxi/contract";
import type { SubscriptionTermListQuery, SubscriptionTermSummaryQuery } from "@liyoxi/contract";
import { addDays, calendarDate, diffDays, startOfDay } from "@liyoxi/shared/time";
import { divRoundHalfUp } from "@liyoxi/shared/pricing";
import { byEntity, hasPermission, satisfiesLevel, assertPermission } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { AppError, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, IdempotencyContext, Tx } from "../../kernel/index.js";
import { staffBrief } from "../payment/purchase-read.js";
import type { BillingPurchaseDeps } from "../payment/purchase-context.js";
import { paramsAt } from "../pricing/index.js";
import { fromDateColumn, toDateColumn } from "../ledger/context.js";
import { renewalApplicable } from "./reminders.js";

const include = {
  entity: { include: { stores: true, billingAccounts: true } },
  plan: true,
  sourceBillingOrder: true,
} satisfies Prisma.SubscriptionTermInclude;
type Term = Prisma.SubscriptionTermGetPayload<{ include: typeof include }>;
const date = fromDateColumn;
function view(staff: StaffContext) {
  if (!satisfiesLevel(staff.moduleLevels.order, "view")) throw new AppError("PERMISSION_DENIED");
}

export function createBillingSubscriptions(deps: BillingPurchaseDeps) {
  async function scoped(tx: Tx, staff: StaffContext, id: string) {
    view(staff);
    const term = await tx.subscriptionTerm.findFirst({
      where: { id, ...byEntity(staff.scope) },
      include,
    });
    if (!term) throw new AppError("NOT_FOUND");
    return term;
  }
  async function candidates(
    tx: Tx,
    staff: StaffContext,
    query: SubscriptionTermSummaryQuery,
    tab: SubscriptionTermListQuery["tab"],
    now: Date,
  ) {
    const today = calendarDate(now),
      month = today.slice(0, 7),
      start = startOfDay(`${month}-01`);
    // 范围仍由唯一byEntity谓词生成；原始候选只查订阅/付款事实，之后再受范围过滤。
    const ids = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT t.id FROM subscription_term t
      WHERE ${tab === "expiring" ? Prisma.sql`t.status='active' AND t.ends_at > ${now} AND t.end_date <= ${toDateColumn(addDays(today, 6))} AND NOT EXISTS (SELECT 1 FROM subscription_term n WHERE n.entity_id=t.entity_id AND n.status='scheduled')` : tab === "expired" ? Prisma.sql`t.status='ended' AND t.end_date >= ${toDateColumn(addDays(today, -30))} AND NOT EXISTS (SELECT 1 FROM subscription_term n WHERE n.entity_id=t.entity_id AND ((n.status IN ('scheduled','active') AND n.ends_at>${now}) OR (n.status='ended' AND n.ends_at>t.ends_at)))` : Prisma.sql`EXISTS (SELECT 1 FROM subscription_term n JOIN billing_order o ON o.id=n.source_billing_order_id WHERE n.entity_id=t.entity_id AND n.term_no=t.term_no+1 AND n.origin IN ('renew','resume') AND o.paid_at>=${start} AND o.paid_at<${new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1) - 8 * 3600000)})`}
    `);
    const where: Prisma.SubscriptionTermWhereInput = {
      AND: [
        { id: { in: ids.map((row) => row.id) } },
        byEntity(staff.scope),
        ...(query.q
          ? [
              {
                entity: {
                  OR: [
                    { name: { contains: query.q, mode: "insensitive" as const } },
                    {
                      stores: {
                        some: { name: { contains: query.q, mode: "insensitive" as const } },
                      },
                    },
                  ],
                },
              },
            ]
          : []),
        ...(query.managerId
          ? [
              {
                entity: {
                  stores: { some: { isPrimary: true, deliveryManagerId: query.managerId } },
                },
              },
            ]
          : []),
        ...(query.planId && tab !== "renewed" ? [{ planId: query.planId }] : []),
      ],
    };
    const rows = await tx.subscriptionTerm.findMany({
      where,
      select: { id: true, endDate: true, entityId: true, termNo: true },
    });
    if (tab !== "renewed")
      return rows
        .sort(
          (a, b) =>
            (tab === "expiring"
              ? a.endDate.getTime() - b.endDate.getTime()
              : b.endDate.getTime() - a.endDate.getTime()) || a.id.localeCompare(b.id),
        )
        .map((row) => row.id);
    const paid = new Map<string, Date>(),
      matched: string[] = [];
    for (const term of rows) {
      const following = await next(tx, term);
      if (
        !following?.sourceBillingOrder.paidAt ||
        (query.planId && following.planId !== query.planId)
      )
        continue;
      matched.push(term.id);
      paid.set(term.id, following.sourceBillingOrder.paidAt);
    }
    return matched.sort(
      (a, b) => paid.get(b)!.getTime() - paid.get(a)!.getTime() || a.localeCompare(b),
    );
  }

  async function next(tx: Tx, term: Pick<SubscriptionTerm, "entityId" | "termNo">) {
    return tx.subscriptionTerm.findUnique({
      where: { entityId_termNo: { entityId: term.entityId, termNo: term.termNo + 1 } },
      include: { plan: true, sourceBillingOrder: true },
    });
  }
  async function row(
    tx: Tx,
    staff: StaffContext,
    term: Term,
    now: Date,
    tab?: SubscriptionTermListQuery["tab"],
  ) {
    const today = calendarDate(now),
      account = term.entity.billingAccounts[0],
      primary = term.entity.stores.find((s) => s.isPrimary),
      following = await next(tx, term);
    const manual = await tx.manualReminderLog.findUnique({
      where: {
        subjectType_subjectId_scene_bizDate: {
          subjectType: "subscription_term",
          subjectId: term.id,
          scene: "renewal",
          bizDate: toDateColumn(today),
        },
      },
    });
    const follow = await tx.followUp.findFirst({
      where: { subjectType: "subscription_term", subjectId: term.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const pending = await tx.termExtensionRequest.findFirst({
      where: { subscriptionTermId: term.id, approvalRequest: { status: "pending" } },
    });
    const notifications = await tx.notification.findMany({
      where: { bizType: "subscription_term", bizId: term.id, notifySceneKey: "m.plan_expiring" },
      include: { notificationDeliveries: true },
    });
    const params = await paramsAt(tx, now),
      applicable = await renewalApplicable(tx, term.id, now);
    const reminders = [...new Set([0, ...params.renewalReminderDays])]
      .sort((a, b) => b - a)
      .map((n) => {
        const node = `T-${n}`,
          dueDate = addDays(date(term.endDate), -n),
          sent = notifications.filter((v) => v.node === node);
        return {
          node,
          dueDate,
          state: sent.length
            ? "sent"
            : dueDate > today && startOfDay(dueDate) >= term.startsAt && applicable
              ? "pending"
              : "skipped",
          channels: sent.flatMap((v) =>
            v.notificationDeliveries.map((d) => ({
              channel: d.channel,
              status: d.status,
              sentAt: d.sentAt?.toISOString() ?? null,
            })),
          ),
        };
      });
    reminders.push(
      ...notifications
        .filter((v) => v.node === "M")
        .map((v) => ({
          node: "M",
          dueDate: calendarDate(v.createdAt),
          state: "sent",
          channels: v.notificationDeliveries.map((d) => ({
            channel: d.channel,
            status: d.status,
            sentAt: d.sentAt?.toISOString() ?? null,
          })),
        })),
    );
    const renewal =
      tab === "renewed" && following
        ? {
            subscriptionTermId: following.id,
            paymentOrderId: following.sourceBillingOrderId,
            orderNo: following.sourceBillingOrder.orderNo,
            planName: following.plan.name,
            months: following.months,
            amountFen: following.sourceBillingOrder.paidAmountFen,
            paidAt: following.sourceBillingOrder.paidAt?.toISOString() ?? null,
            newStartDate: date(following.startDate),
            newEndDate: date(following.endDate),
            renewalTiming:
              following.origin === "resume"
                ? "after_expiry"
                : following.sourceBillingOrder.paidAt! < startOfDay(addDays(date(term.endDate), -7))
                  ? "early"
                  : "before_due",
          }
        : null;
    return SubscriptionTermRowSchema.parse({
      subscriptionTermId: term.id,
      entity: {
        entityId: term.entityId,
        name: term.entity.name ?? "",
        primaryStoreId: primary?.id ?? null,
        primaryStoreName: primary?.name ?? null,
        storeCount: term.entity.stores.filter((v) => v.lifecycle === "active").length,
        verificationStatus: term.entity.verificationStatus,
        managerStaff: await staffBrief(tx, primary?.deliveryManagerId ?? null),
      },
      plan: { planId: term.planId, name: term.plan.name },
      months: term.months,
      startDate: date(term.startDate),
      endDate: date(term.endDate),
      status: term.status,
      remainingDays: tab === "expiring" ? diffDays(date(term.endDate), today) : null,
      expiredDays: tab === "expired" ? diffDays(today, date(term.endDate)) : null,
      reminders,
      points: {
        planAvailablePoints: account?.planAvailableQty ?? 0,
        lastExpiredPoints: account?.lastExpiredQty ?? null,
        addonAvailablePoints: account?.addonAvailableQty ?? 0,
        isAddonSuspended: account?.subStatus === "expired",
      },
      renewal,
      intent: pending ? "extension_pending" : following ? "renewed" : (follow?.intent ?? "none"),
      manager: await staffBrief(tx, primary?.deliveryManagerId ?? null),
      remindedToday: manual !== null,
      actions: [
        ...(applicable && !manual && hasPermission(staff, "order.renewal.remind")
          ? ["remind"]
          : []),
        ...(term.status === "active" &&
        term.endsAt > now &&
        !pending &&
        hasPermission(staff, "billing.extension.request")
          ? ["create-term-extension-request"]
          : []),
      ],
    });
  }
  return {
    list: (staff: StaffContext, query: SubscriptionTermListQuery) => {
      view(staff);
      return deps.tx.run(async (tx) => {
        const now = deps.clock.now(),
          all = await candidates(tx, staff, query, query.tab, now),
          pageIds = all.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
          found = await tx.subscriptionTerm.findMany({ where: { id: { in: pageIds } }, include }),
          items = pageIds.map((id) => found.find((term) => term.id === id)!);
        return {
          items: await Promise.all(items.map((t) => row(tx, staff, t, now, query.tab))),
          page: query.page,
          pageSize: query.pageSize,
          total: all.length,
        };
      });
    },
    summary: (staff: StaffContext, query: SubscriptionTermSummaryQuery) => {
      view(staff);
      return deps.tx.run(async (tx) => {
        const now = deps.clock.now(),
          expiring = await candidates(tx, staff, query, "expiring", now),
          expired = await candidates(tx, staff, query, "expired", now),
          renewed = await candidates(tx, staff, query, "renewed", now),
          month = calendarDate(now).slice(0, 7);
        const [income] = await tx.$queryRaw<
          { fen: bigint }[]
        >`SELECT COALESCE(SUM(o.paid_amount_fen),0)::bigint AS fen FROM subscription_term old JOIN subscription_term n ON n.entity_id=old.entity_id AND n.term_no=old.term_no+1 JOIN billing_order o ON o.id=n.source_billing_order_id WHERE old.id=ANY(${renewed}::uuid[])`;
        const fen = income?.fen ?? 0n;
        const dueRows = await tx.subscriptionTerm.findMany({
          where: {
            AND: [
              byEntity(staff.scope),
              ...(query.q
                ? [
                    {
                      entity: {
                        OR: [
                          { name: { contains: query.q, mode: "insensitive" as const } },
                          {
                            stores: {
                              some: { name: { contains: query.q, mode: "insensitive" as const } },
                            },
                          },
                        ],
                      },
                    },
                  ]
                : []),
              ...(query.managerId
                ? [
                    {
                      entity: {
                        stores: { some: { isPrimary: true, deliveryManagerId: query.managerId } },
                      },
                    },
                  ]
                : []),
              ...(query.planId ? [{ planId: query.planId }] : []),
            ],
            endDate: {
              gte: toDateColumn(`${month}-01`),
              lt: toDateColumn(addDays(`${month}-01`, 32).slice(0, 7) + "-01"),
            },
            status: { in: ["active", "ended"] },
          },
          select: { id: true, entityId: true, termNo: true },
        });
        let doneCount = 0;
        for (const term of dueRows) {
          const following = await next(tx, term);
          if (
            following &&
            ["active", "scheduled", "ended"].includes(following.status) &&
            following.sourceBillingOrder.paidAt &&
            following.sourceBillingOrder.paidAt <= now
          )
            doneCount++;
        }
        const due = dueRows.length,
          done = renewed.length;
        return {
          expiring: expiring.length,
          expired: expired.length,
          renewed: done,
          renewedFen: fen.toString(),
          renewedAheadCount: await tx.subscriptionTerm.count({
            where: {
              ...byEntity(staff.scope),
              status: "active",
              endsAt: { gt: now },
              endDate: { lte: toDateColumn(addDays(calendarDate(now), 6)) },
              entity: {
                ...byEntity(staff.scope).entity,
                subscriptionTerms: { some: { status: "scheduled" } },
              },
            },
          }),
          renewalRate: {
            month,
            dueCount: due,
            doneCount,
            rateBp: due ? divRoundHalfUp([doneCount, 10000], [due]) : null,
            isProvisional: true,
          },
        };
      });
    },
    get: (staff: StaffContext, id: string) =>
      deps.tx.run(async (tx) => {
        const now = deps.clock.now(),
          t = await scoped(tx, staff, id),
          base = await row(tx, staff, t, now),
          n = await next(tx, t),
          items = await tx.orderItem.groupBy({
            by: ["phase"],
            where: { entityId: t.entityId, phase: { in: ["producing", "to_launch", "live"] } },
            _count: { _all: true },
          }),
          launch = await tx.orderItem.aggregate({
            where: { entityId: t.entityId, phase: "to_launch" },
            _min: { agreedLaunchDate: true },
          }),
          extensions = await tx.termExtensionRequest.findMany({
            where: { appliedSubscriptionTermId: t.id, appliedAt: { not: null } },
            include: { approvalRequest: true },
          }),
          pending = await tx.termExtensionRequest.findFirst({
            where: { subscriptionTermId: t.id, approvalRequest: { status: "pending" } },
            include: { approvalRequest: true },
          }),
          follow = await tx.followUp.findFirst({
            where: { subjectType: "subscription_term", subjectId: t.id },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          });
        return SubscriptionTermDetailSchema.parse({
          ...base,
          endsAt: t.endsAt.toISOString(),
          benefits: {
            monthlyPoints: t.monthlyPoints,
            discountBp: t.discountBp,
            productionModel: t.productionModel,
            maxStores: t.maxStores,
            maxMembers: t.maxMembers,
            schedulePriority: t.schedulePriority,
            hasMonthlyReport: t.hasMonthlyReport,
          },
          pointsForecast: {
            planPointsToExpire: base.points.planAvailablePoints,
            expiresAt: t.endsAt.toISOString(),
            addonWillSuspend: base.points.addonAvailablePoints > 0 && !n,
          },
          orderItems: {
            producingCount: items.find((v) => v.phase === "producing")?._count._all ?? 0,
            toLaunchCount: items.find((v) => v.phase === "to_launch")?._count._all ?? 0,
            liveCount: items.find((v) => v.phase === "live")?._count._all ?? 0,
            nextLaunchDate: launch._min.agreedLaunchDate
              ? date(launch._min.agreedLaunchDate)
              : null,
          },
          nextTerm: n
            ? {
                subscriptionTermId: n.id,
                planName: n.plan.name,
                months: n.months,
                startDate: date(n.startDate),
                endDate: date(n.endDate),
                paymentOrderId: n.sourceBillingOrderId,
                orderNo: n.sourceBillingOrder.orderNo,
                amountFen: n.sourceBillingOrder.paidAmountFen,
                paidAt: n.sourceBillingOrder.paidAt?.toISOString() ?? null,
              }
            : null,
          extensions: extensions.map((e) => ({
            termExtensionRequestId: e.id,
            requestNo: e.approvalRequest.requestNo,
            days: e.days,
            appliedMode: e.appliedMode,
            appliedAt: e.appliedAt!.toISOString(),
          })),
          pendingExtension: pending
            ? {
                termExtensionRequestId: pending.id,
                requestNo: pending.approvalRequest.requestNo,
                days: pending.days,
                requester: await staffBrief(tx, pending.approvalRequest.requesterStaffId),
              }
            : null,
          latestFollowUp: follow
            ? {
                followUpId: follow.id,
                intent: follow.intent,
                channel: follow.channel,
                content: follow.content,
                createdAt: follow.createdAt.toISOString(),
                owner: await staffBrief(tx, follow.ownerStaffId),
              }
            : null,
        });
      }),
    remind: (
      actor: { identity: IdentityContext; staff: StaffContext },
      id: string,
      options: { idem: IdempotencyContext },
    ) => {
      view(actor.staff);
      assertPermission(actor.staff, "order.renewal.remind");
      return deps.tx.run(async (tx) => {
        const term = await scoped(tx, actor.staff, id),
          now = deps.clock.now(),
          bizDate = calendarDate(now);
        if (!(await renewalApplicable(tx, term.id, now)))
          throw new AppError("REMIND_NOT_APPLICABLE", {
            details: { scene: "renewal", reason: "not_applicable" },
          });
        const logId = uuidv7();
        const made = await tx.manualReminderLog.createMany({
          data: [
            {
              id: logId,
              subjectType: "subscription_term",
              subjectId: id,
              scene: "renewal",
              bizDate: toDateColumn(bizDate),
              sentByStaffId: actor.staff.staffId,
              createdAt: now,
            },
          ],
          skipDuplicates: true,
        });
        if (!made.count)
          throw new AppError("REMINDED_TODAY", {
            details: { scene: "renewal", nextAvailableDate: addDays(bizDate, 1) },
          });
        await deps.events.emit(tx, actor.identity, {
          type: "manual_reminder.sent",
          aggregate: { type: "manual_reminder_log", id: logId },
          payload: {
            v: 1,
            manualReminderLogId: logId,
            subjectType: "subscription_term",
            subjectId: id,
            scene: "renewal",
            bizDate,
          },
          entityId: term.entityId,
          storeId: null,
          dedupeKey: `manual_reminder.sent:${logId}`,
        });

        return { manualReminderLogId: logId, bizDate, remindedToday: true as const };
      }, options);
    },
  };
}
