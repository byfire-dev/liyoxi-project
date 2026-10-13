import {
  BILLING_PARAM_KEY,
  BILLING_PARAM_VALUES,
  NOTICE_REQUIRED_KEYS,
  HEAT_TIER,
  BillingParamListSchema,
  BillingParamViewSchema,
  BillingParamWithdrawBodySchema,
  PricingChangeCreateBodySchema,
  PricingChangePageSchema,
  PricingChangeRecordSchema,
  z,
} from "@liyoxi/contract";
import type { BillingParams, PricingChangeQuery, StaffBrief } from "@liyoxi/contract";
import type { BillingParam } from "@liyoxi/db";
import { addDays, calendarDate, dayRange } from "@liyoxi/shared/time";
import { record } from "../../audit/index.js";
import { assertAccess, hasPermission } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import type { Notices } from "../../config/index.js";
import type { readTemplatePriceCandidates } from "../../content/index.js";
import type { Events } from "../../events/index.js";
import { AppError, uuidv7 } from "../../kernel/index.js";
import type { Clock, IdempotencyContext, Tx, TxRunner } from "../../kernel/index.js";
import type { PlanAdminActor } from "../catalog/plans-admin.js";
import { BILLING_PARAM_SEEDS } from "../seed-data.js";
import { paramsAt, priceAt } from "./index.js";
import { currentTiers } from "./admin-read.js";
type Key = keyof BillingParams;
const needsNotice = (key: Key) => NOTICE_REQUIRED_KEYS.some((k) => k === key);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function keyOf(key: string): Key {
  const found = BILLING_PARAM_KEY.values.find((k) => k === key);
  if (!found) throw new TypeError("计费参数键未登记");
  return found;
}
function earliest(at: Date, days: number) {
  let date = addDays(calendarDate(at), days);
  if (dayRange(date).start.getTime() < at.getTime() + days * 86_400_000) date = addDays(date, 1);
  return date;
}
function invalid(path: string, message: string): never {
  throw new AppError("VALIDATION_FAILED", { details: { fieldErrors: [{ path, message }] } });
}
export function createParameterChanges(deps: {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly notices: Notices;
  readonly events: Pick<Events, "emit">;
  readonly candidates: typeof readTemplatePriceCandidates;
  readonly staffBriefs: (tx: Tx, ids: readonly string[]) => Promise<StaffBrief[]>;
}) {
  function access(
    staff: StaffContext,
    permission: "billing.price.edit" | "billing.param.edit" | null = null,
  ) {
    assertAccess(staff, { module: { module: "billing", need: "view" }, permission });
  }
  function actorAccess(actor: PlanAdminActor) {
    access(actor.staff);
    if (
      actor.identity.actor.type !== "staff" ||
      actor.identity.actor.id !== actor.staff.staff.id ||
      actor.identity.entityId !== null ||
      actor.identity.storeId !== null
    )
      throw new AppError("PERMISSION_DENIED");
  }
  async function serial(tx: Tx) {
    // 复用价目目录锁；参数、模板价与上架/价目创建共同串行，不能只锁本次参数键。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('billing.plan_catalog',0))`;
  }
  async function person(tx: Tx, id: string | null) {
    if (!id) return null;
    const found = (await deps.staffBriefs(tx, [id])).find((p) => p.staffId === id);
    if (!found) throw new TypeError("计价修订缺少真实员工引用");
    return found;
  }
  async function currentRow(tx: Tx, key: Key, at: Date) {
    return tx.billingParam.findFirstOrThrow({
      where: { key, cancelledAt: null, effectiveAt: { lte: at } },
      orderBy: { effectiveAt: "desc" },
    });
  }
  async function paramView(tx: Tx, staff: StaffContext, key: Key, at: Date) {
    const current = await currentRow(tx, key, at),
      pending = await tx.billingParam.findFirst({
        where: { key, cancelledAt: null, effectiveAt: { gt: at } },
        orderBy: { effectiveAt: "asc" },
      }),
      schema = z.toJSONSchema(BILLING_PARAM_VALUES[key]);
    const fields = async (row: BillingParam) => ({
      billingParamId: row.id,
      value: BILLING_PARAM_VALUES[key].parse(row.value),
      effectiveAt: row.effectiveAt.toISOString(),
      changeId: row.changeId,
      createdBy: await person(tx, row.createdByStaffId),
    });
    return BillingParamViewSchema.parse({
      key,
      needsNotice: needsNotice(key),
      schema: {
        type:
          schema.type === "array"
            ? "integer_list"
            : schema.type === "object"
              ? "object"
              : "integer",
        ...(typeof schema.minimum === "number" ? { min: schema.minimum } : {}),
        ...(typeof schema.maximum === "number" ? { max: schema.maximum } : {}),
        ...(schema.properties ? { subKeys: schema.properties } : {}),
      },
      defaultValue: BILLING_PARAM_VALUES[key].parse(BILLING_PARAM_SEEDS[key]),
      current: await fields(current),
      pending: pending ? { ...(await fields(pending)), siteNoticeId: pending.siteNoticeId } : null,
      actions: pending && hasPermission(staff, "billing.param.edit") ? ["withdraw"] : [],
    });
  }
  async function recordView(tx: Tx, id: string, now: Date) {
    const [tiers, params] = await Promise.all([
      tx.priceTierRevision.findMany({ where: { batchId: id }, orderBy: { tier: "asc" } }),
      tx.billingParam.findMany({
        where: { changeId: id },
        include: { siteNotice: true },
        orderBy: { key: "asc" },
      }),
    ]);
    const rows = [...tiers, ...params];
    if (!rows.length) throw new AppError("NOT_FOUND");
    const notice = params.find((p) => p.siteNotice)?.siteNotice ?? null,
      staffId = rows.find((p) => p.createdByStaffId)?.createdByStaffId ?? null,
      audit = params.length
        ? null
        : await tx.auditLog.findFirst({
            where: {
              targetType: "price_tier_revision",
              meta: { path: ["changeSetId"], equals: id },
            },
            orderBy: { seq: "desc" },
          }),
      meta = audit?.meta,
      note = params.length
        ? params[0]!.note
        : meta && typeof meta === "object" && !Array.isArray(meta) && typeof meta.note === "string"
          ? meta.note
          : null;
    const tierItems = await Promise.all(
      tiers.map(async (row) => ({
        priceTierRevisionId: row.id,
        tier: row.tier,
        points: row.points,
        effectiveAt: row.effectiveAt.toISOString(),
        previousPoints:
          (
            await tx.priceTierRevision.findFirst({
              where: { tier: row.tier, effectiveAt: { lt: row.effectiveAt } },
              orderBy: { effectiveAt: "desc" },
            })
          )?.points ?? null,
      })),
    );
    const paramItems = await Promise.all(
      params.map(async (row) => {
        const key = keyOf(row.key),
          prior = await tx.billingParam.findFirst({
            where: { key, cancelledAt: null, effectiveAt: { lt: row.effectiveAt } },
            orderBy: { effectiveAt: "desc" },
          }),
          current = await currentRow(tx, key, now);
        return {
          billingParamId: row.id,
          key,
          value: BILLING_PARAM_VALUES[key].parse(row.value),
          previousValue: prior ? BILLING_PARAM_VALUES[key].parse(prior.value) : null,
          effectiveAt: row.effectiveAt.toISOString(),
          status: row.cancelledAt
            ? "cancelled"
            : row.effectiveAt > now
              ? "pending"
              : row.id === current.id
                ? "effective"
                : "superseded",
        };
      }),
    );
    return PricingChangeRecordSchema.parse({
      changeSetId: id,
      createdAt: new Date(Math.min(...rows.map((r) => r.createdAt.getTime()))).toISOString(),
      createdBy: await person(tx, staffId),
      note,
      tierItems,
      paramItems,
      notice: notice
        ? {
            siteNoticeId: notice.id,
            title: notice.title,
            status: notice.status,
            effectiveAt: notice.effectiveAt.toISOString(),
          }
        : null,
      summaryText: [
        ...tierItems.map((r) => `${r.tier}模板积分 ${r.previousPoints ?? "无"} → ${r.points}`),
        ...paramItems.map(
          (r) =>
            `${r.key} ${JSON.stringify(r.previousValue)} → ${JSON.stringify(r.value)}，${calendarDate(new Date(r.effectiveAt))}起生效`,
        ),
      ].join("；"),
    });
  }
  async function audit(
    tx: Tx,
    actor: PlanAdminActor,
    target: { type: "billing_param" | "price_tier_revision"; id: string },
    before: object,
    after: object,
    id: string,
    note?: string,
    withdraw = false,
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
        category: target.type === "billing_param" ? "param" : "price_adjust",
        action:
          target.type === "price_tier_revision"
            ? "pricing.tier.update"
            : withdraw
              ? "billing.param.withdraw"
              : "billing.param.change",
        summary: withdraw ? "撤回计费参数" : "保存积分价模板与参数",
        target,
        before,
        after,
        fields: Object.keys(after),
        meta: { changeSetId: id, note: note ?? null },
      },
    );
  }
  async function checkCycles(tx: Tx, cycles: readonly number[], now: Date, path: string) {
    const plans = await tx.plan.findMany({
      where: { isListed: true },
      include: {
        planRevisions: { where: { cancelledAt: null }, orderBy: { effectiveAt: "desc" } },
      },
    });
    for (const plan of plans) {
      const current = plan.planRevisions.find((r) => r.effectiveAt <= now),
        rows = [
          ...(current ? [current] : []),
          ...plan.planRevisions.filter((r) => r.effectiveAt > now),
        ];
      if (
        !current ||
        rows.some((r) =>
          cycles.some((m) => {
            const n = (r.cyclePrices as Record<string, unknown>)[String(m)];
            return !Number.isSafeInteger(n) || Number(n) <= 0;
          }),
        )
      )
        invalid(path, `上架套餐${plan.name}的当前或待生效价目缺少启用周期价格`);
    }
  }
  return {
    list(staff: StaffContext) {
      access(staff);
      return deps.tx.run(async (tx) => {
        const now = deps.clock.now(),
          params = await paramsAt(tx, now);
        return BillingParamListSchema.parse({
          items: await Promise.all(
            BILLING_PARAM_KEY.values.map((key) => paramView(tx, staff, key, now)),
          ),
          noticeDays: params.noticeDays,
          earliestNoticedEffectiveDate: earliest(now, params.noticeDays),
        });
      });
    },
    changes(staff: StaffContext, query: PricingChangeQuery) {
      access(staff);
      return deps.tx.run(async (tx) => {
        const from = query.createdFrom ? dayRange(query.createdFrom).start : null,
          until = query.createdTo ? dayRange(query.createdTo).end : null;
        const groups = await tx.$queryRaw<{ id: string; total: number }[]>`
          WITH items AS (SELECT batch_id AS id,created_at,'price_tier' AS kind,NULL::text AS key FROM price_tier_revision
            UNION ALL SELECT change_id AS id,created_at,'billing_param' AS kind,key FROM billing_param),
          groups AS (SELECT id,min(created_at) AS at FROM items GROUP BY id
            HAVING (${query.kind ?? null}::text IS NULL OR bool_or(kind=${query.kind ?? null}))
              AND (${query.key ?? null}::text IS NULL OR bool_or(key=${query.key ?? null})))
          SELECT id::text,count(*) OVER()::int AS total FROM groups
            WHERE (${from}::timestamptz IS NULL OR at>=${from}) AND (${until}::timestamptz IS NULL OR at<${until})
            ORDER BY at DESC,id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
        // 空页仍须返回过滤后的真实总量，不能把越界页误报为0。
        const count =
          groups[0]?.total ??
          (
            await tx.$queryRaw<{ total: number }[]>`
          WITH items AS (SELECT batch_id AS id,created_at,'price_tier' AS kind,NULL::text AS key FROM price_tier_revision
            UNION ALL SELECT change_id AS id,created_at,'billing_param' AS kind,key FROM billing_param),
          groups AS (SELECT id,min(created_at) AS at FROM items GROUP BY id
            HAVING (${query.kind ?? null}::text IS NULL OR bool_or(kind=${query.kind ?? null}))
              AND (${query.key ?? null}::text IS NULL OR bool_or(key=${query.key ?? null})))
          SELECT count(*)::int AS total FROM groups WHERE (${from}::timestamptz IS NULL OR at>=${from}) AND (${until}::timestamptz IS NULL OR at<${until})`
          )[0]!.total;
        const now = deps.clock.now();
        return PricingChangePageSchema.parse({
          items: await Promise.all(groups.map((g) => recordView(tx, g.id, now))),
          page: query.page,
          pageSize: query.pageSize,
          total: count,
        });
      });
    },
    create(actor: PlanAdminActor, raw: unknown, options: { idem?: IdempotencyContext } = {}) {
      actorAccess(actor);
      const body = PricingChangeCreateBodySchema.safeParse(raw);
      if (!body.success) throw new AppError("VALIDATION_FAILED");
      const input = body.data;
      if (input.tiers) access(actor.staff, "billing.price.edit");
      if (input.params) access(actor.staff, "billing.param.edit");
      return deps.tx.run(async (tx) => {
        await serial(tx);
        const now = deps.clock.now(),
          current = await paramsAt(tx, now),
          tiers = await currentTiers(tx, now),
          changedTiers = HEAT_TIER.values.filter(
            (tier) =>
              input.tiers && input.tiers[tier] !== tiers.find((r) => r.tier === tier)?.points,
          );
        const changed = (input.params ?? []).flatMap((item, index) => {
          const value = BILLING_PARAM_VALUES[item.key].parse(item.value);
          if (item.key === "noticeDays") {
            try {
              earliest(now, BILLING_PARAM_VALUES.noticeDays.parse(value));
            } catch {
              invalid(`params.${index}.value`, "公告天数超出可表示的生效日期");
            }
          }
          if (item.key === "cancelDeductionBp") {
            const v = BILLING_PARAM_VALUES.cancelDeductionBp.parse(value),
              stages = [v.planConfirm, v.adAndSample, v.samplePending, v.postSample].filter(
                (n): n is number => n !== null,
              );
            if (stages.some((n, i) => i > 0 && n < stages[i - 1]!))
              invalid(`params.${index}.value`, "非空取消扣除档须随阶段不递减");
          }
          if (
            (item.key === "enabledCycles" || item.key === "renewalReminderDays") &&
            Array.isArray(value) &&
            new Set(value).size !== value.length
          )
            invalid(`params.${index}.value`, "列表不得重复");
          return equal(value, current[item.key])
            ? []
            : [{ key: item.key, value, index, effectiveDate: item.effectiveDate }];
        });
        if (!changed.length && !changedTiers.length) throw new AppError("CHANGESET_EMPTY");
        const pending = await tx.billingParam.findMany({
          where: {
            key: { in: changed.map((r) => r.key) },
            cancelledAt: null,
            effectiveAt: { gt: now },
          },
        });
        if (pending.length)
          throw new AppError("PARAM_PENDING_EXISTS", {
            details: {
              items: pending.map((r) => ({
                key: r.key,
                billingParamId: r.id,
                effectiveAt: r.effectiveAt.toISOString(),
              })),
            },
          });
        const firstDate = earliest(now, current.noticeDays),
          scheduled = changed.map((item) => {
            const noticed = needsNotice(item.key),
              date = noticed ? (item.effectiveDate ?? firstDate) : item.effectiveDate;
            if (noticed && date! < firstDate)
              throw new AppError("NOTICE_PERIOD_REQUIRED", {
                details: {
                  earliestEffectiveDate: firstDate,
                  keys: changed.filter((r) => needsNotice(r.key)).map((r) => r.key),
                },
              });
            const effectiveAt = date ? dayRange(date).start : now;
            if (effectiveAt < now)
              invalid(
                `params.${item.index}.effectiveDate`,
                "生效日不能早于保存时刻；立即生效请不传日期",
              );
            return { ...item, noticed, effectiveAt };
          }),
          noticed = scheduled.filter((r) => r.noticed);
        if (new Set(noticed.map((r) => r.effectiveAt.getTime())).size > 1)
          invalid("params", "需公告的参数须同日生效");
        for (const item of scheduled) {
          if (item.key === "enabledCycles")
            await checkCycles(
              tx,
              BILLING_PARAM_VALUES.enabledCycles.parse(item.value),
              now,
              `params.${item.index}.value`,
            );
          if (
            await tx.billingParam.findFirst({
              where: { key: item.key, cancelledAt: null, effectiveAt: item.effectiveAt },
            })
          )
            invalid(`params.${item.index}.effectiveDate`, "同一生效时刻已有修订，请稍后重试");
        }
        for (const tier of changedTiers)
          if (tiers.find((r) => r.tier === tier)?.effectiveAt.getTime() === now.getTime())
            invalid("tiers", "同一生效时刻已有模板价，请稍后重试");
        const id = uuidv7(),
          candidateRows = changedTiers.length ? await deps.candidates(tx, changedTiers) : [],
          ids = candidateRows.map((r) => r.id),
          beforePrices = await priceAt(tx, ids, now);
        let siteNoticeId: string | null = null;
        if (noticed.length) {
          const names = noticed.map((r) => r.key).join("、"),
            suffix = `；${calendarDate(noticed[0]!.effectiveAt)}起生效`,
            clip = (s: string, max: number) => [...s].slice(0, max).join("");
          siteNoticeId = (
            await deps.notices.announce(tx, actor.identity, {
              kind: "billing_param",
              refId: id,
              effectiveAt: noticed[0]!.effectiveAt,
              title: input.notice?.title ?? "积分计费规则调整",
              summary:
                input.notice?.summary ??
                clip(
                  noticed
                    .map(
                      (r) =>
                        `${r.key} ${JSON.stringify(current[r.key])} → ${JSON.stringify(r.value)}`,
                    )
                    .join("；"),
                  200 - [...suffix].length,
                ) + suffix,
              summaryNoPrice:
                input.notice?.summaryNoPrice ??
                clip(`${names}规则调整`, 200 - [...suffix].length) + suffix,
              barEnabled: input.notice?.isBarEnabled ?? true,
              createdByStaffId: actor.staff.staff.id,
              link: { route: "billing.params", params: { changeSetId: id } },
            })
          ).siteNoticeId;
        }
        for (const item of scheduled) {
          const row = await tx.billingParam.create({
            data: {
              id: uuidv7(),
              key: item.key,
              value: item.value,
              effectiveAt: item.effectiveAt,
              changeId: id,
              note: input.note ?? null,
              siteNoticeId: item.noticed ? siteNoticeId : null,
              createdByStaffId: actor.staff.staff.id,
              createdAt: now,
            },
          });
          if (item.effectiveAt > now)
            await deps.events.emit(tx, actor.identity, {
              type: "billing.param_change_scheduled",
              aggregate: { type: "billing_param", id: row.id },
              payload: {
                v: 1,
                billingParamId: row.id,
                changeId: id,
                paramKey: item.key,
                effectiveAt: item.effectiveAt.toISOString(),
              },
            });
          await audit(
            tx,
            actor,
            { type: "billing_param", id: item.key },
            { value: current[item.key] },
            { value: item.value, effectiveAt: item.effectiveAt.toISOString() },
            id,
            input.note,
          );
        }
        const inserted = [];
        for (const tier of changedTiers)
          inserted.push(
            await tx.priceTierRevision.create({
              data: {
                id: uuidv7(),
                tier,
                points: input.tiers![tier],
                effectiveAt: now,
                batchId: id,
                createdByStaffId: actor.staff.staff.id,
                createdAt: now,
              },
            }),
          );
        if (inserted.length) {
          const before = Object.fromEntries(
              changedTiers.map((t) => [t, tiers.find((r) => r.tier === t)?.points ?? null]),
            ),
            after = Object.fromEntries(inserted.map((r) => [r.tier, r.points]));
          await audit(
            tx,
            actor,
            { type: "price_tier_revision", id: inserted[0]!.id },
            before,
            after,
            id,
            input.note,
          );
          const afterPrices = await priceAt(tx, ids, now);
          for (const dramaId of ids) {
            const before = beforePrices.get(dramaId),
              after = afterPrices.get(dramaId);
            if (
              typeof before !== "object" ||
              typeof after !== "object" ||
              after.source.mode !== "template" ||
              before.points === after.points
            )
              continue;
            await deps.events.emit(tx, actor.identity, {
              type: "pricing.drama_price_changed",
              aggregate: { type: "drama", id: dramaId },
              payload: {
                v: 1,
                dramaId,
                dramaPriceRevisionId: null,
                cause: "tier_template",
                effectiveAt: now.toISOString(),
              },
            });
          }
        }
        return recordView(tx, id, now);
      }, options);
    },
    withdraw(
      actor: PlanAdminActor,
      id: string,
      raw: unknown,
      options: { idem?: IdempotencyContext } = {},
    ) {
      actorAccess(actor);
      access(actor.staff, "billing.param.edit");
      const body = BillingParamWithdrawBodySchema.safeParse(raw);
      if (!body.success) throw new AppError("VALIDATION_FAILED");
      return deps.tx.run(async (tx) => {
        await serial(tx);
        const row = await tx.billingParam.findUnique({ where: { id } }),
          now = deps.clock.now();
        if (!row) throw new AppError("NOT_FOUND");
        if (row.cancelledAt || row.effectiveAt <= now)
          throw new AppError("REVISION_ALREADY_EFFECTIVE", {
            details: {
              effectiveAt: row.effectiveAt.toISOString(),
              cancelledAt: row.cancelledAt?.toISOString() ?? null,
            },
          });
        if (
          body.data.confirm.key !== row.key ||
          new Date(body.data.confirm.effectiveAt).getTime() !== row.effectiveAt.getTime()
        )
          throw new AppError("CONFIRM_MISMATCH");
        await tx.billingParam.update({ where: { id }, data: { cancelledAt: now } });
        if (
          row.siteNoticeId &&
          !(await tx.billingParam.count({
            where: { changeId: row.changeId, siteNoticeId: row.siteNoticeId, cancelledAt: null },
          }))
        )
          await deps.notices.withdraw(tx, actor.identity, {
            siteNoticeId: row.siteNoticeId,
            staffId: actor.staff.staff.id,
          });
        await audit(
          tx,
          actor,
          { type: "billing_param", id: row.key },
          { cancelledAt: null },
          { cancelledAt: now.toISOString() },
          row.changeId,
          body.data.note,
          true,
        );
        return paramView(tx, actor.staff, keyOf(row.key), now);
      }, options);
    },
  };
}
