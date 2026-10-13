import { beforeAll, describe, expect, it } from "vitest";
import { ReferralCodeListSchema, ReferralCodeRowSchema } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff, snapshotTables } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
const handle = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof handle.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  lead: SignedInStaff,
  normal: SignedInStaff,
  peer = 0;
const code = () => `API${uuidv7().replaceAll("-", "").slice(-9).toUpperCase()}`;
beforeAll(async () => {
  api = await handle.start();
  db = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  make = createFactories({ db, clock: api.clock });
  lead = await signInAsStaff(db, {
    roleKey: "cs",
    isLead: true,
    now: new Date(api.clock.now().getTime() - 660000),
  });
  normal = await signInAsStaff(db, { roleKey: "cs", now: api.clock.now() });
}, 120000);
function request(
  path = "",
  json?: unknown,
  by: SignedInStaff | null = lead,
  key: string | null = uuidv7(),
) {
  return api.request(`/api/v1/admin/referral-codes${path}`, {
    method: json === undefined ? "GET" : "POST",
    ...(json === undefined ? {} : { json }),
    headers: {
      ...(by?.headers ?? { origin: "http://localhost", "x-lyx-admin": "1" }),
      ...(json === undefined || key === null ? {} : { "Idempotency-Key": key }),
    },
    peer: `198.19.75.${++peer}`,
  });
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { data: unknown }).data;
}
async function row(response: Response) {
  const result = ReferralCodeRowSchema.parse(await data(response));
  expect(JSON.stringify(result)).not.toMatch(/phoneEnc|phoneMask|phoneBidx|tokenHash|openid/);
  return result;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
const mounted = (op: string) =>
  expect(
    HANDLERS.filter((entry) => entry.route.operationId === `admin.referralCode.${op}`),
  ).toHaveLength(1);

describe("admin.referralCode.create", { timeout: 120000 }, () => {
  it("真实主管无需stepup登记、重放/唯一码与销售归属；拒绝匿名/非主管/非法输入", async () => {
    mounted("create");
    const owner = await make.staff(),
      body = {
        code: code().toLowerCase(),
        sourceType: "sales",
        ownerStaffId: owner.id,
        label: "销售邀请码",
      },
      key = uuidv7();
    await error(await request("", body, null), 401, "AUTH_REQUIRED");
    await error(await request("", body, normal), 403, "PERMISSION_DENIED");
    await error(await request("", body, lead, null), 400, "IDEMPOTENCY_KEY_REQUIRED");
    const result = await row(await request("", body, lead, key));
    expect(result).toMatchObject({
      code: body.code.toUpperCase(),
      status: "active",
      owner: { staffId: owner.id },
    });
    expect(await row(await request("", body, lead, key))).toEqual(result);
    await error(await request("", body), 409, "REFERRAL_CODE_TAKEN");
    for (const input of [
      { code: code(), sourceType: "sales" },
      { code: code(), sourceType: "partner" },
      { code: "abc", sourceType: "campaign" },
      { code: code(), sourceType: "campaign", label: "超".repeat(31) },
    ])
      await error(await request("", input), 400, "VALIDATION_FAILED");
    expect(await db.auditLog.count({ where: { targetId: result.referralCodeId } })).toBe(1);
  });
});

describe("admin.referralCode.list", { timeout: 120000 }, () => {
  it("普通客服读全局渠道及真实统计，GET零写、筛选分页与错误输入", async () => {
    mounted("list");
    const result = await row(
      await request("", { code: code(), sourceType: "campaign", label: "活动渠道" }),
    );
    const user = await make.merchantUser({
      sourceType: "campaign",
      sourceReferralCodeId: result.referralCodeId,
    });
    await make.entity({
      createdByUserId: user.id,
      sourceType: "campaign",
      sourceReferralCodeId: result.referralCodeId,
    });
    await error(await request("", undefined, null), 401, "AUTH_REQUIRED");
    const before = await snapshotTables(db, [
      "referral_code",
      "audit_log",
      "status_transition",
      "outbox_event",
      "idempotency_record",
    ]);
    const list = ReferralCodeListSchema.parse(
      await data(
        await request(
          `?q=${result.code.toLowerCase()}&sourceType=campaign&status=active&page=1&pageSize=1`,
          undefined,
          normal,
        ),
      ),
    );
    expect(list).toMatchObject({
      total: 1,
      items: [{ referralCodeId: result.referralCodeId, registeredUserCount: 1, entityCount: 1 }],
    });
    expect(
      await snapshotTables(db, [
        "referral_code",
        "audit_log",
        "status_transition",
        "outbox_event",
        "idempotency_record",
      ]),
    ).toEqual(before);
    await error(await request("?status=unknown"), 400, "VALIDATION_FAILED");
    await error(await request("?pageSize=0"), 400, "VALIDATION_FAILED");
  });
});

describe("admin.referralCode.disable", { timeout: 120000 }, () => {
  it("真实停用/原键重放及最新状态拒绝，保留全局归属与审计", async () => {
    mounted("disable");
    const created = await row(await request("", { code: code(), sourceType: "campaign" })),
      path = `/${created.referralCodeId}/disable`,
      body = { reasonText: "活动结束" },
      key = uuidv7();
    await error(await request(path, body, normal), 403, "PERMISSION_DENIED");
    const result = await row(await request(path, body, lead, key));
    expect(result).toMatchObject({ status: "disabled", disabledAt: api.clock.now().toISOString() });
    expect(await row(await request(path, body, lead, key))).toEqual(result);
    await error(await request(path, body), 409, "STATE_NOT_ALLOWED");
    await error(await request(`/${uuidv7()}/disable`, body), 404, "NOT_FOUND");
    await error(await request(path, { reasonText: "长".repeat(201) }), 400, "VALIDATION_FAILED");
    expect(
      await db.auditLog.count({
        where: { targetId: created.referralCodeId, action: "tenant.referral_code.disable" },
      }),
    ).toBe(1);
  });
});

describe("admin.referralCode.enable", { timeout: 120000 }, () => {
  it("真实重新启用与原键重放；拒绝非主管、未知字段和错误状态", async () => {
    mounted("enable");
    const created = await row(await request("", { code: code(), sourceType: "campaign" }));
    await row(await request(`/${created.referralCodeId}/disable`, {}));
    const path = `/${created.referralCodeId}/enable`,
      key = uuidv7();
    await error(await request(path, {}, normal), 403, "PERMISSION_DENIED");
    await error(await request(path, { lockVersion: 0 }), 400, "VALIDATION_FAILED");
    const result = await row(await request(path, {}, lead, key));
    expect(result).toMatchObject({ status: "active", disabledAt: null });
    expect(await row(await request(path, {}, lead, key))).toEqual(result);
    await error(await request(path, {}), 409, "STATE_NOT_ALLOWED");
    await error(await request(`/${uuidv7()}/enable`, {}), 404, "NOT_FOUND");
    expect(await db.statusTransition.count({ where: { subjectId: created.referralCodeId } })).toBe(
      0,
    );
  });
});
