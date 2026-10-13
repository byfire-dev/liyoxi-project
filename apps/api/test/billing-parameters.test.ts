// W4-07: "admin.billingParam.list", "admin.billingParam.withdraw",
// "admin.pricingChange.create", "admin.pricingChange.list"。只补本片两组正式HTTP。
import { beforeAll, describe, expect, it } from "vitest";
import {
  BillingParamListSchema,
  BillingParamViewSchema,
  PricingChangePageSchema,
  PricingChangeRecordSchema,
} from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { calendarDate } from "@liyoxi/shared/time";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  admin: SignedInStaff,
  viewer: SignedInStaff,
  editor: SignedInStaff,
  peer = 0;
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  admin = await signInAsStaff(db, { roleKey: "super_admin" });
  viewer = await signInAsStaff(db, { roleKey: "finance" });
  editor = await signInAsStaff(db, { roleKey: "editor" });
  api.clock.advance(1);
}, 60000);
const request = (path: string, method = "GET", json?: unknown, staff = admin, key?: string) =>
  api.request(`/api/v1${path}`, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { ...staff.headers, ...(key ? { "Idempotency-Key": key } : {}) },
    peer: `198.19.79.${++peer % 250}`,
  });
async function data(response: Response): Promise<unknown> {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { data: unknown }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
const counts = async () => [
  await db.billingParam.count(),
  await db.priceTierRevision.count(),
  await db.siteNotice.count(),
  await db.outboxEvent.count(),
  await db.auditLog.count(),
];

describe("计费参数四正式路由两组HTTP", { timeout: 30000 }, () => {
  it("真实身份/模块/编辑权限与required；保存和撤回同键重放各只有一次业务事实", async () => {
    const input = { params: [{ key: "adUnitPoints", value: 60 }], note: "虚构HTTP参数" },
      before = await counts();
    for (const path of ["/admin/billing-params", "/admin/pricing-changes"])
      await error(await request(path, "GET", undefined, editor), 403, "PERMISSION_DENIED");
    await error(
      await request("/admin/pricing-changes", "POST", input, viewer, uuidv7()),
      403,
      "PERMISSION_DENIED",
    );
    await error(
      await request("/admin/pricing-changes", "POST", input),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    const initial = BillingParamListSchema.parse(
      await data(await request("/admin/billing-params", "GET", undefined, viewer)),
    );
    expect(initial.items).toHaveLength(12);
    expect(initial.items.find((row) => row.key === "adUnitPoints")).toMatchObject({
      current: { value: 50, createdBy: null },
      pending: null,
    });
    expect(await counts()).toEqual(before);

    const key = uuidv7(),
      result = PricingChangeRecordSchema.parse(
        await data(await request("/admin/pricing-changes", "POST", input, admin, key)),
      ),
      row = result.paramItems[0]!,
      path = `/admin/billing-params/${row.billingParamId}/withdraw`,
      confirm = { confirm: { key: row.key, effectiveAt: row.effectiveAt } };
    expect(result).toMatchObject({
      createdBy: { staffId: admin.staff.id },
      notice: { status: "announced" },
      paramItems: [{ previousValue: 50, value: 60, status: "pending" }],
    });
    expect(await data(await request("/admin/pricing-changes", "POST", input, admin, key))).toEqual(
      result,
    );
    const pending = BillingParamListSchema.parse(
      await data(await request("/admin/billing-params")),
    ).items.find((r) => r.key === row.key)!;
    expect(pending).toMatchObject({
      current: { value: 50 },
      pending: { value: 60, changeId: result.changeSetId },
      actions: ["withdraw"],
    });
    await error(await request(path, "POST", confirm, viewer, uuidv7()), 403, "PERMISSION_DENIED");
    await error(await request(path, "POST", confirm), 400, "IDEMPOTENCY_KEY_REQUIRED");
    for (const [url, method, json] of [
      ["/admin/billing-params", "GET", undefined],
      ["/admin/pricing-changes", "GET", undefined],
      ["/admin/pricing-changes", "POST", input],
      [path, "POST", confirm],
    ] as const)
      await error(
        await api.request(`/api/v1${url}`, {
          method,
          ...(json === undefined ? {} : { json }),
          peer: `198.19.79.${++peer % 250}`,
        }),
        401,
        "AUTH_REQUIRED",
      );

    const withdrawKey = uuidv7(),
      withdrawn = BillingParamViewSchema.parse(
        await data(await request(path, "POST", confirm, admin, withdrawKey)),
      );
    expect(withdrawn).toMatchObject({
      key: row.key,
      current: { value: 50 },
      pending: null,
      actions: [],
    });
    expect(await data(await request(path, "POST", confirm, admin, withdrawKey))).toEqual(withdrawn);
    expect(await db.billingParam.count({ where: { changeId: result.changeSetId } })).toBe(1);
    expect(
      await db.auditLog.count({ where: { targetKey: row.key, action: "billing.param.change" } }),
    ).toBe(1);
    expect(
      await db.auditLog.count({ where: { targetKey: row.key, action: "billing.param.withdraw" } }),
    ).toBe(1);
    expect(
      await db.outboxEvent.count({
        where: { aggregateId: row.billingParamId, eventType: "billing.param_change_scheduled" },
      }),
    ).toBe(1);
    expect(
      await db.outboxEvent.count({
        where: { aggregateId: result.notice!.siteNoticeId, eventType: "site_notice.withdrawn" },
      }),
    ).toBe(1);
  });

  it("typed输入/查询校验零业务写；即时模板和非公告参数合并历史且只读不写", async () => {
    const before = await counts();
    for (const body of [
      { params: [{ key: "bank_account", value: {} }] },
      { params: [{ key: "adUnitPoints", value: 1001 }] },
      {
        params: [
          { key: "minLicenseMonths", value: 4 },
          { key: "minLicenseMonths", value: 5 },
        ],
      },
      { params: [{ key: "adFreeRevisions", value: 3, effectiveDate: "2026-02-30" }] },
      { tiers: { S: 100, A: 2000, B: 1600, C: 1000 } },
    ])
      await error(
        await request("/admin/pricing-changes", "POST", body, admin, uuidv7()),
        400,
        "VALIDATION_FAILED",
      );
    for (const query of [
      "key=bank_account",
      "page=0",
      "createdFrom=2026-02-30",
      "createdFrom=2026-02-01&createdTo=2026-01-01",
    ])
      await error(await request(`/admin/pricing-changes?${query}`), 400, "VALIDATION_FAILED");
    await error(
      await request(
        `/admin/billing-params/${uuidv7()}/withdraw`,
        "POST",
        { confirm: { key: "minLicenseMonths", effectiveAt: api.clock.now().toISOString() } },
        admin,
        uuidv7(),
      ),
      404,
      "NOT_FOUND",
    );
    expect(await counts()).toEqual(before);

    api.clock.advance(1);
    const input = {
        tiers: { S: 3100, A: 2000, B: 1600, C: 1000 },
        params: [{ key: "minLicenseMonths", value: 4 }],
        note: "虚构即时批次",
      },
      result = PricingChangeRecordSchema.parse(
        await data(await request("/admin/pricing-changes", "POST", input, admin, uuidv7())),
      );
    expect(result).toMatchObject({
      notice: null,
      note: "虚构即时批次",
      tierItems: [{ tier: "S", previousPoints: 3000, points: 3100 }],
      paramItems: [{ key: "minLicenseMonths", previousValue: 3, value: 4, status: "effective" }],
    });
    const after = await counts(),
      day = calendarDate(api.clock.now()),
      page = PricingChangePageSchema.parse(
        await data(
          await request(
            `/admin/pricing-changes?kind=price_tier&key=minLicenseMonths&createdFrom=${day}&createdTo=${day}&pageSize=1`,
            "GET",
            undefined,
            viewer,
          ),
        ),
      );
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 1, items: [result] });
    expect(result.summaryText).toContain("minLicenseMonths");
    const current = BillingParamListSchema.parse(
      await data(await request("/admin/billing-params")),
    ).items.find((r) => r.key === "minLicenseMonths")!;
    expect(current).toMatchObject({
      current: { value: 4, changeId: result.changeSetId },
      pending: null,
    });
    expect(await counts()).toEqual(after);
  });
});
