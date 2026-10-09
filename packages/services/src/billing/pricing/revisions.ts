import {
  DramaPriceCreateBodySchema,
  DramaPriceNoteBodySchema,
  EVENT_PAYLOAD_SCHEMAS,
  PriceTierListSchema,
} from "@liyoxi/contract";
import type {
  DramaPriceCreateBody,
  DramaPriceListQuery,
  DramaPriceRevisionListQuery,
} from "@liyoxi/contract";
import { addDays, calendarDate, dayRange } from "@liyoxi/shared/time";
import { record } from "../../audit/index.js";
import { assertAccess } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { AppError, createIdentityContext, lockRows, uuidv7 } from "../../kernel/index.js";
import type { Clock, Tx, FiredTimer, DeliveredEvent } from "../../kernel/index.js";
import type { EmitContext, Events } from "../../events/index.js";
import type { Timers } from "../../timers/index.js";
import { paramsAt } from "./index.js";
import {
  currentTiers,
  detailPricing,
  priceRows,
  revisionView,
  revisionState,
} from "./admin-read.js";
import type { PricingReadDeps } from "./admin-read.js";
export interface DramaPricingDeps extends PricingReadDeps {
  clock: Clock;
  events: Pick<Events, "emit">;
  timers: Pick<Timers, "arm" | "cancel">;
}
const keyOf = (id: string) => `pricing.drama_price_effective:drama_price_revision:${id}`;
async function serial(tx: Tx, id: string) {
  // Fixed namespace plus the whole UUID; PostgreSQL transaction ownership releases on rollback/commit.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pricing.drama:${id}`},0))`;
  await lockRows(tx, "drama", [id]);
}
function readAccess(staff: StaffContext) {
  assertAccess(staff, { module: { module: "billing", need: "view" }, permission: null });
}
function writeAccess(staff: StaffContext, ctx: EmitContext) {
  assertAccess(staff, {
    module: { module: "billing", need: "view" },
    permission: "billing.price.edit",
  });
  if (
    ctx.actor.type !== "staff" ||
    ctx.actor.id !== staff.staff.id ||
    ctx.entityId !== null ||
    ctx.storeId !== null
  )
    throw new AppError("PERMISSION_DENIED");
}
async function audit(
  tx: Tx,
  ctx: EmitContext,
  id: string,
  action: `${string}.${string}.${string}`,
  before: object,
  after: object,
  note?: string,
) {
  await record(
    tx,
    ctx.actor,
    {
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      authMethod: null,
      sessionId: null,
    },
    {
      stream: "activity",
      category: "price_adjust",
      action,
      summary: action,
      target: { type: "drama_price_revision", id },
      before,
      after,
      fields: Object.keys(after),
      ...(note ? { reason: { code: "other", text: note } } : {}),
    },
  );
}
export function createDramaPricing(deps: DramaPricingDeps) {
  async function changed(
    tx: Tx,
    ctx: EmitContext,
    id: string,
    revisionId: string | null,
    cause: "revision" | "tier_change",
    at: Date,
    dedupeKey?: string,
  ) {
    return deps.events.emit(tx, ctx, {
      type: "pricing.drama_price_changed",
      aggregate: { type: revisionId ? "drama_price_revision" : "drama", id: revisionId ?? id },
      payload: {
        v: 1,
        dramaId: id,
        dramaPriceRevisionId: revisionId,
        cause,
        effectiveAt: at.toISOString(),
      },
      ...(dedupeKey ? { dedupeKey } : {}),
    });
  }
  return {
    detailPricing: (tx: Tx, staff: StaffContext, id: string, at = deps.clock.now()) =>
      detailPricing(tx, deps, staff, id, at),
    async list(tx: Tx, staff: StaffContext, query: DramaPriceListQuery) {
      readAccess(staff);
      let rows = await priceRows(tx, deps, staff, deps.clock.now());
      rows = rows.filter(
        (v) =>
          Boolean(v.archivedAt) === query.isArchived &&
          (!query.q || v.title.includes(query.q)) &&
          (!query.dramaId || query.dramaId.includes(v.dramaId)) &&
          (!query.heatTier || Boolean(v.heatTier && query.heatTier.includes(v.heatTier))) &&
          (!query.status || query.status.includes(v.status)) &&
          (!query.priceMode || query.priceMode === v.priceMode),
      );
      rows.sort((a, b) => {
        for (const key of query.sort.split(",")) {
          const desc = key.startsWith("-"),
            field = key.replace(/^-/, "");
          let order = 0;
          if (field === "heatTier")
            order =
              (a.heatTier ? "SABC".indexOf(a.heatTier) : 4) -
              (b.heatTier ? "SABC".indexOf(b.heatTier) : 4);
          if (field === "title") order = a.title.localeCompare(b.title, "zh-CN");
          if (field === "listPricePoints")
            order = (a.listPricePoints ?? -1) - (b.listPricePoints ?? -1);
          if (field === "pricedSince")
            order = (a.pricedSince ?? "").localeCompare(b.pricedSince ?? "");
          if (order) return desc ? -order : order;
        }
        return a.dramaId.localeCompare(b.dramaId);
      });
      return {
        items: rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
        page: query.page,
        pageSize: query.pageSize,
        total: rows.length,
      };
    },
    async summary(tx: Tx, staff: StaffContext) {
      readAccess(staff);
      const at = deps.clock.now(),
        rows = (await priceRows(tx, deps, staff, at)).filter((v) => !v.archivedAt);
      const stats = await tx.dramaStat.findMany({
        where: { dramaId: { in: rows.map((v) => v.dramaId) } },
      });
      return {
        listed: rows.filter((v) => v.status === "listed").length,
        customPriced: rows.filter((v) => v.priceMode === "custom").length,
        ordersMonth: stats.reduce((sum, v) => sum + v.ordersMtd, 0),
        statRefreshedAt: stats.length
          ? new Date(Math.min(...stats.map((v) => v.refreshedAt.getTime()))).toISOString()
          : null,
        minLicenseMonths: (await paramsAt(tx, at)).minLicenseMonths,
      };
    },
    async revisions(tx: Tx, staff: StaffContext, query: DramaPriceRevisionListQuery) {
      readAccess(staff);
      const at = deps.clock.now(),
        all = await tx.dramaPriceRevision.findMany({
          where: query.dramaId ? { dramaId: query.dramaId } : {},
          orderBy:
            query.sort === "-createdAt"
              ? [{ createdAt: "desc" }, { id: "asc" }]
              : [{ effectiveAt: "desc" }, { id: "asc" }],
        });
      const rows = all.filter((v) => !query.state || query.state.includes(revisionState(v, at)));
      return {
        items: await Promise.all(
          rows
            .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
            .map((v) => revisionView(tx, deps, v, at, staff)),
        ),
        page: query.page,
        pageSize: query.pageSize,
        total: rows.length,
      };
    },
    async tiers(tx: Tx, staff: StaffContext) {
      readAccess(staff);
      const at = deps.clock.now(),
        [tiers, rows] = await Promise.all([currentTiers(tx, at), priceRows(tx, deps, staff, at)]),
        briefs = await deps.staffBriefs(
          tx,
          tiers.flatMap((v) => (v.createdByStaffId ? [v.createdByStaffId] : [])),
        );
      return PriceTierListSchema.parse({
        items: tiers.map((v) => ({
          priceTierRevisionId: v.id,
          tier: v.tier,
          points: v.points,
          effectiveAt: v.effectiveAt.toISOString(),
          batchId: v.batchId,
          createdBy: v.createdByStaffId
            ? (briefs.find((b) => b.staffId === v.createdByStaffId) ?? null)
            : null,
          createdAt: v.createdAt.toISOString(),
          dramaCount: rows.filter((r) => !r.archivedAt && r.heatTier === v.tier).length,
          templateDramaCount: rows.filter(
            (r) => !r.archivedAt && r.heatTier === v.tier && r.priceMode === "template",
          ).length,
        })),
      });
    },
    async create(
      tx: Tx,
      staff: StaffContext,
      ctx: EmitContext,
      id: string,
      raw: DramaPriceCreateBody,
    ) {
      writeAccess(staff, ctx);
      const parsed = DramaPriceCreateBodySchema.safeParse(raw);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      const input = parsed.data;
      await serial(tx, id);
      const now = deps.clock.now(),
        row = (await priceRows(tx, deps, staff, now, [id]))[0];
      if (!row) throw new AppError("NOT_FOUND");
      if (row.priceLockReason)
        throw new AppError("DRAMA_PRICE_LOCKED", {
          details: { reason: row.priceLockReason, stopOrderDate: row.stopOrderDate },
        });
      if (input.confirm.currentPoints !== row.listPricePoints)
        throw new AppError("CONFIRM_MISMATCH");
      if (input.effectiveDate && input.effectiveDate < addDays(calendarDate(now), 1))
        throw new AppError("VALIDATION_FAILED");
      const effectiveAt = input.effectiveDate ? dayRange(input.effectiveDate).start : now;
      if (input.mode === "template" && !row.heatTier) throw new AppError("HEAT_TIER_MISSING");
      const tiers = input.mode === "template" ? await currentTiers(tx, effectiveAt) : [],
        newPoints =
          input.mode === "custom"
            ? input.customPoints!
            : tiers.find((v) => v.tier === row.heatTier)?.points;
      if (newPoints === undefined) throw new AppError("HEAT_TIER_MISSING");
      if (newPoints === row.listPricePoints)
        throw new AppError("DRAMA_PRICE_UNCHANGED", {
          details: { currentPoints: row.listPricePoints },
        });
      const existing = await tx.dramaPriceRevision.findFirst({
        where: { dramaId: id, effectiveAt, cancelledAt: null },
      });
      if (existing)
        throw new AppError("DRAMA_PRICE_EFFECTIVE_AT_TAKEN", {
          details: { dramaPriceRevisionId: existing.id },
        });
      const revision = await tx.dramaPriceRevision.create({
        data: {
          id: uuidv7(),
          dramaId: id,
          mode: input.mode,
          customPoints: input.mode === "custom" ? input.customPoints! : null,
          prevPoints: row.listPricePoints,
          newPoints,
          effectiveAt,
          reasonCode: input.reasonCode,
          note: input.note ?? null,
          createdByStaffId: staff.staff.id,
          createdAt: now,
        },
      });
      if (effectiveAt > now)
        await deps.timers.arm(tx, {
          kind: "pricing.drama_price_effective",
          subject: { type: "drama_price_revision", id: revision.id },
          fireAt: effectiveAt,
          key: keyOf(revision.id),
        });
      else await changed(tx, ctx, id, revision.id, "revision", effectiveAt);
      await audit(
        tx,
        ctx,
        revision.id,
        "pricing.drama.revise",
        { points: row.listPricePoints },
        revision,
        input.note ?? undefined,
      );
      return {
        revision: await revisionView(tx, deps, revision, now, staff),
        price: (await priceRows(tx, deps, staff, now, [id]))[0]!,
      };
    },
    async withdraw(tx: Tx, staff: StaffContext, ctx: EmitContext, id: string, raw: unknown) {
      writeAccess(staff, ctx);
      const parsed = DramaPriceNoteBodySchema.safeParse(raw);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      const initial = await tx.dramaPriceRevision.findUnique({ where: { id } });
      if (!initial) throw new AppError("NOT_FOUND");
      await serial(tx, initial.dramaId);
      await tx.$queryRaw`SELECT id FROM drama_price_revision WHERE id=${id}::uuid FOR UPDATE`;
      const row = await tx.dramaPriceRevision.findUniqueOrThrow({ where: { id } }),
        now = deps.clock.now();
      if (row.cancelledAt || row.effectiveAt <= now)
        throw new AppError("REVISION_ALREADY_EFFECTIVE", {
          details: {
            effectiveAt: row.effectiveAt.toISOString(),
            cancelledAt: row.cancelledAt?.toISOString() ?? null,
          },
        });
      const after = await tx.dramaPriceRevision.update({
        where: { id },
        data: { cancelledAt: now },
      });
      await deps.timers.cancel(tx, {
        subject: { type: "drama_price_revision", id },
        kinds: ["pricing.drama_price_effective"],
      });
      await audit(tx, ctx, id, "pricing.drama.withdraw", row, after, parsed.data.note ?? undefined);
      return revisionView(tx, deps, after, now, staff);
    },
    async effective(tx: Tx, timer: FiredTimer) {
      if (timer.subjectType !== "drama_price_revision" || !timer.subjectId)
        return "skipped" as const;
      const first = await tx.dramaPriceRevision.findUnique({ where: { id: timer.subjectId } });
      if (!first) return "skipped" as const;
      await serial(tx, first.dramaId);
      await tx.$queryRaw`SELECT id FROM drama_price_revision WHERE id=${first.id}::uuid FOR UPDATE`;
      const row = await tx.dramaPriceRevision.findUniqueOrThrow({ where: { id: first.id } }),
        stored = await tx.timer.findUniqueOrThrow({ where: { id: timer.id } });
      if (
        row.cancelledAt ||
        row.effectiveAt > deps.clock.now() ||
        stored.dedupeKey !== keyOf(row.id)
      )
        return "skipped" as const;
      await changed(
        tx,
        createIdentityContext({ actor: { type: "system", job: "pricing.drama_price_effective" } }),
        row.dramaId,
        row.id,
        "revision",
        row.effectiveAt,
        `tmr:${stored.dedupeKey}`,
      );
      return "fired" as const;
    },
    async onTierChanged(tx: Tx, event: DeliveredEvent) {
      const parsed = EVENT_PAYLOAD_SCHEMAS["drama.tier_changed"].safeParse(event.payload);
      if (!parsed.success) throw new TypeError("等级变更事件载荷不合法");
      const input = parsed.data;
      await serial(tx, input.dramaId);
      const row = await tx.drama.findUnique({ where: { id: input.dramaId } });
      if (!row) return;
      const source = await tx.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }),
        at = source.occurredAt;
      const revisions = await tx.dramaPriceRevision.findFirst({
        where: { dramaId: row.id, effectiveAt: { lte: at }, cancelledAt: null },
        orderBy: { effectiveAt: "desc" },
      });
      if (revisions?.mode === "custom") return;
      const tiers = await currentTiers(tx, at),
        old = tiers.find((v) => v.tier === input.fromTier)?.points ?? null,
        next = tiers.find((v) => v.tier === input.toTier)?.points ?? null;
      if (old === next) return;
      await changed(
        tx,
        createIdentityContext({ actor: { type: "system", job: "drama.tier_changed" } }),
        row.id,
        null,
        "tier_change",
        at,
        `pricing.drama_price_changed:tier_change:${event.id}`,
      );
    },
  };
}
export type DramaPricingService = ReturnType<typeof createDramaPricing>;
