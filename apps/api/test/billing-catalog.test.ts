// W4-07: "admin.plan.list", "admin.plan.update", "admin.plan.shelve", "admin.plan.delist".
import { beforeAll, describe, expect, it } from "vitest";
import { calendarDate } from "@liyoxi/shared/time";
import {
  createIdentityContext,
  createNotices,
  runSeed,
  security,
  seedPlaceholderFinanceConfig,
  uuidv7,
} from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { PlanAdminListSchema, PlanAdminColumnSchema } from "@liyoxi/contract";
import type { PlanQuote } from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import { merchantServicesOf } from "../src/merchant/services.js";

const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  make: ReturnType<typeof createFactories>;
let admin: SignedInStaff,
  viewer: SignedInStaff,
  editor: SignedInStaff,
  peer = 0,
  number = 0;
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  make = createFactories({ db, clock: api.clock });
  admin = await signInAsStaff(db, { roleKey: "super_admin" });
  viewer = await signInAsStaff(db, { roleKey: "finance" });
  editor = await signInAsStaff(db, { roleKey: "editor" });
  const second = await make.staff({ staffRoleKey: "finance", isLead: true });
  await seedPlaceholderFinanceConfig(
    {
      tx: api.runtime.tx,
      clock: api.clock,
      assembly: api.runtime.assembly,
      bizNo: api.runtime.bizNo,
      keyring: security.loadKeyring(api.runtime.env),
    },
    { proposerId: viewer.staff.id, approverId: second.id },
  );
  await seedUserAgreements(h, api);
}, 120000);

const request = (path: string, method = "GET", json?: unknown, staff = admin, key?: string) =>
  api.request(`/api/v1${path}`, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { ...staff.headers, ...(key ? { "Idempotency-Key": key } : {}) },
    peer: `198.19.77.${++peer % 250}`,
  });
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
async function list(includeDelisted = true, staff = admin) {
  return PlanAdminListSchema.parse(
    await data(
      await request(`/admin/plans?includeDelisted=${includeDelisted}`, "GET", undefined, staff),
    ),
  );
}
async function fresh(
  listed = true,
  prices: Record<string, number> | null = { "1": 9900, "3": 29700, "12": 118800 },
) {
  const now = api.clock.now(),
    code = `fixture_${++number}`;
  // 已有合法套餐/价目历史夹具；本片不声称新增套餐写接口已落地。
  const plan = await db.plan.create({
    data: {
      id: uuidv7(),
      code,
      name: `虚构套餐${number}`,
      rank: 50 + number,
      isListed: listed,
      scope: "public",
      lockVersion: 0,
      createdAt: now,
      updatedAt: now,
    },
  });
  if (prices)
    await db.planRevision.create({
      data: {
        id: uuidv7(),
        planId: plan.id,
        revisionNo: 1,
        monthlyFeeFen: 9900,
        monthlyPoints: 1000,
        discountBp: 9000,
        productionModel: "standard",
        maxStores: 2,
        maxMembers: 5,
        schedulePriority: "standard",
        hasMonthlyReport: false,
        cyclePrices: prices,
        effectiveAt: new Date(now.getTime() - 86400000),
        createdAt: now,
      },
    });
  return plan;
}
async function column(id: string) {
  const result = (await list()).items.find((row) => row.planId === id);
  if (!result) throw new Error("缺少真实套餐列");
  return result;
}
async function change(id: string, body: unknown, key = uuidv7()) {
  return PlanAdminColumnSchema.parse(
    await data(await request(`/admin/plans/${id}`, "PATCH", body, admin, key)),
  );
}
async function listing(id: string, action: "shelve" | "delist", key = uuidv7()) {
  return PlanAdminColumnSchema.parse(
    await data(await request(`/admin/plans/${id}/${action}`, "POST", undefined, admin, key)),
  );
}
const audits = (id: string, action?: string) =>
  db.auditLog.count({ where: { targetType: "plan", targetId: id, ...(action ? { action } : {}) } });

describe("既有套餐运营正式HTTP与真实库", { timeout: 30000 }, () => {
  it("列表给真实价目/公告/员工、启用周期和非零订阅计数，GET不写业务", async () => {
    const plan = await fresh(),
      now = api.clock.now(),
      term = await make.subscriptionTerm({ planId: plan.id });
    const day = new Date(`${calendarDate(now)}T00:00:00Z`);
    for (const type of ["activated", "renewal_scheduled", "renewal_scheduled"] as const)
      await db.subscriptionEvent.create({
        data: {
          id: uuidv7(),
          entityId: term.entityId,
          subscriptionTermId: term.id,
          type,
          occurredAt: now,
          bizDate: day,
          actorType: "system",
          createdAt: now,
        },
      });
    const current = await db.planRevision.findFirstOrThrow({ where: { planId: plan.id } }),
      pendingId = uuidv7(),
      effectiveAt = new Date(now.getTime() + 31 * 86400000);
    const notice = await api.runtime.tx.run((tx) =>
      createNotices({ clock: api.clock, events: api.runtime.events }).announce(
        tx,
        createIdentityContext({ actor: { type: "staff", id: admin.staff.id, client: "admin" } }),
        {
          kind: "plan_revision",
          refId: pendingId,
          title: "虚构调整",
          summary: "虚构价目调整",
          summaryNoPrice: "权益调整",
          effectiveAt,
          createdByStaffId: admin.staff.id,
          link: { route: "plan.revision", params: { planRevisionId: pendingId } },
        },
      ),
    );
    await db.planRevision.create({
      data: {
        id: pendingId,
        planId: plan.id,
        revisionNo: 2,
        monthlyFeeFen: current.monthlyFeeFen,
        monthlyPoints: 1200,
        discountBp: current.discountBp,
        productionModel: current.productionModel,
        maxStores: current.maxStores,
        maxMembers: current.maxMembers,
        schedulePriority: current.schedulePriority,
        hasMonthlyReport: true,
        cyclePrices: { "1": 12000, "3": 36000, "12": 144000 },
        effectiveAt,
        announcedAt: now,
        siteNoticeId: notice.siteNoticeId,
        createdByStaffId: admin.staff.id,
        createdAt: now,
      },
    });
    const before = [
      await db.plan.count(),
      await db.planRevision.count(),
      await db.billingParam.count(),
      await audits(plan.id),
    ];
    const response = await request("/admin/plans"),
      all = PlanAdminListSchema.parse(await data(response));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const item = all.items.find((row) => row.planId === plan.id)!;
    expect(item).toMatchObject({
      columnStatus: "pending_change",
      activeEntityCount: 1,
      newThisMonthCount: 1,
      renewedThisMonthCount: 1,
      current: { planRevisionId: current.id, status: "effective" },
      pending: {
        planRevisionId: pendingId,
        status: "pending",
        createdBy: { staffId: admin.staff.id },
        notice: { siteNoticeId: notice.siteNoticeId },
      },
    });
    expect(item.current!.cyclePrices.map((row) => row.months)).toEqual([1, 3, 12]);
    expect(all.enabledCycles).toEqual({ current: [1, 3, 12], pending: null });
    expect([
      await db.plan.count(),
      await db.planRevision.count(),
      await db.billingParam.count(),
      await audits(plan.id),
    ]).toEqual(before);
  });

  it("正式模块/plan.edit和required守卫，非法改字段零写；四路由guest均拒绝", async () => {
    const plan = await fresh(),
      shown = await list(true, viewer);
    expect(shown.items.find((row) => row.planId === plan.id)!.actions).toEqual([]);
    await error(await request("/admin/plans", "GET", undefined, editor), 403, "PERMISSION_DENIED");
    for (const [path, method, body] of [
      [`/admin/plans/${plan.id}`, "PATCH", { lockVersion: 0, name: "未授权" }],
      [`/admin/plans/${plan.id}/shelve`, "POST", undefined],
      [`/admin/plans/${plan.id}/delist`, "POST", undefined],
    ] as const) {
      await error(await request(path, method, body, viewer, uuidv7()), 403, "PERMISSION_DENIED");
      await error(await request(path, method, body), 400, "IDEMPOTENCY_KEY_REQUIRED");
      await error(
        await api.request(`/api/v1${path}`, {
          method,
          ...(body ? { json: body } : {}),
          peer: `198.19.77.${++peer % 250}`,
        }),
        401,
        "AUTH_REQUIRED",
      );
    }
    await error(await api.request("/api/v1/admin/plans"), 401, "AUTH_REQUIRED");
    await error(
      await request(
        `/admin/plans/${plan.id}`,
        "PATCH",
        { lockVersion: 0, name: "不能改rank", rank: 99 },
        admin,
        uuidv7(),
      ),
      400,
      "VALIDATION_FAILED",
    );
    expect(await db.plan.findUniqueOrThrow({ where: { id: plan.id } })).toEqual(plan);
    expect(await audits(plan.id)).toBe(0);
  });

  it("改名CAS竞争仅一胜、同键重放一次审计，空改与旧版本拒绝", async () => {
    const plan = await fresh(),
      body = { lockVersion: 0, name: "  新套餐名称  " },
      key = uuidv7();
    const first = await change(plan.id, body, key);
    expect(first).toMatchObject({ name: "新套餐名称", lockVersion: 1 });
    expect(await change(plan.id, body, key)).toEqual(first);
    expect(await audits(plan.id, "billing.plan.update")).toBe(1);
    await error(
      await request(
        `/admin/plans/${plan.id}`,
        "PATCH",
        { lockVersion: 1, name: first.name },
        admin,
        uuidv7(),
      ),
      400,
      "CHANGESET_EMPTY",
    );
    const outcomes = await Promise.all([
      request(
        `/admin/plans/${plan.id}`,
        "PATCH",
        { lockVersion: 1, name: "甲更名" },
        admin,
        uuidv7(),
      ),
      request(
        `/admin/plans/${plan.id}`,
        "PATCH",
        { lockVersion: 1, name: "乙更名" },
        admin,
        uuidv7(),
      ),
    ]);
    expect(outcomes.map((response) => response.status).sort()).toEqual([200, 409]);
    await error(
      outcomes.find((response) => response.status === 409)!,
      409,
      "VERSION_CONFLICT",
    );
    expect((await column(plan.id)).lockVersion).toBe(2);
    expect(await audits(plan.id, "billing.plan.update")).toBe(2);
  });

  it("上下架当前值行锁守卫与同键重放，列表includeDelisted真实过滤", async () => {
    const plan = await fresh(),
      key = uuidv7(),
      first = await listing(plan.id, "delist", key);
    expect(first).toMatchObject({ isListed: false, columnStatus: "delisted", lockVersion: 1 });
    expect(await listing(plan.id, "delist", key)).toEqual(first);
    expect((await list(false)).items.some((row) => row.planId === plan.id)).toBe(false);
    await error(
      await request(`/admin/plans/${plan.id}/delist`, "POST", undefined, admin, uuidv7()),
      409,
      "STATE_NOT_ALLOWED",
    );
    const upKey = uuidv7(),
      up = await listing(plan.id, "shelve", upKey);
    expect(up).toMatchObject({ isListed: true, lockVersion: 2 });
    expect(await listing(plan.id, "shelve", upKey)).toEqual(up);
    await error(
      await request(`/admin/plans/${plan.id}/shelve`, "POST", undefined, admin, uuidv7()),
      409,
      "STATE_NOT_ALLOWED",
    );
    expect(await audits(plan.id)).toBe(2);
  });

  it("无当前价目/缺启用周期均拒上架，不造默认价格或写审计", async () => {
    const absent = await fresh(false, null),
      missing = await fresh(false, { "1": 9900 });
    for (const plan of [absent, missing]) {
      const response = await request(
        `/admin/plans/${plan.id}/shelve`,
        "POST",
        undefined,
        admin,
        uuidv7(),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "PLAN_REVISION_MISSING",
        details: { missingCycles: plan.id === absent.id ? [1, 3, 12] : [3, 12] },
      });
      expect(await db.plan.findUniqueOrThrow({ where: { id: plan.id } })).toEqual(plan);
      expect(await audits(plan.id)).toBe(0);
    }
  });

  it("现商家列表/报价随运营真实变化，原周期权益和已建付款内容快照不变", async () => {
    const plan = await fresh(),
      owner = await signInAsMerchant(api);
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
        ...(json ? { json } : {}),
        headers: owner.withStore(made.storeId),
        peer: `198.19.77.${++peer % 250}`,
      });
    const quote = (): Promise<PlanQuote> =>
      merchant("/m/plans/quote", "POST", { planId: plan.id, months: 1 }).then(data);
    const first = await quote();
    expect(first.planName).toBe(plan.name);
    // 合法已存在历史，只验证快照不可漂移，不把工厂数据称为真实付款/履约。
    const historical = await make.subscriptionTerm({ planId: plan.id });
    const order = await make.billingOrder({
      entityId: made.entityId,
      status: "pending_payment",
      amountFen: first.payFen,
      contentSnapshot: {
        v: 1,
        kind: "plan",
        planId: plan.id,
        planName: first.planName,
        planRevisionId: first.planRevisionId,
        months: first.months,
        cyclePriceFen: first.payFen,
        payFen: first.payFen,
        monthlyPoints: first.benefits.monthlyPoints,
        discountBp: first.benefits.discountBp,
        promo: null,
        quotedAt: first.quotedAt,
      },
    });
    await change(plan.id, { lockVersion: 0, name: "公开新套餐名" });
    expect((await quote()).planName).toBe("公开新套餐名");
    await listing(plan.id, "delist");
    expect(
      (await data(await merchant("/m/plans"))).items.some(
        (row: { planId: string }) => row.planId === plan.id,
      ),
    ).toBe(false);
    await error(
      await merchant("/m/plans/quote", "POST", { planId: plan.id, months: 1 }),
      409,
      "PLAN_NOT_AVAILABLE",
    );
    await listing(plan.id, "shelve");
    expect((await quote()).payFen).toBe(first.payFen);
    expect(await db.subscriptionTerm.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(
      historical,
    );
    expect(await db.billingOrder.findUniqueOrThrow({ where: { id: order.id } })).toEqual(order);
  });
});
