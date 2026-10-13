// W4-07: "admin.plan.create", "admin.plan.planRevision.create", "admin.planRevision.list",
// "admin.planRevision.withdraw", "admin.plan.summary". 本轮七组，独立于已验旧四接口矩阵。
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  PlanAdminColumnSchema,
  PlanAdminListSchema,
  PlanRevisionPageSchema,
  PlanRevisionViewSchema,
  PlanSummarySchema,
} from "@liyoxi/contract";
import type { PlanQuote, PlanRevisionCreateBody } from "@liyoxi/contract";
import {
  createIdentityContext,
  runSeed,
  security,
  seedPlaceholderFinanceConfig,
  uuidv7,
} from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { addDays, calendarDate, dayRange } from "@liyoxi/shared/time";
import { termDates } from "@liyoxi/shared/period";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import { merchantServicesOf } from "../src/merchant/services.js";

const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  admin: SignedInStaff,
  viewer: SignedInStaff,
  editor: SignedInStaff,
  peer = 0;
type Column = ReturnType<typeof PlanAdminColumnSchema.parse>;
type Revision = ReturnType<typeof PlanRevisionViewSchema.parse>;
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  make = createFactories({ db, clock: api.clock });
  admin = await signInAsStaff(db, { roleKey: "super_admin" });
  viewer = await signInAsStaff(db, { roleKey: "finance" });
  editor = await signInAsStaff(db, { roleKey: "editor" });
  const approver = await make.staff({ staffRoleKey: "finance", isLead: true });
  await seedPlaceholderFinanceConfig(
    {
      tx: api.runtime.tx,
      clock: api.clock,
      assembly: api.runtime.assembly,
      bizNo: api.runtime.bizNo,
      keyring: security.loadKeyring(api.runtime.env),
    },
    { proposerId: viewer.staff.id, approverId: approver.id },
  );
  await seedUserAgreements(h, api);
}, 120000);
const request = (path: string, method = "GET", json?: unknown, staff = admin, key?: string) =>
  api.request(`/api/v1${path}`, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { ...staff.headers, ...(key ? { "Idempotency-Key": key } : {}) },
    peer: `198.19.78.${++peer % 250}`,
  });
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
const baseFee = (rank: number) => (rank + 10) * 100_000;
function body(
  rank: number,
  overrides: Partial<PlanRevisionCreateBody> = {},
): PlanRevisionCreateBody {
  return {
    monthlyFeeFen: baseFee(rank),
    monthlyPoints: (rank + 10) * 1000,
    discountBp: 9000,
    productionModel: "advanced",
    maxStores: 3,
    maxMembers: 10,
    schedulePriority: "priority",
    hasMonthlyReport: true,
    effectiveDate: null,
    firstCyclePromo: false,
    ...overrides,
  };
}
const date = (days = 31) => addDays(calendarDate(api.clock.now()), days);
async function plan(rank: number) {
  return PlanAdminColumnSchema.parse(
    await data(
      await request(
        "/admin/plans",
        "POST",
        {
          code: `revision_${rank}`,
          name: `虚构版本${rank}`,
          rank,
        },
        admin,
        uuidv7(),
      ),
    ),
  );
}
async function revise(plan: Column, input: PlanRevisionCreateBody, key = uuidv7()) {
  return PlanRevisionViewSchema.parse(
    await data(
      await request(`/admin/plans/${plan.planId}/plan-revisions`, "POST", input, admin, key),
    ),
  );
}
async function history(plan: Column, suffix = "") {
  return PlanRevisionPageSchema.parse(
    await data(await request(`/admin/plan-revisions?planId=${plan.planId}${suffix}`)),
  );
}
const confirm = (row: Revision) => ({
  confirm: { planRevisionId: row.planRevisionId, effectiveAt: row.effectiveAt },
});
const withdraw = (row: Revision, key = uuidv7()) =>
  request(`/admin/plan-revisions/${row.planRevisionId}/withdraw`, "POST", confirm(row), admin, key);
const auditCount = (id: string, action: string) =>
  db.auditLog.count({ where: { targetId: id, action } });

describe("套餐价目公告链七组正式HTTP/隔离DB", { timeout: 30000 }, () => {
  it("新建权限/required/唯一约束与首价即时免公告，同键仅一业务事实", async () => {
    const input = { code: "revision_10", name: "  虚构版本10  ", rank: 10 },
      key = uuidv7();
    await error(
      await request("/admin/plans", "POST", input, viewer, uuidv7()),
      403,
      "PERMISSION_DENIED",
    );
    await error(await request("/admin/plans", "POST", input), 400, "IDEMPOTENCY_KEY_REQUIRED");
    await error(
      await request("/admin/plans/summary", "GET", undefined, editor),
      403,
      "PERMISSION_DENIED",
    );
    const draft = PlanAdminColumnSchema.parse(
      await data(await request("/admin/plans", "POST", input, admin, key)),
    );
    expect(draft).toMatchObject({
      name: "虚构版本10",
      isListed: false,
      current: null,
      pending: null,
      columnStatus: "draft",
    });
    expect(draft.actions).toContain("create-plan-revision");
    expect(await data(await request("/admin/plans", "POST", input, admin, key))).toEqual(draft);
    await error(
      await request("/admin/plans", "POST", { ...input, rank: 11 }, admin, uuidv7()),
      409,
      "PLAN_CODE_TAKEN",
    );
    await error(
      await request("/admin/plans", "POST", { ...input, code: "another_code" }, admin, uuidv7()),
      409,
      "PLAN_RANK_TAKEN",
    );
    const revisionBody = body(10, { notice: { title: "首价忽略", summary: "不会写公告" } }),
      revisionKey = uuidv7();
    const first = await revise(draft, revisionBody, revisionKey);
    expect(first).toMatchObject({
      revisionNo: 1,
      status: "effective",
      notice: null,
      effectiveAt: api.clock.now().toISOString(),
      createdBy: { staffId: admin.staff.id },
    });
    expect(first.cyclePrices).toEqual(
      [1, 3, 12].map((months) => ({ months, priceFen: baseFee(10) * months })),
    );
    expect(await revise(draft, revisionBody, revisionKey)).toEqual(first);
    expect(await auditCount(draft.planId, "billing.plan.create")).toBe(1);
    expect(await auditCount(first.planRevisionId, "billing.plan_revision.create")).toBe(1);
    expect(await db.siteNotice.count({ where: { refId: first.planRevisionId } })).toBe(0);
    expect(
      await db.outboxEvent.count({
        where: { aggregateId: first.planRevisionId, eventType: "billing.plan_revision_scheduled" },
      }),
    ).toBe(0);
    for (const [path, method, json] of [
      ["/admin/plans", "POST", input],
      ["/admin/plans/summary", "GET", undefined],
      [`/admin/plans/${draft.planId}/plan-revisions`, "POST", body(10)],
      ["/admin/plan-revisions", "GET", undefined],
      [`/admin/plan-revisions/${first.planRevisionId}/withdraw`, "POST", confirm(first)],
    ] as const)
      await error(
        await api.request(`/api/v1${path}`, {
          method,
          ...(json === undefined ? {} : { json }),
          peer: `198.19.78.${++peer % 250}`,
        }),
        401,
        "AUTH_REQUIRED",
      );
  });

  it("非首完整公告期、周期联合覆盖/重复/空变化与待生效并发一胜，公告/原事件同事务", async () => {
    const p = await plan(20),
      first = await revise(p, body(20));
    await error(
      await request(
        `/admin/plans/${p.planId}/plan-revisions`,
        "POST",
        body(20, { effectiveDate: date() }),
        admin,
        uuidv7(),
      ),
      400,
      "CHANGESET_EMPTY",
    );
    const next = body(20, {
      monthlyFeeFen: 3_020_000,
      monthlyPoints: 30200,
      effectiveDate: date(),
    });
    for (const effectiveDate of [null, date(30)]) {
      const response = await request(
        `/admin/plans/${p.planId}/plan-revisions`,
        "POST",
        { ...next, effectiveDate },
        admin,
        uuidv7(),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "NOTICE_PERIOD_REQUIRED",
        details: { earliestEffectiveDate: date() },
      });
    }
    const param = await db.billingParam.create({
      data: {
        id: uuidv7(),
        key: "enabledCycles",
        value: [1, 3, 6, 12],
        effectiveAt: dayRange(date(40)).start,
        changeId: uuidv7(),
        createdAt: api.clock.now(),
      },
    });
    await error(
      await request(
        `/admin/plans/${p.planId}/plan-revisions`,
        "POST",
        {
          ...next,
          cyclePrices: [1, 3, 12].map((months) => ({
            months,
            priceFen: next.monthlyFeeFen * months,
          })),
        },
        admin,
        uuidv7(),
      ),
      400,
      "VALIDATION_FAILED",
    );
    await error(
      await request(
        `/admin/plans/${p.planId}/plan-revisions`,
        "POST",
        {
          ...next,
          cyclePrices: [
            { months: 1, priceFen: 1 },
            { months: 1, priceFen: 2 },
          ],
        },
        admin,
        uuidv7(),
      ),
      400,
      "VALIDATION_FAILED",
    );
    const results = await Promise.all(
      [1, 2].map(() =>
        request(`/admin/plans/${p.planId}/plan-revisions`, "POST", next, admin, uuidv7()),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await error(
      results.find((r) => r.status === 409)!,
      409,
      "REVISION_PENDING_EXISTS",
    );
    const row = PlanRevisionViewSchema.parse(await data(results.find((r) => r.status === 200)!));
    expect(row.cyclePrices.map((p) => p.months)).toEqual([1, 3, 6, 12]);
    expect(row.notice).toMatchObject({ status: "announced", leadDays: 30 });
    expect(row.notice!.summary).toContain("月费");
    expect(row.notice!.summaryNoPrice).not.toMatch(/[¥￥]|3,?020,?000|30200/);
    expect(await db.planRevision.count({ where: { planId: p.planId } })).toBe(2);
    expect(
      await db.outboxEvent.count({
        where: { aggregateId: row.planRevisionId, eventType: "billing.plan_revision_scheduled" },
      }),
    ).toBe(1);
    expect(
      await db.outboxEvent.count({
        where: { aggregateId: row.notice!.siteNoticeId, eventType: "site_notice.announced" },
      }),
    ).toBe(1);
    expect(await auditCount(row.planRevisionId, "billing.plan_revision.create")).toBe(1);
    expect(
      (await history(p)).items.find((r) => r.planRevisionId === first.planRevisionId)!.status,
    ).toBe("effective");
    // 这是后续参数写侧的明确夹具，当前片不声称参数API已实现；仅撤销测试自己建的待生效行。
    await db.billingParam.update({
      where: { id: param.id },
      data: { cancelledAt: api.clock.now() },
    });
  });

  it("撤回核confirm/有效时间，同键一审计撤公告，历史与记录分页保持且重建不复用序号", async () => {
    const p = await plan(30),
      first = await revise(p, body(30));
    const pending = await revise(
      p,
      body(30, { monthlyFeeFen: 4_020_000, monthlyPoints: 40200, effectiveDate: date() }),
    );
    await error(
      await request(
        `/admin/plan-revisions/${pending.planRevisionId}/withdraw`,
        "POST",
        { confirm: { ...confirm(pending).confirm, effectiveAt: first.effectiveAt } },
        admin,
        uuidv7(),
      ),
      409,
      "CONFIRM_MISMATCH",
    );
    await error(
      await request(
        `/admin/plan-revisions/${pending.planRevisionId}/withdraw`,
        "POST",
        confirm(pending),
        viewer,
        uuidv7(),
      ),
      403,
      "PERMISSION_DENIED",
    );
    const key = uuidv7(),
      cancelled = PlanRevisionViewSchema.parse(await data(await withdraw(pending, key)));
    expect(cancelled).toMatchObject({
      status: "cancelled",
      actions: [],
      notice: { status: "withdrawn" },
      cancelledAt: api.clock.now().toISOString(),
    });
    expect(await data(await withdraw(pending, key))).toEqual(cancelled);
    await error(await withdraw(pending), 409, "REVISION_ALREADY_EFFECTIVE");
    await error(await withdraw(first), 409, "REVISION_ALREADY_EFFECTIVE");
    expect(await auditCount(pending.planRevisionId, "billing.plan_revision.withdraw")).toBe(1);
    expect(
      await db.outboxEvent.count({
        where: { aggregateId: pending.notice!.siteNoticeId, eventType: "site_notice.withdrawn" },
      }),
    ).toBe(1);
    expect(await history(p, "&status=cancelled&page=1&pageSize=1")).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 1,
      items: [{ planRevisionId: pending.planRevisionId, plan: { planId: p.planId } }],
    });
    const rebuilt = await revise(
      p,
      body(30, { monthlyFeeFen: 4_030_000, monthlyPoints: 40300, effectiveDate: date(32) }),
    );
    expect(rebuilt.revisionNo).toBe(3);
    expect(rebuilt.actions).toEqual(["withdraw"]);
    const shown = PlanAdminListSchema.parse(await data(await request("/admin/plans"))).items.find(
      (r) => r.planId === p.planId,
    )!;
    expect(shown.current!.planRevisionId).toBe(first.planRevisionId);
    expect(shown.pending!.planRevisionId).toBe(rebuilt.planRevisionId);
    expect(shown.actions).not.toContain("create-plan-revision");
    const asViewer = PlanRevisionPageSchema.parse(
      await data(
        await request(`/admin/plan-revisions?planId=${p.planId}`, "GET", undefined, viewer),
      ),
    );
    expect(asViewer.items.every((r) => r.actions.length === 0)).toBe(true);
  });

  it("相邻rank两连接改价只一胜；撤回不得破坏另一已公告排期的价格/积分反依赖", async () => {
    const lower = await plan(40),
      higher = await plan(41);
    await revise(lower, body(40));
    await revise(higher, body(41));
    const results = await Promise.all([
      request(
        `/admin/plans/${lower.planId}/plan-revisions`,
        "POST",
        body(40, { monthlyFeeFen: 5_080_000, monthlyPoints: 50800, effectiveDate: date() }),
        admin,
        uuidv7(),
      ),
      request(
        `/admin/plans/${higher.planId}/plan-revisions`,
        "POST",
        body(41, { monthlyFeeFen: 5_050_000, monthlyPoints: 50500, effectiveDate: date() }),
        admin,
        uuidv7(),
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await error(
      results.find((r) => r.status === 409)!,
      409,
      "PLAN_TIER_ORDER_INVALID",
    );
    const p = await plan(42),
      q = await plan(43);
    await revise(p, body(42));
    await revise(q, body(43));
    const parent = await revise(
      p,
      body(42, { monthlyFeeFen: 5_150_000, monthlyPoints: 51500, effectiveDate: date() }),
    );
    const child = await revise(
      q,
      body(43, { monthlyFeeFen: 5_180_000, monthlyPoints: 51800, effectiveDate: date(32) }),
    );
    await error(await withdraw(parent), 409, "PLAN_TIER_ORDER_INVALID");
    expect(
      await db.planRevision.findUniqueOrThrow({ where: { id: parent.planRevisionId } }),
    ).toMatchObject({ cancelledAt: null });
    expect(
      await db.siteNotice.findUniqueOrThrow({ where: { id: parent.notice!.siteNoticeId } }),
    ).toMatchObject({ status: "announced" });
    expect(await auditCount(parent.planRevisionId, "billing.plan_revision.withdraw")).toBe(0);
    expect(
      await db.planRevision.findUniqueOrThrow({ where: { id: child.planRevisionId } }),
    ).toMatchObject({ cancelledAt: null });
  });

  it("真实emit在公告及修订写后失败，公告/修订/业务审计/原scheduled事件整体回滚", async () => {
    const p = await plan(50);
    await revise(p, body(50));
    const snapshot = async () => ({
      revisions: await db.planRevision.count({ where: { planId: p.planId } }),
      notices: await db.siteNotice.count({ where: { kind: "plan_revision" } }),
      audits: await db.auditLog.count({ where: { action: "billing.plan_revision.create" } }),
      events: await db.outboxEvent.count({
        where: { eventType: { in: ["billing.plan_revision_scheduled", "site_notice.announced"] } },
      }),
    });
    const before = await snapshot(),
      original = api.runtime.events.emit.bind(api.runtime.events);
    const spy = vi.spyOn(api.runtime.events, "emit").mockImplementation(async (tx, ctx, input) => {
      const result = await original(tx, ctx, input);
      if (input.type === "billing.plan_revision_scheduled")
        throw new Error("lyxtest: 排期事件后故障");
      return result;
    });
    try {
      const response = await request(
        `/admin/plans/${p.planId}/plan-revisions`,
        "POST",
        body(50, { monthlyFeeFen: 6_010_000, monthlyPoints: 60100, effectiveDate: date() }),
        admin,
        uuidv7(),
      );
      expect(response.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await snapshot()).toEqual(before);
  });

  it("北京生效边界商家读新价/首期优惠，原周期与已建付款快照不变且新旧历史只读", async () => {
    const p = await plan(60),
      promoPlan = await plan(61);
    const first = await revise(p, body(60));
    await revise(promoPlan, body(61));
    await data(
      await request(`/admin/plans/${p.planId}/shelve`, "POST", undefined, admin, uuidv7()),
    );
    await data(
      await request(`/admin/plans/${promoPlan.planId}/shelve`, "POST", undefined, admin, uuidv7()),
    );
    const pending = await revise(
      p,
      body(60, { monthlyFeeFen: 7_020_000, monthlyPoints: 70200, effectiveDate: date() }),
    );
    const promo = await revise(
      promoPlan,
      body(61, {
        monthlyFeeFen: 7_120_000,
        monthlyPoints: 71200,
        effectiveDate: date(),
        firstCyclePromo: true,
      }),
    );
    let owner = await signInAsMerchant(api);
    const made = await merchantServicesOf(api.runtime).tenant.createEntity(
      createIdentityContext({
        actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
      }),
    );
    await db.entity.update({
      where: { id: made.entityId },
      data: { verificationStatus: "pending" },
    });
    const merchant = (path: string, method = "GET", json?: unknown) =>
      api.request(`/api/v1${path}`, {
        method,
        ...(json === undefined ? {} : { json }),
        headers: owner.withStore(made.storeId),
        peer: `198.19.78.${++peer % 250}`,
      });
    const quote = (id: string) =>
      merchant("/m/plans/quote", "POST", { planId: id, months: 1 }).then(data<PlanQuote>);
    const old = await quote(p.planId),
      beforeTime = api.clock.now();
    const term = await make.subscriptionTerm({
      planId: p.planId,
      planRevisionId: first.planRevisionId,
    });
    // 明确历史夹具，不制造付款成功事实；pending_payment无支付/履约调用。
    const order = await make.billingOrder({
      entityId: made.entityId,
      status: "pending_payment",
      amountFen: old.payFen,
      contentSnapshot: {
        v: 1,
        kind: "plan",
        planId: p.planId,
        planName: old.planName,
        planRevisionId: old.planRevisionId,
        months: old.months,
        cyclePriceFen: old.payFen,
        payFen: old.payFen,
        monthlyPoints: old.benefits.monthlyPoints,
        discountBp: old.benefits.discountBp,
        promo: null,
        quotedAt: old.quotedAt,
      },
    });
    try {
      api.clock.set(new Date(new Date(pending.effectiveAt).getTime() - 1));
      owner = await signInAsMerchant(api, { phone: owner.phone, openid: owner.openid });
      expect((await quote(p.planId)).planRevisionId).toBe(first.planRevisionId);
      api.clock.advance(1);
      const current = await quote(p.planId),
        discounted = await quote(promoPlan.planId);
      expect(current).toMatchObject({
        planRevisionId: pending.planRevisionId,
        payFen: 7_020_000,
        benefits: { monthlyPoints: 70200 },
        promo: null,
      });
      expect(discounted).toMatchObject({
        planRevisionId: promo.planRevisionId,
        payFen: baseFee(61),
        benefits: { monthlyPoints: 71200 },
        promo: { type: "previous_revision" },
      });
      const cards = await data<{
        items: { planId: string; planRevisionId: string; monthlyFeeFen: number }[];
      }>(await merchant("/m/plans"));
      expect(cards.items.find((r) => r.planId === p.planId)).toMatchObject({
        planRevisionId: pending.planRevisionId,
        monthlyFeeFen: 7_020_000,
      });
      admin = await signInAsStaff(db, { roleKey: "super_admin", now: api.clock.now() });
      await error(await withdraw(pending), 409, "REVISION_ALREADY_EFFECTIVE");
      const rows = await history(p);
      expect(rows.items.find((r) => r.planRevisionId === first.planRevisionId)!.status).toBe(
        "superseded",
      );
      expect(rows.items.find((r) => r.planRevisionId === pending.planRevisionId)!.status).toBe(
        "effective",
      );
      expect(
        await db.planRevision.findUniqueOrThrow({ where: { id: first.planRevisionId } }),
      ).toMatchObject({ monthlyFeeFen: baseFee(60), cancelledAt: null });
      expect(await db.subscriptionTerm.findUniqueOrThrow({ where: { id: term.id } })).toEqual(term);
      expect(await db.billingOrder.findUniqueOrThrow({ where: { id: order.id } })).toEqual(order);
    } finally {
      api.clock.set(beforeTime);
      admin = await signInAsStaff(db, { roleKey: "super_admin", now: beforeTime });
    }
  });

  it("summary复用真实订阅事实、跨版本主体去重及整数MRR，GET不写业务", async () => {
    const summary = async () =>
      PlanSummarySchema.parse(await data(await request("/admin/plans/summary")));
    const before = await summary(),
      p = await db.plan.findUniqueOrThrow({ where: { code: "basic" } }),
      q = await db.plan.findUniqueOrThrow({ where: { code: "pro" } }),
      r = await db.plan.findUniqueOrThrow({ where: { code: "flagship" } });
    const active = await make.subscriptionTerm({ planId: p.id });
    // 本组独立于其他用例；后一期从前一期的北京止点开始，不靠工厂缺省日期重叠造数。
    const nextPeriod = (startsAt: Date) => {
      const dates = termDates(calendarDate(startsAt), 1, active.anchorDay);
      return {
        anchorDay: dates.anchorDay,
        startDate: new Date(`${dates.startDate}T00:00:00Z`),
        endDate: new Date(`${dates.endDate}T00:00:00Z`),
        startsAt,
        endsAt: dayRange(dates.endDate).end,
      };
    };
    const scheduled = await make.subscriptionTerm({
      entityId: active.entityId,
      planId: q.id,
      termNo: 2,
      origin: "renew",
      status: "scheduled",
      ...nextPeriod(active.endsAt),
    });
    const cancelled = await make.subscriptionTerm({
      entityId: active.entityId,
      planId: r.id,
      termNo: 3,
      origin: "renew",
      status: "cancelled",
      ...nextPeriod(scheduled.endsAt),
    });
    const bizDate = new Date(`${calendarDate(api.clock.now())}T00:00:00Z`);
    for (const [term, type] of [
      [active, "activated"],
      [active, "activated"],
      [scheduled, "renewal_scheduled"],
      [cancelled, "renewal_scheduled"],
      [active, "resumed"],
    ] as const)
      await db.subscriptionEvent.create({
        data: {
          id: uuidv7(),
          entityId: active.entityId,
          subscriptionTermId: term.id,
          type,
          occurredAt: api.clock.now(),
          bizDate,
          actorType: "system",
          createdAt: api.clock.now(),
        },
      });
    const business = async () => [
      await db.plan.count(),
      await db.planRevision.count(),
      await db.siteNotice.count(),
      await db.subscriptionEvent.count(),
    ];
    const counts = await business(),
      response = await request("/admin/plans/summary"),
      value = PlanSummarySchema.parse(await data(response));
    expect(value).toEqual({
      activeEntityCount: before.activeEntityCount + 1,
      mrrFen: (BigInt(before.mrrFen) + BigInt(active.monthlyEquivFen)).toString(),
      newThisMonthCount: before.newThisMonthCount + 1,
      renewedThisMonthCount: before.renewedThisMonthCount + 1,
      asOf: api.clock.now().toISOString(),
    });
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=60");
    const columns = PlanAdminListSchema.parse(await data(await request("/admin/plans"))).items;
    expect(columns.find((x) => x.planId === q.id)!.renewedThisMonthCount).toBe(1);
    expect(columns.find((x) => x.planId === r.id)!.renewedThisMonthCount).toBe(1);
    expect(await business()).toEqual(counts);
  });
});
