import { beforeEach, expect, it, vi } from "vitest";
import { BILLING_PARAM_KEY, BILLING_PARAM_VALUES } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import {
  assembleForTest,
  createClock,
  createFactories,
  useSeededDatabase,
} from "../../testing/index.js";
import { buildStaffContext, normalizeRoleConfig } from "../../authz/index.js";
import { staffBriefs } from "../../staff/index.js";
import { createNotices } from "../../config/index.js";
import { readTemplatePriceCandidates } from "../../content/index.js";
import { createEvents } from "../../events/index.js";
import { createIdentityContext, createTxRunner, uuidv7 } from "../../kernel/index.js";
import { createPlanAdmin } from "../catalog/plans-admin.js";
import { BILLING_PARAM_SEEDS } from "../seed-data.js";
import { paramsAt, priceAt } from "./index.js";
import { quoteHold } from "./quote.js";
import { createParameterChanges } from "./parameter-changes.js";
const db = useSeededDatabase("services", { max: 2 });
beforeEach(() => db.reset(), 60000);
async function world() {
  const prisma = await db.prisma(),
    clock = createClock(),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    events = createEvents({ assembly: assembleForTest({ entry: "api" }), clock, tx }),
    notices = createNotices({ clock, events }),
    make = createFactories({ db: prisma, clock }),
    operator = await make.staff({ staffRoleKey: "super_admin" }),
    role = await prisma.staffRole.findUniqueOrThrow({ where: { key: "super_admin" } }),
    staff = buildStaffContext({
      staff: {
        id: operator.id,
        roleKey: "super_admin",
        isLead: operator.isLead,
        staffGroupId: operator.staffGroupId,
      },
      role: normalizeRoleConfig("super_admin", role),
      groupStaffIds: [],
      stepUpAt: clock.now(),
    }),
    identity = createIdentityContext({
      actor: { type: "staff", id: operator.id, client: "admin" },
    }),
    actor = { staff, identity },
    deps = { tx, clock, events, notices, staffBriefs, candidates: readTemplatePriceCandidates },
    service = createParameterChanges(deps),
    plans = createPlanAdmin(deps);
  // 初始种子允许与业务时钟相同；即时变更明确推进1ms，不改库约束或生产时间。
  clock.advance(1);
  return { prisma, clock, tx, events, notices, make, actor, deps, service, plans, operator };
}
const reject = (work: Promise<unknown>, error: string) =>
  expect(work).rejects.toMatchObject({ error });
const counts = async (h: Awaited<ReturnType<typeof world>>) => [
  await h.prisma.billingParam.count(),
  await h.prisma.priceTierRevision.count(),
  await h.prisma.siteNotice.count(),
  await h.prisma.outboxEvent.count(),
  await h.prisma.auditLog.count(),
];
const date = (h: Awaited<ReturnType<typeof world>>, days = 31) =>
  addDays(calendarDate(h.clock.now()), days);
const params = (...items: { key: string; value: unknown; effectiveDate?: string | null }[]) => ({
  params: items,
});

it("十二键canonical范围/默认/当前真值与GET零写；部分无权/非法键值整体拒绝", async () => {
  const h = await world(),
    before = await counts(h),
    list = await h.service.list(h.actor.staff);
  expect(list.items.map((r) => r.key)).toEqual([...BILLING_PARAM_KEY.values]);
  expect(list.earliestNoticedEffectiveDate).toBe(date(h));
  for (const row of list.items) {
    expect(row.current.value).toEqual(
      BILLING_PARAM_VALUES[row.key].parse(BILLING_PARAM_SEEDS[row.key]),
    );
    expect(row.defaultValue).toEqual(row.current.value);
    expect(row.pending).toBeNull();
  }
  expect(list.items.find((r) => r.key === "adUnitPoints")!.schema).toMatchObject({
    type: "integer",
    min: 1,
    max: 1000,
  });
  for (const permission of ["billing.price.edit", "billing.param.edit"] as const) {
    const actor = {
      ...h.actor,
      staff: {
        ...h.actor.staff,
        permissions: new Set([...h.actor.staff.permissions].filter((p) => p !== permission)),
      },
    };
    await reject(
      h.service.create(actor, {
        tiers: { S: 3100, A: 2000, B: 1600, C: 1000 },
        ...params({ key: "adUnitPoints", value: 60 }),
      }),
      "PERMISSION_DENIED",
    );
  }
  for (const raw of [
    params({ key: "bank_account", value: {} }),
    params({ key: "adUnitPoints", value: 1001 }),
    params({ key: "enabledCycles", value: [] }),
    params({ key: "noticeDays", value: Number.MAX_SAFE_INTEGER }),
    params({
      key: "cancelDeductionBp",
      value: {
        planConfirm: 3000,
        adAndSample: 1000,
        samplePending: 5000,
        postSample: null,
        adInProduction: 10000,
      },
    }),
    params({ key: "minLicenseMonths", value: 4 }, { key: "minLicenseMonths", value: 5 }),
    { tiers: { S: 100, A: 2000, B: 1600, C: 1000 } },
  ])
    await reject(h.service.create(h.actor, raw), "VALIDATION_FAILED");
  await reject(
    h.service.create(h.actor, params({ key: "adUnitPoints", value: 50 })),
    "CHANGESET_EMPTY",
  );
  expect(await counts(h)).toEqual(before);
});

it("同批参数/变化模板档/公告审计原子，实际template价差发一次而custom/旧冻结快照不变", async () => {
  const h = await world(),
    template = await h.make.drama({ heatTier: "S", status: "draft" }),
    custom = await h.make.drama({ heatTier: "S", status: "draft" }),
    unchanged = await h.make.drama({ heatTier: "A", status: "draft" });
  await h.prisma.dramaPriceRevision.create({
    data: {
      id: uuidv7(),
      dramaId: custom.id,
      mode: "custom",
      customPoints: 500,
      prevPoints: 3000,
      newPoints: 500,
      effectiveAt: h.clock.now(),
      reasonCode: "quality",
      createdByStaffId: h.operator.id,
      createdAt: h.clock.now(),
    },
  });
  const term = await h.make.subscriptionTerm(),
    snapshot = await h.tx.run((tx) =>
      quoteHold(
        tx,
        {
          id: term.id,
          planId: term.planId,
          planRevisionId: term.planRevisionId,
          discountBp: term.discountBp,
          productionModel: term.productionModel,
        },
        { kind: "drama", dramaId: template.id, topModel: false },
        h.clock.now(),
      ),
    ),
    hold = await h.make.pointHold({
      entityId: term.entityId,
      subscriptionTermId: term.id,
      pricingSnapshot: snapshot,
    });
  const result = await h.service.create(h.actor, {
    tiers: { S: 3100, A: 2000, B: 1600, C: 1000 },
    ...params({ key: "adUnitPoints", value: 60 }, { key: "minLicenseMonths", value: 4 }),
    note: "虚构同批变更",
  });
  expect(result.tierItems).toMatchObject([{ tier: "S", previousPoints: 3000, points: 3100 }]);
  expect(result.paramItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: "adUnitPoints", status: "pending", previousValue: 50 }),
      expect.objectContaining({ key: "minLicenseMonths", status: "effective", previousValue: 3 }),
    ]),
  );
  expect(result.notice).toMatchObject({ status: "announced" });
  expect(result.note).toBe("虚构同批变更");
  expect(
    (await h.prisma.billingParam.findMany({ where: { changeId: result.changeSetId } })).every(
      (r) => r.changeId === result.changeSetId,
    ),
  ).toBe(true);
  expect(await h.prisma.priceTierRevision.count({ where: { batchId: result.changeSetId } })).toBe(
    1,
  );
  expect(
    await h.prisma.auditLog.count({
      where: { meta: { path: ["changeSetId"], equals: result.changeSetId } },
    }),
  ).toBe(3);
  const prices = await priceAt(h.prisma, [template.id, custom.id, unchanged.id], h.clock.now());
  expect(prices.get(template.id)).toMatchObject({ points: 3100 });
  expect(prices.get(custom.id)).toMatchObject({ points: 500 });
  expect(prices.get(unchanged.id)).toMatchObject({ points: 2000 });
  const changed = await h.prisma.outboxEvent.findMany({
    where: { eventType: "pricing.drama_price_changed" },
  });
  expect(changed).toHaveLength(1);
  expect(changed[0]!.payload).toMatchObject({ dramaId: template.id, cause: "tier_template" });
  expect(await h.prisma.pointHold.findUniqueOrThrow({ where: { id: hold.id } })).toEqual(hold);
  expect(await h.prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: term.id } })).toEqual(
    term,
  );
});

it("完整公告期/同日守卫，两连接待生效竞争一胜，canonical在北京边界读新值且生效后拒撤", async () => {
  const h = await world(),
    input = params({ key: "adFreeRevisions", value: 3 });
  await reject(
    h.service.create(
      h.actor,
      params({ key: "adFreeRevisions", value: 3, effectiveDate: date(h, 30) }),
    ),
    "NOTICE_PERIOD_REQUIRED",
  );
  await reject(
    h.service.create(
      h.actor,
      params(
        { key: "adUnitPoints", value: 60, effectiveDate: date(h) },
        { key: "adFreeRevisions", value: 3, effectiveDate: date(h, 32) },
      ),
    ),
    "VALIDATION_FAILED",
  );
  const outcomes = await Promise.allSettled([
    h.service.create(h.actor, input),
    h.service.create(h.actor, input),
  ]);
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const failure = outcomes.find((r) => r.status === "rejected");
  expect(failure?.status === "rejected" ? failure.reason : null).toMatchObject({
    error: "PARAM_PENDING_EXISTS",
  });
  const success = outcomes.find((r) => r.status === "fulfilled");
  if (success?.status !== "fulfilled") throw new Error("缺少唯一成功变更集");
  const row = success.value.paramItems[0]!;
  expect(
    (await paramsAt(h.prisma, new Date(new Date(row.effectiveAt).getTime() - 1))).adFreeRevisions,
  ).toBe(2);
  h.clock.set(new Date(row.effectiveAt));
  expect((await paramsAt(h.prisma, h.clock.now())).adFreeRevisions).toBe(3);
  await reject(
    h.service.withdraw(h.actor, row.billingParamId, {
      confirm: { key: row.key, effectiveAt: row.effectiveAt },
    }),
    "REVISION_ALREADY_EFFECTIVE",
  );
  expect(
    await h.prisma.billingParam.count({
      where: {
        key: row.key,
        cancelledAt: null,
        effectiveAt: { gt: new Date("2026-01-05T04:00:00Z") },
      },
    }),
  ).toBe(1);
});

it("未来单键confirm/撤回一次，部分撤回保留共享公告，最后一键才撤并保留旧行", async () => {
  const h = await world(),
    result = await h.service.create(
      h.actor,
      params({ key: "adUnitPoints", value: 60 }, { key: "adFreeRevisions", value: 3 }),
    ),
    first = result.paramItems[0]!,
    second = result.paramItems[1]!;
  await reject(
    h.service.withdraw(h.actor, first.billingParamId, {
      confirm: { key: first.key, effectiveAt: h.clock.now().toISOString() },
    }),
    "CONFIRM_MISMATCH",
  );
  const withdrawal = (row: typeof first) =>
    h.service.withdraw(h.actor, row.billingParamId, {
      confirm: { key: row.key, effectiveAt: row.effectiveAt },
      note: "虚构撤回",
    });
  expect((await withdrawal(first)).pending).toBeNull();
  expect(
    await h.prisma.siteNotice.findUniqueOrThrow({ where: { id: result.notice!.siteNoticeId } }),
  ).toMatchObject({ status: "announced" });
  await reject(withdrawal(first), "REVISION_ALREADY_EFFECTIVE");
  await withdrawal(second);
  expect(
    await h.prisma.siteNotice.findUniqueOrThrow({ where: { id: result.notice!.siteNoticeId } }),
  ).toMatchObject({ status: "withdrawn" });
  expect(
    await h.prisma.outboxEvent.count({
      where: { eventType: "site_notice.withdrawn", aggregateId: result.notice!.siteNoticeId },
    }),
  ).toBe(1);
  expect(
    await h.prisma.billingParam.count({
      where: { changeId: result.changeSetId, cancelledAt: { not: null } },
    }),
  ).toBe(2);
  const rebuilt = await h.service.create(h.actor, params({ key: "adUnitPoints", value: 61 }));
  expect(rebuilt.changeSetId).not.toBe(result.changeSetId);
  expect(rebuilt.notice!.siteNoticeId).not.toBe(result.notice!.siteNoticeId);
});

it("启用周期核当前/待生效价格；此前下架缺价套餐与参数保存竞争不能双成功", async () => {
  const h = await world(),
    body = params({ key: "enabledCycles", value: [1, 3, 6, 12] });
  await reject(h.service.create(h.actor, body), "VALIDATION_FAILED");
  for (const p of await h.prisma.plan.findMany()) await h.plans.delist(h.actor, p.id);
  const makePlan = async (rank: number, includeSix: boolean) => {
    const p = await h.plans.create(h.actor, {
      code: `cycle_${rank}`,
      name: `虚构周期${rank}`,
      rank,
    });
    const fee = rank * 100_000 + 1_000_000;
    const revision = {
      monthlyFeeFen: fee,
      monthlyPoints: rank * 1000 + 10000,
      discountBp: 9000,
      productionModel: "advanced",
      maxStores: 3,
      maxMembers: 10,
      schedulePriority: "priority",
      hasMonthlyReport: true,
      effectiveDate: null,
      firstCyclePromo: false,
      cyclePrices: (includeSix ? [1, 3, 6, 12] : [1, 3, 12]).map((months) => ({
        months,
        priceFen: fee * months,
      })),
    };
    await h.plans.createRevision(h.actor, p.planId, revision);
    return { p, revision };
  };
  const a = await makePlan(10, true),
    b = await makePlan(11, false);
  await h.plans.shelve(h.actor, a.p.planId);
  const pending = await h.plans.createRevision(h.actor, a.p.planId, {
    ...a.revision,
    monthlyFeeFen: a.revision.monthlyFeeFen + 1000,
    monthlyPoints: a.revision.monthlyPoints + 10,
    effectiveDate: date(h),
    cyclePrices: a.revision.cyclePrices.filter((r) => r.months !== 6),
  });
  await reject(h.service.create(h.actor, body), "VALIDATION_FAILED");
  await h.plans.withdrawRevision(h.actor, pending.planRevisionId, {
    confirm: { planRevisionId: pending.planRevisionId, effectiveAt: pending.effectiveAt },
  });
  const enabled = await h.service.create(h.actor, body),
    row = enabled.paramItems[0]!;
  await reject(h.plans.shelve(h.actor, b.p.planId), "PLAN_REVISION_MISSING");
  await h.service.withdraw(h.actor, row.billingParamId, {
    confirm: { key: row.key, effectiveAt: row.effectiveAt },
  });
  const race = await Promise.allSettled([
    h.service.create(h.actor, body),
    h.plans.shelve(h.actor, b.p.planId),
  ]);
  expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const failed = race.find((r) => r.status === "rejected");
  expect(failed?.status === "rejected" ? failed.reason.error : null).toMatch(
    /^(VALIDATION_FAILED|PLAN_REVISION_MISSING)$/,
  );
});

it("真实写后事件故障整批回滚；恢复后混合历史同筛选分页/前值/说明，空越界页保留总量", async () => {
  const h = await world();
  await h.make.drama({ heatTier: "S", status: "draft" });
  const input = {
      tiers: { S: 3100, A: 2000, B: 1600, C: 1000 },
      ...params({ key: "adUnitPoints", value: 60 }),
      note: "虚构回滚变更",
    },
    before = await counts(h),
    original = h.events.emit.bind(h.events),
    spy = vi.spyOn(h.events, "emit").mockImplementation(async (tx, ctx, event) => {
      const result = await original(tx, ctx, event);
      if (event.type === "pricing.drama_price_changed")
        throw new Error("lyxtest: 最后价格事件写后失败");
      return result;
    });
  try {
    await expect(h.service.create(h.actor, input)).rejects.toThrow("最后价格事件");
  } finally {
    spy.mockRestore();
  }
  expect(await counts(h)).toEqual(before);
  const result = await h.service.create(h.actor, input),
    q = {
      kind: "price_tier" as const,
      key: "adUnitPoints" as const,
      createdFrom: calendarDate(h.clock.now()),
      createdTo: calendarDate(h.clock.now()),
      page: 1,
      pageSize: 1,
    };
  const list = await h.service.changes(h.actor.staff, q);
  expect(list.total).toBe(1);
  expect(list.items[0]).toEqual(result);
  expect(await h.service.changes(h.actor.staff, { ...q, page: 2 })).toEqual({
    items: [],
    page: 2,
    pageSize: 1,
    total: 1,
  });
  const current = await h.service.list(h.actor.staff);
  expect(current.items.find((r) => r.key === "adUnitPoints")!.pending).toMatchObject({
    value: 60,
    changeId: result.changeSetId,
  });
});
