import { DeletionResultSchema, DeletionBlockerSchema } from "@liyoxi/contract";
import { createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, snapshotTables } from "@liyoxi/services/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
const handle = useTestApi();
let api: TestApi, db: Awaited<ReturnType<typeof handle.db.prisma>>;
beforeAll(async () => {
  api = await handle.start();
  db = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
}, 180_000);
const request = (
  who?: SignedInMerchant,
  body: unknown = { hasConfirmed: true },
  key: string | null = uuidv7(),
) =>
  api.request("/api/v1/m/me/deletion", {
    method: "POST",
    json: body,
    headers: { ...(who?.headers ?? {}), ...(key ? { "Idempotency-Key": key } : {}) },
  });
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  const value = (await response.json()) as { error: string; details?: { blockers?: unknown[] } };
  expect(value.error).toBe(symbol);
  return value;
}
describe("m.me.deletion.create", { timeout: 120_000 }, () => {
  it("匿名、未确认、缺键和伪造目标账号均拒绝，不能删他人或改个人事实", async () => {
    const who = await signInAsMerchant(api),
      stranger = await signInAsMerchant(api);
    const tables = [
      "merchant_user",
      "wechat_identity",
      "user_session",
      "entity_member",
      "audit_log",
      "outbox_event",
    ];
    const before = await snapshotTables(db, tables);
    await error(await request(), 401, "AUTH_REQUIRED");
    await error(await request(who, { hasConfirmed: false }), 400, "VALIDATION_FAILED");
    await error(await request(who, { hasConfirmed: true }, null), 400, "IDEMPOTENCY_KEY_REQUIRED");
    await error(
      await request(who, { hasConfirmed: true, merchantUserId: stranger.merchantUserId }),
      400,
      "VALIDATION_FAILED",
    );
    expect(await snapshotTables(db, tables)).toEqual(before);
  });
  it("独立真实clerk无需门店头注销本人；当前及其他设备401，同键重放401，老板/主体仍正常", async () => {
    const owner = await signInAsMerchant(api),
      clerk = await signInAsMerchant(api);
    const device = await signInAsMerchant(api, { phone: clerk.phone });
    const entity = await merchantServicesOf(api.runtime).tenant.createEntity(
      createIdentityContext({
        actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
      }),
    );
    const make = createFactories({ db, clock: api.clock });
    const member = await make.entityMember({
      merchantUserId: clerk.merchantUserId,
      entityId: entity.entityId,
      displayName: "待注销店员",
    });
    await make.storeMember({
      entityMemberId: member.id,
      storeId: entity.storeId,
      addedByMemberId: entity.memberId,
    });
    const key = uuidv7(),
      response = await request(clerk, { hasConfirmed: true }, key);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(DeletionResultSchema.parse(((await response.json()) as { data: unknown }).data)).toEqual(
      { deletedAt: api.clock.now().toISOString() },
    );
    await error(await request(clerk, { hasConfirmed: true }, key), 401, "SESSION_INVALID");
    for (const who of [clerk, device])
      await error(
        await api.request("/api/v1/m/me", { headers: who.headers }),
        401,
        "SESSION_INVALID",
      );
    expect((await api.request("/api/v1/m/me", { headers: owner.headers })).status).toBe(200);
    expect(await db.entityMember.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({
      status: "removed",
      removeReason: "account_deleted",
      displayName: null,
    });
    expect(await db.entity.findUniqueOrThrow({ where: { id: entity.entityId } })).toMatchObject({
      lifecycle: "active",
    });
  });
  it("老板返回真实payment_open阻断；隐私新版待同意仍可注销无成员账号，保留同意证据", async () => {
    const owner = await signInAsMerchant(api),
      plain = await signInAsMerchant(api);
    const entity = await merchantServicesOf(api.runtime).tenant.createEntity(
      createIdentityContext({
        actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
      }),
    );
    const make = createFactories({ db, clock: api.clock });
    await make.billingOrder({ entityId: entity.entityId, status: "pending_payment" });
    const blocked = await error(await request(owner), 409, "ACCOUNT_DELETION_BLOCKED");
    expect(blocked.details!.blockers!.map((row) => DeletionBlockerSchema.parse(row))).toEqual([
      { kind: "payment_open", count: 1 },
    ]);
    expect(
      await db.merchantUser.findUniqueOrThrow({ where: { id: owner.merchantUserId } }),
    ).toMatchObject({ status: "active" });
    await make.agreementVersion({
      agreementKey: "privacy",
      status: "pending",
      effectiveAt: api.clock.now(),
      isReconsentRequired: true,
    });
    merchantServicesOf(api.runtime).identity.consentGate.invalidate();
    const denied = await api.request("/api/v1/m/me", {
      method: "PATCH",
      json: { displayName: "新称呼" },
      headers: { ...plain.headers, "Idempotency-Key": uuidv7() },
    });
    await error(denied, 428, "CONSENT_REQUIRED");
    const consents = await db.agreementConsent.findMany({
      where: { merchantUserId: plain.merchantUserId },
    });
    const result = await request(plain);
    expect(result.status, await result.clone().text()).toBe(200);
    expect(
      await db.agreementConsent.findMany({ where: { merchantUserId: plain.merchantUserId } }),
    ).toEqual(consents);
  });
});
