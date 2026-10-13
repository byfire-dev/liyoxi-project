import {
  BILLING_PARAM_VALUES,
  PlanAdminColumnSchema,
  PlanAdminListSchema,
  PlanNameUpdateBodySchema,
} from "@liyoxi/contract";
import type { PlanAdminListQuery, PlanAdminColumn, StaffBrief } from "@liyoxi/contract";
import type { Plan, Prisma } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { record } from "../../audit/index.js";
import { assertAccess, hasPermission } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { AppError } from "../../kernel/index.js";
import type {
  Clock,
  IdentityContext,
  IdempotencyContext,
  Tx,
  TxRunner,
} from "../../kernel/index.js";
import { paramsAt } from "../pricing/index.js";

export interface PlanAdminActor {
  readonly identity: IdentityContext;
  readonly staff: StaffContext;
}
type Revision = Prisma.PlanRevisionGetPayload<{ include: { siteNotice: true } }>;
type Counts = Pick<
  PlanAdminColumn,
  "activeEntityCount" | "newThisMonthCount" | "renewedThisMonthCount"
>;

/** a07§2.3/a02指标的同一口径；本域事实，后继报表消费此函数而非另猜零值。 */
export async function planActivityCounts(tx: Tx, planIds: readonly string[], at: Date) {
  const [year, month] = calendarDate(at).split("-").map(Number),
    from = new Date(Date.UTC(year!, month! - 1, 1)),
    until = new Date(Date.UTC(year!, month!, 1));
  const [active, events] = await Promise.all([
    tx.subscriptionTerm.findMany({
      where: { planId: { in: [...planIds] }, status: "active", endsAt: { gt: at } },
      select: { planId: true, entityId: true },
      distinct: ["planId", "entityId"],
    }),
    tx.subscriptionEvent.findMany({
      where: {
        subscriptionTerm: { planId: { in: [...planIds] } },
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
  const counts = new Map<string, Counts>();
  for (const id of planIds) {
    const rows = events.filter((row) => row.subscriptionTerm.planId === id);
    counts.set(id, {
      activeEntityCount: active.filter((row) => row.planId === id).length,
      newThisMonthCount: new Set(
        rows
          .filter((row) => row.type === "activated" && row.subscriptionTerm.origin === "new")
          .map((row) => row.entityId),
      ).size,
      renewedThisMonthCount: new Set(
        rows
          .filter(
            (row) =>
              row.type === "renewal_scheduled" ||
              (row.type === "activated" && row.subscriptionTerm.origin === "resume"),
          )
          .map((row) => row.entityId),
      ).size,
    });
  }
  return counts;
}

export function createPlanAdmin(deps: {
  readonly tx: TxRunner;
  readonly clock: Clock;
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
  async function column(tx: Tx, plan: Plan, staff: StaffContext, at: Date, counts?: Counts) {
    const rows = await revisions(tx, plan.id, at),
      ids = [
        ...new Set(
          [rows.current?.createdByStaffId, rows.pending?.createdByStaffId].filter(
            (id): id is string => !!id,
          ),
        ),
      ],
      people = new Map((await deps.staffBriefs(tx, ids)).map((row) => [row.staffId, row]));
    const view = (row: Revision | null, status: "effective" | "pending") => {
      if (!row) return null;
      const notice = row.siteNotice;
      const createdBy = row.createdByStaffId ? people.get(row.createdByStaffId) : null;
      if (row.createdByStaffId && !createdBy) throw new TypeError("价目修订缺少真实员工引用");
      return {
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
        status,
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
        actions: [],
      };
    };
    // 未落地的价目编辑/撤回不发死动作；后续同包接正式处理器时再开放。
    const actions: PlanAdminColumn["actions"] = hasPermission(staff, "billing.plan.edit")
      ? [
          "update",
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
      current: view(rows.current, "effective"),
      pending: view(rows.pending, "pending"),
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
