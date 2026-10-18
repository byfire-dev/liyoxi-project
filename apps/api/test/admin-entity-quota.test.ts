import { beforeAll, describe, expect, it } from "vitest";
import { EntityCardSchema } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff, snapshotTables } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi(),
  SLOW = 120_000;
let api: TestApi, prisma: Awaited<ReturnType<typeof handle.db.prisma>>;
let make: ReturnType<typeof createFactories>,
  admin: SignedInStaff,
  peer = 0;
const TABLES = [
  "entity",
  "store",
  "entity_member",
  "store_member",
  "invitation",
  "billing_account",
  "subscription_term",
  "audit_log",
  "outbox_event",
  "status_transition",
  "timer",
  "idempotency_record",
];
beforeAll(async () => {
  api = await handle.start();
  prisma = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  make = createFactories({ db: prisma, clock: api.clock });
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
}, SLOW);
function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lockVersion: 0,
    confirm: { storeLimitOverride: null, memberLimitOverride: null },
    storeLimitOverride: 3,
    reasonText: "公开测试合同额度调整",
    ...extra,
  };
}
function request(
  id: string,
  json: unknown,
  caller: SignedInStaff | null = admin,
  key: string | null = uuidv7(),
) {
  return api.request(`/api/v1/admin/entities/${id}/quota`, {
    method: "PATCH",
    json,
    headers: {
      ...(caller?.headers ?? { origin: "http://localhost", "x-lyx-admin": "1" }),
      ...(key === null ? {} : { "Idempotency-Key": key }),
    },
    peer: `198.19.57.${++peer}`,
  });
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return EntityCardSchema.parse(((await response.json()) as { data: unknown }).data);
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  const result = await response.json();
  expect(result).toMatchObject({ error: symbol });
  expect(JSON.stringify(result)).not.toMatch(/phoneEnc|phoneBidx|tokenHash|SELECT |UPDATE /);
}

describe("后台主体额度真实PATCH", { timeout: SLOW }, () => {
  it("实际挂载、返回完整Card；一行真实审计和零出站事件/状态迁移", async () => {
    expect(
      HANDLERS.filter((h) => h.route.operationId === "admin.entity.quota.update"),
    ).toHaveLength(1);
    const w = await make.merchant({ verified: true });
    const events = await snapshotTables(prisma, ["outbox_event", "status_transition", "timer"]);
    const card = await data(await request(w.entity.id, body({ memberLimitOverride: 4 })));
    expect(card).toMatchObject({
      entityId: w.entity.id,
      lockVersion: 1,
      owner: { merchantUserId: w.user.id },
      stores: [{ storeId: w.store.id }],
      usage: { storeLimit: 3, memberLimit: 4, storeLimitOverride: 3, memberLimitOverride: 4 },
    });
    expect(JSON.stringify(card)).not.toMatch(/phoneEnc|phoneBidx|tokenHash/);
    const audit = await prisma.auditLog.findMany({
      where: { targetId: w.entity.id, category: "merchant_quota" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      stream: "ops",
      action: "admin.entity.quota.update",
      actorId: admin.staff.id,
      entityId: w.entity.id,
      sessionId: admin.sessionId,
      authMethod: "password+totp",
      reasonText: "公开测试合同额度调整",
      before: { storeLimitOverride: null, memberLimitOverride: null },
      after: { storeLimitOverride: 3, memberLimitOverride: 4 },
    });
    expect(await snapshotTables(prisma, ["outbox_event", "status_transition", "timer"])).toEqual(
      events,
    );
  });

  it("缺省保持、显式null清除、成员0合法，低于used不删任何成员或门店", async () => {
    const w = await make.merchant({ verified: true });
    const second = await make.store({ entityId: w.entity.id });
    const user = await make.merchantUser();
    const member = await make.entityMember({
      entityId: w.entity.id,
      merchantUserId: user.id,
      role: "clerk",
    });
    const before = await snapshotTables(prisma, [
      "store",
      "entity_member",
      "store_member",
      "invitation",
    ]);
    const first = await data(
      await request(w.entity.id, body({ storeLimitOverride: 1, memberLimitOverride: 0 })),
    );
    expect(first.usage).toMatchObject({
      storesUsed: 2,
      seatsUsed: 1,
      storesOver: 1,
      seatsOver: 1,
      isOverLimit: true,
    });
    const clear = body({
      lockVersion: 1,
      confirm: { storeLimitOverride: 1, memberLimitOverride: 0 },
      memberLimitOverride: null,
    });
    delete clear.storeLimitOverride;
    const current = await data(await request(w.entity.id, clear));
    expect(current.usage).toMatchObject({ storeLimitOverride: 1, memberLimitOverride: null });
    expect(current.lockVersion).toBe(2);
    expect(current.stores.map((s) => s.storeId)).toEqual([w.store.id, second.id]);
    expect(await prisma.entityMember.findUnique({ where: { id: member.id } })).toMatchObject({
      status: "active",
    });
    expect(
      await snapshotTables(prisma, ["store", "entity_member", "store_member", "invitation"]),
    ).toEqual(before);
  });

  it("同键原snapshot与一audit，之后新键写不污染缓存；异body同键冲突", async () => {
    const w = await make.merchant({ verified: true }),
      key = uuidv7(),
      input = body();
    const first = await data(await request(w.entity.id, input, admin, key));
    await data(
      await request(
        w.entity.id,
        body({
          lockVersion: 1,
          confirm: { storeLimitOverride: 3, memberLimitOverride: null },
          storeLimitOverride: 7,
        }),
      ),
    );
    const before = await snapshotTables(prisma, TABLES);
    const response = await request(w.entity.id, input, admin, key);
    expect(response.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await data(response)).toEqual(first);
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
    await error(
      await request(w.entity.id, body({ storeLimitOverride: 8 }), admin, key),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
    expect(
      await prisma.auditLog.count({ where: { targetId: w.entity.id, category: "merchant_quota" } }),
    ).toBe(2);
  });

  it.each(["delivery_manager", "cs", "finance"] as const)(
    "真实%s员工无权，不以参数权限放行",
    async (roleKey) => {
      const w = await make.merchant(),
        caller = await signInAsStaff(prisma, { roleKey, now: api.clock.now() });
      const before = await snapshotTables(prisma, TABLES);
      await error(await request(w.entity.id, body(), caller), 403, "PERMISSION_DENIED");
      expect(await snapshotTables(prisma, TABLES)).toEqual(before);
    },
  );

  it("StepUp恰10分钟成功；+1ms同键重放仍403且无业务写", async () => {
    const previous = api.clock.now(),
      w = await make.merchant();
    const caller = await signInAsStaff(prisma, { roleKey: "super_admin", now: previous });
    const key = uuidv7(),
      input = body();
    try {
      api.clock.set(new Date(previous.getTime() + 600_000));
      await data(await request(w.entity.id, input, caller, key));
      const before = await snapshotTables(prisma, TABLES);
      api.clock.set(new Date(previous.getTime() + 600_001));
      await error(await request(w.entity.id, input, caller, key), 403, "STEP_UP_REQUIRED");
      expect(await snapshotTables(prisma, TABLES)).toEqual(before);
    } finally {
      api.clock.set(previous);
    }
  });

  it("当前真实员工角色失权后旧成功键不能绕认证或入口授权", async () => {
    const w = await make.merchant(),
      caller = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
    const key = uuidv7(),
      input = body();
    await data(await request(w.entity.id, input, caller, key));
    await prisma.staff.update({
      where: { id: caller.staff.id },
      data: { staffRoleKey: "finance", staffGroupId: null },
    });
    const before = await snapshotTables(prisma, TABLES);
    await error(await request(w.entity.id, input, caller, key), 403, "PERMISSION_DENIED");
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });

  it.each([
    {
      lockVersion: 99,
      confirm: { storeLimitOverride: 2, memberLimitOverride: 2 },
      expected: "VERSION_CONFLICT",
    },
    {
      lockVersion: 0,
      confirm: { storeLimitOverride: 2, memberLimitOverride: null },
      expected: "CONFIRM_MISMATCH",
    },
    {
      lockVersion: 0,
      confirm: { storeLimitOverride: null, memberLimitOverride: 2 },
      expected: "CONFIRM_MISMATCH",
    },
  ])("版本优先与双回显独立拒绝 %#", async ({ expected, ...values }) => {
    const w = await make.merchant(),
      before = await snapshotTables(prisma, TABLES);
    await error(await request(w.entity.id, body(values)), 409, expected);
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });

  it.each([
    { storeLimitOverride: 0 },
    { memberLimitOverride: -1 },
    { storeLimitOverride: "2" },
    { storeLimitOverride: 2_147_483_648 },
    { lockVersion: -1 },
    { reasonText: "" },
    { reasonText: "🍜".repeat(201) },
    { confirm: { storeLimitOverride: null } },
    { permission: true },
  ])("HTTP严格body边界 %#", async (values) => {
    const w = await make.merchant(),
      before = await snapshotTables(prisma, TABLES);
    await error(await request(w.entity.id, body(values)), 400, "VALIDATION_FAILED");
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });

  it("缺两覆盖、required键、匿名与非法路径各按原HTTP错误拒绝", async () => {
    const w = await make.merchant(),
      before = await snapshotTables(prisma, TABLES);
    const missing = body();
    delete missing.storeLimitOverride;
    await error(await request(w.entity.id, missing), 400, "VALIDATION_FAILED");
    await error(await request(w.entity.id, body(), admin, null), 400, "IDEMPOTENCY_KEY_REQUIRED");
    await error(await request(w.entity.id, body(), null), 401, "AUTH_REQUIRED");
    await error(await request("bad-id", body()), 400, "VALIDATION_FAILED");
    await error(await request(uuidv7(), body()), 404, "NOT_FOUND");
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });
});
