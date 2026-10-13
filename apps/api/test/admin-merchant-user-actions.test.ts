import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { MerchantUserStatusViewSchema } from "@liyoxi/contract";
import { createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { merchantServicesOf } from "../src/merchant/services.js";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof handle.db.prisma>>,
  admin: SignedInStaff,
  make: ReturnType<typeof createFactories>,
  peer = 0;
beforeAll(async () => {
  api = await handle.start();
  db = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  make = createFactories({ db, clock: api.clock });
  admin = await signInAsStaff(db, { roleKey: "super_admin", now: api.clock.now() });
}, 180_000);
type Op = "disable" | "enable" | "forceLogout";
const part = (op: Op) => (op === "forceLogout" ? "force-logout" : op);
function request(
  op: Op,
  id: string,
  json: unknown,
  caller: SignedInStaff | null = admin,
  key: string | null = uuidv7(),
) {
  return api.request(`/api/v1/admin/merchant-users/${id}/${part(op)}`, {
    method: "POST",
    json,
    headers: {
      ...(caller?.headers ?? { origin: "http://localhost", "x-lyx-admin": "1" }),
      ...(key === null ? {} : { "Idempotency-Key": key }),
    },
    peer: `198.19.63.${++peer}`,
  });
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const result = MerchantUserStatusViewSchema.parse(
    ((await response.json()) as { data: unknown }).data,
  );
  expect(JSON.stringify(result)).not.toMatch(/phoneEnc|phoneBidx|openid|tokenHash/);
  return result;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
async function owner() {
  const who = await signInAsMerchant(api);
  const entity = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({ actor: { type: "merchant", id: who.merchantUserId, client: "weapp" } }),
  );
  const device = await signInAsMerchant(api, { phone: who.phone });
  const row = await db.merchantUser.findUniqueOrThrow({ where: { id: who.merchantUserId } });
  const body = { reasonText: "核实账号安全处置", confirm: { phoneMask: row.phoneMask! } };
  return { who, device, entity, row, body };
}
const mounted = (op: Op) =>
  expect(
    HANDLERS.filter((entry) => entry.route.operationId === `admin.merchantUser.${op}`),
  ).toHaveLength(1);

describe("admin.merchantUser.disable", { timeout: 120_000 }, () => {
  it("真实老板禁用与重放；拒绝匿名/客服非主管/过期stepUp/确认/输入，旧会话全部失效", async () => {
    mounted("disable");
    const f = await owner(),
      cs = await signInAsStaff(db, { roleKey: "cs", now: api.clock.now() }),
      lead = await signInAsStaff(db, { roleKey: "cs", isLead: true, now: api.clock.now() });
    await error(await request("disable", f.who.merchantUserId, f.body, null), 401, "AUTH_REQUIRED");
    await error(
      await request("disable", f.who.merchantUserId, f.body, cs),
      403,
      "PERMISSION_DENIED",
    );
    await db.staffSession.update({
      where: { id: lead.sessionId },
      data: { stepupAt: new Date(api.clock.now().getTime() - 660000) },
    });
    await error(
      await request("disable", f.who.merchantUserId, f.body, lead),
      403,
      "STEP_UP_REQUIRED",
    );
    await error(
      await request("disable", f.who.merchantUserId, {
        ...f.body,
        confirm: { phoneMask: "错误回显" },
      }),
      409,
      "CONFIRM_MISMATCH",
    );
    await error(
      await request("disable", f.who.merchantUserId, { ...f.body, reasonText: " " }),
      400,
      "VALIDATION_FAILED",
    );
    await error(
      await request("disable", f.who.merchantUserId, f.body, admin, null),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    await error(await request("disable", uuidv7(), f.body), 404, "NOT_FOUND");
    const key = uuidv7(),
      result = await data(await request("disable", f.who.merchantUserId, f.body, admin, key));
    expect(result).toEqual({
      merchantUserId: f.who.merchantUserId,
      status: "disabled",
      phoneMask: f.row.phoneMask,
      revokedSessionCount: 2,
      revokedPortalSessionCount: 0,
      activeOwnerEntityIds: [f.entity.entityId],
    });
    expect(await data(await request("disable", f.who.merchantUserId, f.body, admin, key))).toEqual(
      result,
    );
    await error(await request("disable", f.who.merchantUserId, f.body), 409, "STATE_NOT_ALLOWED");
    for (const who of [f.who, f.device])
      await error(
        await api.request("/api/v1/m/me", { headers: who.headers }),
        401,
        "SESSION_INVALID",
      );
    expect(
      await db.entityMember.findUniqueOrThrow({ where: { id: f.entity.memberId } }),
    ).toMatchObject({ status: "active", role: "owner" });
  });
});
describe("admin.merchantUser.enable", { timeout: 120_000 }, () => {
  it("只启用disabled且不恢复旧会话，真正重新登录；拒绝active/确认/stepUp，重放仍鉴权", async () => {
    mounted("enable");
    const f = await owner();
    await error(await request("enable", f.who.merchantUserId, f.body), 409, "STATE_NOT_ALLOWED");
    await data(await request("disable", f.who.merchantUserId, f.body));
    await error(
      await request("enable", f.who.merchantUserId, {
        ...f.body,
        confirm: { phoneMask: "旧回显" },
      }),
      409,
      "CONFIRM_MISMATCH",
    );
    const lead = await signInAsStaff(db, { roleKey: "cs", isLead: true, now: api.clock.now() });
    await db.staffSession.update({
      where: { id: lead.sessionId },
      data: { stepupAt: new Date(api.clock.now().getTime() - 660000) },
    });
    await error(
      await request("enable", f.who.merchantUserId, f.body, lead),
      403,
      "STEP_UP_REQUIRED",
    );
    const key = uuidv7(),
      result = await data(await request("enable", f.who.merchantUserId, f.body, admin, key));
    expect(result).toMatchObject({
      status: "active",
      revokedSessionCount: 0,
      revokedPortalSessionCount: 0,
    });
    expect(await data(await request("enable", f.who.merchantUserId, f.body, admin, key))).toEqual(
      result,
    );
    await error(
      await api.request("/api/v1/m/me", { headers: f.who.headers }),
      401,
      "SESSION_INVALID",
    );
    const login = await signInAsMerchant(api, { phone: f.who.phone, openid: f.who.openid });
    expect((await api.request("/api/v1/m/me", { headers: login.headers })).status).toBe(200);
    await error(
      await request("enable", f.who.merchantUserId, f.body, null, key),
      401,
      "AUTH_REQUIRED",
    );
    expect(
      await db.auditLog.count({
        where: { targetId: f.who.merchantUserId, action: "identity.merchant_user.enable" },
      }),
    ).toBe(1);
  });
});
describe("admin.merchantUser.forceLogout", { timeout: 120_000 }, () => {
  it("普通客服无需stepUp，吊销小程序/portal并关静默；重放与换键计数准确，拒绝越权/确认/已注销", async () => {
    mounted("forceLogout");
    const f = await owner(),
      cs = await signInAsStaff(db, { roleKey: "cs", now: api.clock.now() }),
      other = await signInAsStaff(db, { roleKey: "delivery_manager", now: api.clock.now() });
    await db.staffSession.update({
      where: { id: cs.sessionId },
      data: { stepupAt: new Date(api.clock.now().getTime() - 660000) },
    });
    const id = uuidv7(),
      now = api.clock.now();
    const portal = await db.portalSession.create({
      data: {
        id,
        tokenHash: createHash("sha256").update(id).digest(),
        portalTicketId: uuidv7(),
        approvedByUserId: f.who.merchantUserId,
        entityId: f.entity.entityId,
        storeId: f.entity.storeId,
        grantScope: "store",
        expiresAt: new Date(now.getTime() + 3600000),
        ip: "198.19.63.99",
        userAgent: "lyxtest admin user action",
        createdAt: now,
        updatedAt: now,
      },
    });
    const body = { confirm: f.body.confirm };
    await error(
      await request("forceLogout", f.who.merchantUserId, body, other),
      403,
      "PERMISSION_DENIED",
    );
    await error(
      await request("forceLogout", f.who.merchantUserId, { confirm: { phoneMask: "旧回显" } }, cs),
      409,
      "CONFIRM_MISMATCH",
    );
    const key = uuidv7(),
      result = await data(await request("forceLogout", f.who.merchantUserId, body, cs, key));
    expect(result).toMatchObject({
      status: "active",
      revokedSessionCount: 2,
      revokedPortalSessionCount: 1,
    });
    expect(await data(await request("forceLogout", f.who.merchantUserId, body, cs, key))).toEqual(
      result,
    );
    expect(await data(await request("forceLogout", f.who.merchantUserId, body, cs))).toMatchObject({
      revokedSessionCount: 0,
      revokedPortalSessionCount: 0,
    });
    expect(await db.portalSession.findUniqueOrThrow({ where: { id: portal.id } })).toMatchObject({
      revokeReason: "account_action",
    });
    expect(
      await db.wechatIdentity.findMany({ where: { merchantUserId: f.who.merchantUserId } }),
    ).toMatchObject([{ silentLoginEnabled: false }, { silentLoginEnabled: false }]);
    for (const who of [f.who, f.device])
      await error(
        await api.request("/api/v1/m/me", { headers: who.headers }),
        401,
        "SESSION_INVALID",
      );
    const deleted = await make.merchantUser({
      status: "deleted",
      phoneEnc: null,
      phoneBidx: null,
      phoneMask: null,
      phoneLast4: null,
      displayName: null,
      deletedAt: now,
    });
    await error(await request("forceLogout", deleted.id, body, cs), 409, "STATE_NOT_ALLOWED");
  });
});
