import {
  BILLING_PARAM_VALUES,
  PlanAdminColumnSchema,
  PlanAdminListSchema,
  PlanNameUpdateBodySchema,
  PlanCreateBodySchema,
  PlanRevisionCreateBodySchema,
  PlanRevisionWithdrawBodySchema,
  PlanRevisionViewSchema,
  PlanRevisionPageSchema,
  PlanSummarySchema,
} from "@liyoxi/contract";
import type {
  PlanAdminListQuery,
  PlanAdminColumn,
  PlanRevisionCreateBody,
  PlanRevisionListQuery,
  StaffBrief,
} from "@liyoxi/contract";
import type { Plan, Prisma } from "@liyoxi/db";
import { addDays, calendarDate, dayRange } from "@liyoxi/shared/time";
import { record } from "../../audit/index.js";
import { assertAccess, hasPermission } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { AppError, uuidv7 } from "../../kernel/index.js";
import type {
  Clock,
  IdentityContext,
  IdempotencyContext,
  Tx,
  TxRunner,
} from "../../kernel/index.js";
import { paramsAt } from "../pricing/index.js";
import type { Notices } from "../../config/index.js";
import type { Events } from "../../events/index.js";
import { formatMoney } from "@liyoxi/shared/format/money";

export interface PlanAdminActor {
  readonly identity: IdentityContext;
  readonly staff: StaffContext;
}
type Revision = Prisma.PlanRevisionGetPayload<{ include: { siteNotice: true } }>;
type Counts = Pick<
  PlanAdminColumn,
  "activeEntityCount" | "newThisMonthCount" | "renewedThisMonthCount"
>;

/** 列表和KPI复用本域同一事实筛选；月内全局主体不能把每个版本的去重计数相加。 */
async function activityRows(tx: Tx, at: Date, planIds?: readonly string[]) {
  const [year, month] = calendarDate(at).split("-").map(Number),
    from = new Date(Date.UTC(year!, month! - 1, 1)),
    until = new Date(Date.UTC(year!, month!, 1)),
    plans = planIds ? { planId: { in: [...planIds] } } : {};
  const [active, events] = await Promise.all([
    tx.subscriptionTerm.findMany({
      where: { ...plans, status: "active", endsAt: { gt: at } },
      select: { planId: true, entityId: true, monthlyEquivFen: true },
    }),
    tx.subscriptionEvent.findMany({
      where: {
        ...(planIds ? { subscriptionTerm: plans } : {}),
        bizDate: { gte: from, lt: until },
        type: { in: ["activated", "renewal_scheduled"] },
      },
      select: {
        entityId: true,
        type: true,
        subscriptionTerm: { select: { planId: true, origin: true } },
      },
    }),
  ]);
  return { active, events };
}
function activityCounts(rows: Awaited<ReturnType<typeof activityRows>>, id?: string): Counts {
  const active = rows.active.filter((r) => !id || r.planId === id),
    events = rows.events.filter((r) => !id || r.subscriptionTerm.planId === id);
  return {
    activeEntityCount: new Set(active.map((r) => r.entityId)).size,
    newThisMonthCount: new Set(
      events
        .filter((r) => r.type === "activated" && r.subscriptionTerm.origin === "new")
        .map((r) => r.entityId),
    ).size,
    renewedThisMonthCount: new Set(
      events
        .filter(
          (r) =>
            r.type === "renewal_scheduled" ||
            (r.type === "activated" && r.subscriptionTerm.origin === "resume"),
        )
        .map((r) => r.entityId),
    ).size,
  };
}
/** a07§2.3/a02指标公口；后继报表消费此函数而非另猜零值。 */
export async function planActivityCounts(tx: Tx, planIds: readonly string[], at: Date) {
  const rows = await activityRows(tx, at, planIds);
  return new Map(planIds.map((id) => [id, activityCounts(rows, id)]));
}

export function createPlanAdmin(deps: {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly notices: Notices;
  readonly events: Pick<Events, "emit">;
  readonly staffBriefs: (tx: Tx, ids: readonly string[]) => Promise<StaffBrief[]>;
}) {
  function readAccess(staff: StaffContext) {
    assertAccess(staff, { module: { module: "billing", need: "view" }, permission: null });
  }
  function writeAccess(actor: PlanAdminActor) {
    assertAccess(actor.staff, {
      module: { module: "billing", need: "view" },
      permission: "billing.plan.edit",
    });
    if (
      actor.identity.actor.type !== "staff" ||
      actor.identity.actor.id !== actor.staff.staff.id ||
      actor.identity.entityId !== null ||
      actor.identity.storeId !== null
    )
      throw new AppError("PERMISSION_DENIED");
  }
  async function enabled(tx: Tx, at: Date) {
    const current = (await paramsAt(tx, at)).enabledCycles,
      pending = await tx.billingParam.findFirst({
        where: { key: "enabledCycles", effectiveAt: { gt: at }, cancelledAt: null },
        orderBy: { effectiveAt: "asc" },
      });
    return {
      current,
      pending: pending
        ? {
            billingParamId: pending.id,
            value: BILLING_PARAM_VALUES.enabledCycles.parse(pending.value),
            effectiveAt: pending.effectiveAt.toISOString(),
          }
        : null,
    };
  }
  async function revisions(tx: Tx, id: string, at: Date) {
    const include = { siteNotice: true } as const;
    const [current, pending] = await Promise.all([
      tx.planRevision.findFirst({
        where: { planId: id, effectiveAt: { lte: at }, cancelledAt: null },
        orderBy: [{ effectiveAt: "desc" }, { revisionNo: "desc" }],
        include,
      }),
      tx.planRevision.findFirst({
        where: { planId: id, effectiveAt: { gt: at }, cancelledAt: null },
        orderBy: [{ effectiveAt: "asc" }, { revisionNo: "asc" }],
        include,
      }),
    ]);
    return { current, pending };
  }
  function revisionState(row: Revision, at: Date, currentId: string | null) {
    return row.cancelledAt
      ? "cancelled"
      : row.effectiveAt > at
        ? "pending"
        : row.id === currentId
          ? "effective"
          : "superseded";
  }
  async function revisionView(
    tx: Tx,
    row: Revision,
    staff: StaffContext,
    at: Date,
    currentId: string | null,
  ) {
    const state = revisionState(row, at, currentId),
      notice = row.siteNotice,
      people = row.createdByStaffId ? await deps.staffBriefs(tx, [row.createdByStaffId]) : [],
      createdBy = people.find((p) => p.staffId === row.createdByStaffId) ?? null;
    if (row.createdByStaffId && !createdBy) throw new TypeError("价目修订缺少真实员工引用");
    return PlanRevisionViewSchema.parse({
      planRevisionId: row.id,
      planId: row.planId,
      revisionNo: row.revisionNo,
      monthlyFeeFen: row.monthlyFeeFen,
      monthlyPoints: row.monthlyPoints,
      discountBp: row.discountBp,
      productionModel: row.productionModel,
      maxStores: row.maxStores,
      maxMembers: row.maxMembers,
      schedulePriority: row.schedulePriority,
      hasMonthlyReport: row.hasMonthlyReport,
      cyclePrices: Object.entries(row.cyclePrices as Record<string, number>)
        .map(([months, priceFen]) => ({ months: Number(months), priceFen }))
        .sort((a, b) => a.months - b.months),
      hasFirstCyclePromo: row.legacyPromo !== null,
      effectiveAt: row.effectiveAt.toISOString(),
      status: state,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      notice: notice
        ? {
            siteNoticeId: notice.id,
            title: notice.title,
            summary: notice.summary,
            summaryNoPrice: notice.summaryNoPrice,
            status: notice.status,
            announcedAt: notice.announcedAt.toISOString(),
            leadDays: notice.leadDays,
          }
        : null,
      createdBy,
      createdAt: row.createdAt.toISOString(),
      actions: state === "pending" && hasPermission(staff, "billing.plan.edit") ? ["withdraw"] : [],
    });
  }
  async function column(tx: Tx, plan: Plan, staff: StaffContext, at: Date, counts?: Counts) {
    const rows = await revisions(tx, plan.id, at);
    // 动作只指向正式处理器；已有待生效行时须先撤回再改。
    const actions: PlanAdminColumn["actions"] = hasPermission(staff, "billing.plan.edit")
      ? [
          "update",
          ...(!rows.pending ? ["create-plan-revision" as const] : []),
          ...(plan.isListed ? ["delist" as const] : rows.current ? ["shelve" as const] : []),
        ]
      : [];
    return PlanAdminColumnSchema.parse({
      planId: plan.id,
      code: plan.code,
      name: plan.name,
      rank: plan.rank,
      scope: plan.scope,
      isListed: plan.isListed,
      columnStatus: rows.pending
        ? "pending_change"
        : plan.isListed
          ? "listed"
          : rows.current
            ? "delisted"
            : "draft",
      current: rows.current
        ? await revisionView(tx, rows.current, staff, at, rows.current.id)
        : null,
      pending: rows.pending
        ? await revisionView(tx, rows.pending, staff, at, rows.current?.id ?? null)
        : null,
      ...(counts ?? (await planActivityCounts(tx, [plan.id], at)).get(plan.id)!),
      lockVersion: plan.lockVersion,
      actions,
    });
  }
  async function locked(tx: Tx, id: string) {
    // plan按冻结数据模型不参与全局锁序；自身行锁串行CAS/上下架，不新增kernel锁项。
    await tx.$queryRaw`SELECT id FROM plan WHERE id=${id}::uuid FOR UPDATE`;
    const plan = await tx.plan.findUnique({ where: { id } });
    if (!plan) throw new AppError("NOT_FOUND");
    return plan;
  }
  async function serialCatalog(tx: Tx) {
    // 相邻套餐并发改价也须串行，避免各自只锁plan时都看见旧价而破坏等级顺序。
    // 复用既有事务咨询锁原语；固定域命名空间，先于本套餐行锁，不新增kernel锁序。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('billing.plan_catalog',0))`;
  }
  async function revisionAudit(
    tx: Tx,
    actor: PlanAdminActor,
    row: Revision,
    before: object | null,
    note?: string,
  ) {
    const after = {
      planId: row.planId,
      revisionNo: row.revisionNo,
      monthlyFeeFen: row.monthlyFeeFen,
      monthlyPoints: row.monthlyPoints,
      discountBp: row.discountBp,
      productionModel: row.productionModel,
      maxStores: row.maxStores,
      maxMembers: row.maxMembers,
      schedulePriority: row.schedulePriority,
      hasMonthlyReport: row.hasMonthlyReport,
      cyclePrices: row.cyclePrices,
      legacyPromo: row.legacyPromo,
      effectiveAt: row.effectiveAt.toISOString(),
      announcedAt: row.announcedAt?.toISOString() ?? null,
      siteNoticeId: row.siteNoticeId,
      createdByStaffId: row.createdByStaffId,
      createdAt: row.createdAt.toISOString(),
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
    };
    await record(
      tx,
      actor.identity.actor,
      {
        requestId: actor.identity.requestId,
        ip: actor.identity.ip,
        userAgent: actor.identity.userAgent,
        authMethod: null,
        sessionId: null,
      },
      {
        stream: "activity",
        category: "plan_config",
        action: before ? "billing.plan_revision.withdraw" : "billing.plan_revision.create",
        summary: before ? "撤回套餐价目修订" : "新建套餐价目修订",
        target: { type: "plan_revision", id: row.id },
        before,
        after,
        fields: before ? ["cancelledAt"] : Object.keys(after),
        ...(note ? { reason: { code: "other", text: note } } : {}),
      },
    );
  }
  async function tierOrder(
    tx: Tx,
    plan: Plan,
    input: Pick<PlanRevisionCreateBody, "monthlyFeeFen" | "monthlyPoints">,
    prices: Record<string, number>,
    effectiveAt: Date,
  ) {
    const all = await tx.plan.findMany({
      where: { scope: "public" },
      orderBy: { rank: "asc" },
      include: {
        planRevisions: {
          where: { cancelledAt: null },
          orderBy: [{ effectiveAt: "desc" }, { revisionNo: "desc" }],
        },
      },
    });
    // 校验本次生效及已排期相邻价目的切换点，避免今天合法但后续已排期变价后倒挂。
    const times = [
      ...new Set([
        effectiveAt.getTime(),
        ...all.flatMap((p) =>
          p.planRevisions
            .filter((r) => r.effectiveAt > effectiveAt)
            .map((r) => r.effectiveAt.getTime()),
        ),
      ]),
    ].sort((a, b) => a - b);
    for (const time of times)
      for (const other of all) {
        if (other.id === plan.id) continue;
        const row = other.planRevisions.find((r) => r.effectiveAt.getTime() <= time);
        if (!row) continue;
        const direction = plan.rank > other.rank ? 1 : -1,
          fields: string[] = [];
        if ((input.monthlyPoints - row.monthlyPoints) * direction <= 0)
          fields.push("monthlyPoints");
        const otherPrices = row.cyclePrices as Record<string, number>,
          months = new Set([...Object.keys(prices), ...Object.keys(otherPrices)]);
        for (const month of months) {
          const mine = prices[month] ?? input.monthlyFeeFen * Number(month),
            theirs = otherPrices[month] ?? row.monthlyFeeFen * Number(month);
          if ((mine - theirs) * direction <= 0) fields.push(`cyclePrices.${month}`);
        }
        if (fields.length)
          throw new AppError("PLAN_TIER_ORDER_INVALID", {
            details: {
              planId: other.id,
              name: other.name,
              fields,
              effectiveAt: new Date(time).toISOString(),
            },
          });
      }
  }
  function announcement(
    plan: Plan,
    current: Revision | null,
    input: PlanRevisionCreateBody,
    prices: Record<string, number>,
    effectiveAt: Date,
  ) {
    const changes: string[] = [],
      noPrice: string[] = [];
    const numeric = ["monthlyPoints", "maxStores", "maxMembers", "discountBp"] as const;
    const labels = {
      monthlyPoints: "每月积分",
      maxStores: "门店上限",
      maxMembers: "成员上限",
      discountBp: "订购折扣",
    };
    if (!current || input.monthlyFeeFen !== current.monthlyFeeFen) {
      changes.push(
        `月费 ${current ? formatMoney(current.monthlyFeeFen) : "无"} → ${formatMoney(input.monthlyFeeFen)}`,
      );
      noPrice.push("月费调整");
    }
    for (const key of numeric)
      if (!current || input[key] !== current[key]) {
        changes.push(`${labels[key]} ${current?.[key] ?? "不限"} → ${input[key] ?? "不限"}`);
        noPrice.push(`${labels[key]}调整`);
      }
    for (const [key, label] of [
      ["productionModel", "制作模型"],
      ["schedulePriority", "排期"],
      ["hasMonthlyReport", "月度报告"],
    ] as const)
      if (!current || input[key] !== current[key]) {
        changes.push(`${label}调整`);
        noPrice.push(`${label}调整`);
      }
    if (
      !current ||
      JSON.stringify(Object.entries(prices).sort()) !==
        JSON.stringify(Object.entries(current.cyclePrices as Record<string, number>).sort())
    ) {
      changes.push("购买周期价格调整");
      noPrice.push("购买周期价格调整");
    }
    if (input.firstCyclePromo !== Boolean(current?.legacyPromo)) {
      changes.push("首期优惠规则调整");
      noPrice.push("首期优惠规则调整");
    }
    const suffix = `；${calendarDate(effectiveAt)}起对新开通与续费生效`,
      clip = (value: string, max: number) => [...value].slice(0, max).join("");
    return {
      title: input.notice?.title ?? clip(`${plan.name}价格与权益调整`, 40),
      summary: input.notice?.summary ?? clip(changes.join("；"), 200 - [...suffix].length) + suffix,
      summaryNoPrice:
        input.notice?.summaryNoPrice ??
        clip(noPrice.join("；") || "套餐权益调整", 200 - [...suffix].length) + suffix,
      barEnabled: input.notice?.isBarEnabled ?? true,
    };
  }
  async function audit(
    tx: Tx,
    actor: PlanAdminActor,
    before: Plan,
    after: Plan,
    action: "billing.plan.update" | "billing.plan.shelve" | "billing.plan.delist",
  ) {
    await record(
      tx,
      actor.identity.actor,
      {
        requestId: actor.identity.requestId,
        ip: actor.identity.ip,
        userAgent: actor.identity.userAgent,
        authMethod: null,
        sessionId: null,
      },
      {
        stream: "activity",
        category: "plan_config",
        action,
        summary: action,
        target: { type: "plan", id: before.id },
        before: { name: before.name, isListed: before.isListed, lockVersion: before.lockVersion },
        after: { name: after.name, isListed: after.isListed, lockVersion: after.lockVersion },
        fields: action === "billing.plan.update" ? ["name"] : ["isListed"],
      },
    );
  }
  async function listing(
    actor: PlanAdminActor,
    id: string,
    isListed: boolean,
    options: { idem?: IdempotencyContext } = {},
  ) {
    writeAccess(actor);
    return deps.tx.run(async (tx) => {
      const before = await locked(tx, id),
        at = deps.clock.now();
      if (before.isListed === isListed) throw new AppError("STATE_NOT_ALLOWED");
      if (isListed) {
        const current = (await revisions(tx, id, at)).current,
          cycles = (await enabled(tx, at)).current,
          prices = current?.cyclePrices as Record<string, unknown> | undefined,
          missingCycles = cycles.filter(
            (months) =>
              !prices ||
              !Number.isSafeInteger(prices[String(months)]) ||
              Number(prices[String(months)]) <= 0,
          );
        if (!current || missingCycles.length)
          throw new AppError("PLAN_REVISION_MISSING", { details: { missingCycles } });
      }
      const after = await tx.plan.update({
        where: { id },
        data: { isListed, lockVersion: { increment: 1 }, updatedAt: at },
      });
      await audit(
        tx,
        actor,
        before,
        after,
        isListed ? "billing.plan.shelve" : "billing.plan.delist",
      );
      return column(tx, after, actor.staff, at);
    }, options);
  }
  return {
    create(actor: PlanAdminActor, raw: unknown, options: { idem?: IdempotencyContext } = {}) {
      writeAccess(actor);
      const body = PlanCreateBodySchema.safeParse(raw);
      if (!body.success) throw new AppError("VALIDATION_FAILED");
      return deps.tx.run(async (tx) => {
        await serialCatalog(tx);
        if (await tx.plan.findUnique({ where: { code: body.data.code } }))
          throw new AppError("PLAN_CODE_TAKEN");
        const rank = await tx.plan.findUnique({ where: { rank: body.data.rank } });
        if (rank)
          throw new AppError("PLAN_RANK_TAKEN", { details: { planId: rank.id, rank: rank.rank } });
        const now = deps.clock.now(),
          plan = await tx.plan.create({
            data: {
              ...body.data,
              id: uuidv7(),
              scope: "public",
              isListed: false,
              lockVersion: 0,
              createdAt: now,
              updatedAt: now,
            },
          });
        await record(
          tx,
          actor.identity.actor,
          {
            requestId: actor.identity.requestId,
            ip: actor.identity.ip,
            userAgent: actor.identity.userAgent,
            authMethod: null,
            sessionId: null,
          },
          {
            stream: "activity",
            category: "plan_config",
            action: "billing.plan.create",
            summary: "新建套餐版本",
            target: { type: "plan", id: plan.id },
            before: null,
            after: {
              code: plan.code,
              name: plan.name,
              rank: plan.rank,
              scope: plan.scope,
              isListed: plan.isListed,
            },
            fields: ["code", "name", "rank", "scope", "isListed"],
          },
        );
        return column(tx, plan, actor.staff, now);
      }, options);
    },
    createRevision(
      actor: PlanAdminActor,
      id: string,
      raw: unknown,
      options: { idem?: IdempotencyContext } = {},
    ) {
      writeAccess(actor);
      const parsed = PlanRevisionCreateBodySchema.safeParse(raw);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      const input = parsed.data;
      return deps.tx.run(async (tx) => {
        await serialCatalog(tx);
        const plan = await locked(tx, id),
          now = deps.clock.now(),
          rows = await revisions(tx, id, now);
        if (rows.pending)
          throw new AppError("REVISION_PENDING_EXISTS", {
            details: {
              revision: await revisionView(
                tx,
                rows.pending,
                actor.staff,
                now,
                rows.current?.id ?? null,
              ),
            },
          });
        const latest = await tx.planRevision.findFirst({
            where: { planId: id },
            orderBy: { revisionNo: "desc" },
          }),
          first = !latest,
          params = await paramsAt(tx, now);
        let earliest = addDays(calendarDate(now), params.noticeDays);
        // 07§2.2要求完整公告天数；日期只能在北京零点生效，因此向上取下一个可用日期。
        if (dayRange(earliest).start.getTime() < now.getTime() + params.noticeDays * 86_400_000)
          earliest = addDays(earliest, 1);
        if (
          (!first && (!input.effectiveDate || input.effectiveDate < earliest)) ||
          (first && input.effectiveDate && input.effectiveDate < calendarDate(now))
        )
          throw new AppError("NOTICE_PERIOD_REQUIRED", {
            details: { earliestEffectiveDate: first ? calendarDate(now) : earliest },
          });
        const effectiveAt = input.effectiveDate ? dayRange(input.effectiveDate).start : now,
          cycles = await enabled(tx, now),
          months = [...new Set([...cycles.current, ...(cycles.pending?.value ?? [])])],
          prices = input.cyclePrices
            ? Object.fromEntries(input.cyclePrices.map((p) => [String(p.months), p.priceFen]))
            : Object.fromEntries(months.map((m) => [String(m), input.monthlyFeeFen * m]));
        if (
          months.some((m) => !prices[String(m)]) ||
          Object.values(prices).some((n) => !Number.isSafeInteger(n) || n <= 0 || n > 2_147_483_647)
        )
          throw new AppError("VALIDATION_FAILED");
        const comparable = (r: {
          monthlyFeeFen: number;
          monthlyPoints: number;
          discountBp: number;
          productionModel: string;
          maxStores: number;
          maxMembers: number | null;
          schedulePriority: string;
          hasMonthlyReport: boolean;
        }) => ({
          monthlyFeeFen: r.monthlyFeeFen,
          monthlyPoints: r.monthlyPoints,
          discountBp: r.discountBp,
          productionModel: r.productionModel,
          maxStores: r.maxStores,
          maxMembers: r.maxMembers,
          schedulePriority: r.schedulePriority,
          hasMonthlyReport: r.hasMonthlyReport,
        });
        if (
          rows.current &&
          JSON.stringify(comparable(input)) === JSON.stringify(comparable(rows.current)) &&
          JSON.stringify(Object.entries(prices).sort()) ===
            JSON.stringify(
              Object.entries(rows.current.cyclePrices as Record<string, number>).sort(),
            ) &&
          input.firstCyclePromo === Boolean(rows.current.legacyPromo)
        )
          throw new AppError("CHANGESET_EMPTY");
        await tierOrder(tx, plan, input, prices, effectiveAt);
        const revisionId = uuidv7();
        let siteNoticeId: string | null = null,
          announcedAt: Date | null = null;
        if (!first) {
          siteNoticeId = (
            await deps.notices.announce(tx, actor.identity, {
              ...announcement(plan, rows.current, input, prices, effectiveAt),
              kind: "plan_revision",
              refId: revisionId,
              effectiveAt,
              createdByStaffId: actor.staff.staff.id,
              link: { route: "plan.revision", params: { planRevisionId: revisionId } },
            })
          ).siteNoticeId;
          announcedAt = (
            await tx.siteNotice.findUniqueOrThrow({
              where: { id: siteNoticeId },
              select: { announcedAt: true },
            })
          ).announcedAt;
        }
        const row = await tx.planRevision.create({
          data: {
            id: revisionId,
            planId: id,
            revisionNo: (latest?.revisionNo ?? 0) + 1,
            ...comparable(input),
            cyclePrices: prices,
            effectiveAt,
            siteNoticeId,
            announcedAt,
            ...(input.firstCyclePromo ? { legacyPromo: { type: "previous_revision" } } : {}),
            createdByStaffId: actor.staff.staff.id,
            createdAt: now,
          },
          include: { siteNotice: true },
        });
        if (effectiveAt > now)
          await deps.events.emit(tx, actor.identity, {
            type: "billing.plan_revision_scheduled",
            aggregate: { type: "plan_revision", id: row.id },
            payload: {
              v: 1,
              planRevisionId: row.id,
              planId: id,
              effectiveAt: effectiveAt.toISOString(),
            },
          });
        await revisionAudit(tx, actor, row, null);
        return revisionView(
          tx,
          row,
          actor.staff,
          now,
          effectiveAt <= now ? row.id : (rows.current?.id ?? null),
        );
      }, options);
    },
    withdrawRevision(
      actor: PlanAdminActor,
      id: string,
      raw: unknown,
      options: { idem?: IdempotencyContext } = {},
    ) {
      writeAccess(actor);
      const body = PlanRevisionWithdrawBodySchema.safeParse(raw);
      if (!body.success) throw new AppError("VALIDATION_FAILED");
      return deps.tx.run(async (tx) => {
        await serialCatalog(tx);
        const initial = await tx.planRevision.findUnique({ where: { id } });
        if (!initial) throw new AppError("NOT_FOUND");
        const plan = await locked(tx, initial.planId);
        const row = await tx.planRevision.findUniqueOrThrow({
            where: { id },
            include: { siteNotice: true },
          }),
          now = deps.clock.now();
        if (row.cancelledAt || row.effectiveAt <= now)
          throw new AppError("REVISION_ALREADY_EFFECTIVE", {
            details: {
              effectiveAt: row.effectiveAt.toISOString(),
              cancelledAt: row.cancelledAt?.toISOString() ?? null,
            },
          });
        if (
          body.data.confirm.planRevisionId !== id ||
          new Date(body.data.confirm.effectiveAt).getTime() !== row.effectiveAt.getTime()
        )
          throw new AppError("CONFIRM_MISMATCH");
        const after = await tx.planRevision.update({
          where: { id },
          data: { cancelledAt: now },
          include: { siteNotice: true },
        });
        // 撤回也会改变未来取价：不能让另一个已公告排期依赖被撤回的新价而倒挂。
        const current = (await revisions(tx, row.planId, now)).current;
        if (current)
          await tierOrder(tx, plan, current, current.cyclePrices as Record<string, number>, now);
        if (row.siteNoticeId)
          await deps.notices.withdraw(tx, actor.identity, {
            siteNoticeId: row.siteNoticeId,
            staffId: actor.staff.staff.id,
          });
        const result = await tx.planRevision.findUniqueOrThrow({
          where: { id },
          include: { siteNotice: true },
        });
        await revisionAudit(tx, actor, after, { cancelledAt: null }, body.data.note);
        return revisionView(
          tx,
          result,
          actor.staff,
          now,
          (await revisions(tx, row.planId, now)).current?.id ?? null,
        );
      }, options);
    },
    revisionList(staff: StaffContext, query: PlanRevisionListQuery) {
      readAccess(staff);
      return deps.tx.run(async (tx) => {
        const now = deps.clock.now(),
          all = await tx.planRevision.findMany({
            where: query.planId ? { planId: query.planId } : {},
            include: { siteNotice: true, plan: true },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          }),
          current = new Map<string, string>();
        for (const row of all)
          if (!row.cancelledAt && row.effectiveAt <= now) {
            const previous = all.find((r) => r.id === current.get(row.planId));
            if (
              !previous ||
              row.effectiveAt > previous.effectiveAt ||
              (row.effectiveAt.getTime() === previous.effectiveAt.getTime() &&
                row.revisionNo > previous.revisionNo)
            )
              current.set(row.planId, row.id);
          }
        const rows = all.filter(
          (r) =>
            !query.status ||
            query.status.includes(revisionState(r, now, current.get(r.planId) ?? null)),
        );
        return PlanRevisionPageSchema.parse({
          items: await Promise.all(
            rows
              .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
              .map(async (r) => ({
                ...(await revisionView(tx, r, staff, now, current.get(r.planId) ?? null)),
                plan: { planId: r.planId, name: r.plan.name },
              })),
          ),
          page: query.page,
          pageSize: query.pageSize,
          total: rows.length,
        });
      });
    },
    summary(staff: StaffContext) {
      readAccess(staff);
      return deps.tx.run(async (tx) => {
        const now = deps.clock.now(),
          rows = await activityRows(tx, now);
        return PlanSummarySchema.parse({
          ...activityCounts(rows),
          mrrFen: rows.active.reduce((sum, r) => sum + BigInt(r.monthlyEquivFen), 0n).toString(),
          asOf: now.toISOString(),
        });
      });
    },
    list(staff: StaffContext, query: PlanAdminListQuery) {
      readAccess(staff);
      return deps.tx.run(async (tx) => {
        const at = deps.clock.now(),
          plans = await tx.plan.findMany({
            where: query.includeDelisted ? {} : { isListed: true },
            orderBy: [{ rank: "asc" }, { id: "asc" }],
          }),
          counts = await planActivityCounts(
            tx,
            plans.map((row) => row.id),
            at,
          );
        return PlanAdminListSchema.parse({
          items: await Promise.all(
            plans.map((plan) => column(tx, plan, staff, at, counts.get(plan.id))),
          ),
          enabledCycles: await enabled(tx, at),
        });
      });
    },
    update(
      actor: PlanAdminActor,
      id: string,
      raw: unknown,
      options: { idem?: IdempotencyContext } = {},
    ) {
      writeAccess(actor);
      const body = PlanNameUpdateBodySchema.safeParse(raw);
      if (!body.success) throw new AppError("VALIDATION_FAILED");
      return deps.tx.run(async (tx) => {
        const before = await locked(tx, id);
        if (before.lockVersion !== body.data.lockVersion) throw new AppError("VERSION_CONFLICT");
        if (before.name === body.data.name) throw new AppError("CHANGESET_EMPTY");
        const at = deps.clock.now(),
          after = await tx.plan.update({
            where: { id },
            data: { name: body.data.name, lockVersion: { increment: 1 }, updatedAt: at },
          });
        await audit(tx, actor, before, after, "billing.plan.update");
        return column(tx, after, actor.staff, at);
      }, options);
    },
    shelve: (actor: PlanAdminActor, id: string, options?: { idem?: IdempotencyContext }) =>
      listing(actor, id, true, options),
    delist: (actor: PlanAdminActor, id: string, options?: { idem?: IdempotencyContext }) =>
      listing(actor, id, false, options),
  };
}
