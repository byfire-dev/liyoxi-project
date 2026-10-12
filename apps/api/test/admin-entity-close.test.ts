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
  "portal_session",
  "billing_account",
  "subscription_term",
  "audit_log",
  "outbox_event",
  "status_transition",
  "timer",
  "idempotency_record",
  "approval_request",
  "cancel_request",
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
    reasonText: "主体已停止经营申请关闭",
    confirm: { activeStoreCount: 1, activeMemberCount: 1 },
    ...extra,
  };
}
function request(
  id: string,
  json: unknown,
  caller: SignedInStaff | null = admin,
  key: string | null = uuidv7(),
) {
  return api.request(`/api/v1/admin/entities/${id}/close`, {
    method: "POST",
    json,
    headers: {
      ...(caller?.headers ?? { origin: "http://localhost", "x-lyx-admin": "1" }),
      ...(key === null ? {} : { "Idempotency-Key": key }),
    },
    peer: `198.19.58.${++peer}`,
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
describe("后台主体关闭真实POST", { timeout: SLOW }, () => {
  it("唯一挂载并返回真实已关闭Card，原核心完成老板与所有门店级联", async () => {
    expect(HANDLERS.filter((h) => h.route.operationId === "admin.entity.close")).toHaveLength(1);
    const w = await make.merchant({ verified: true }),
      second = await make.store({ entityId: w.entity.id });
    const card = await data(
      await request(w.entity.id, body({ confirm: { activeStoreCount: 2, activeMemberCount: 1 } })),
    );
    expect(card).toMatchObject({
      entityId: w.entity.id,
      lifecycle: "closed",
      owner: null,
      lockVersion: w.entity.lockVersion + 1,
      usage: { storesUsed: 0, seatsUsed: 0, activeMemberCount: 0 },
      pendingInvitations: [],
      actions: [],
    });
    expect(card.stores.map((s) => s.storeId).sort()).toEqual([w.store.id, second.id].sort());
    expect(card.stores.every((s) => s.lifecycle === "archived")).toBe(true);
    expect(await prisma.entity.findUnique({ where: { id: w.entity.id } })).toMatchObject({
      lifecycle: "closed",
      closedAt: api.clock.now(),
      lockVersion: w.entity.lockVersion + 1,
    });
    expect(await prisma.entityMember.findMany({ where: { entityId: w.entity.id } })).toMatchObject([
      { status: "removed", removeReason: "entity_closed" },
    ]);
    expect(
      await prisma.store.count({
        where: { entityId: w.entity.id, archiveReason: "entity_closed" },
      }),
    ).toBe(2);
    const audit = await prisma.auditLog.findMany({
      where: { targetId: w.entity.id, action: "tenant.entity.close" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      stream: "ops",
      category: "merchant_lifecycle",
      actorId: admin.staff.id,
      reasonText: "主体已停止经营申请关闭",
    });
    const event = await prisma.outboxEvent.findMany({
      where: { aggregateId: w.entity.id, eventType: "entity.closed" },
    });
    expect(event).toHaveLength(1);
    expect(event[0]?.payload).toEqual({
      v: 1,
      entityId: w.entity.id,
      closedBy: "staff_close",
      fromState: "active",
      toState: "closed",
      transition: "entity.close",
    });
    expect(JSON.stringify(card)).not.toMatch(/phoneEnc|phoneBidx|tokenHash/);
  });
  it("原成功键重放同一Card且零重复级联，异body冲突、新键关闭终态拒绝", async () => {
    const w = await make.merchant(),
      key = uuidv7(),
      input = body();
    const first = await data(await request(w.entity.id, input, admin, key));
    const before = await snapshotTables(prisma, TABLES);
    const replay = await request(w.entity.id, input, admin, key);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await data(replay)).toEqual(first);
    await error(
      await request(w.entity.id, body({ reasonText: "另一份主体停止经营关闭原因" }), admin, key),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    await error(await request(w.entity.id, input), 409, "STATE_NOT_ALLOWED");
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });
  it.each([
    { activeStoreCount: 0, activeMemberCount: 1 },
    { activeStoreCount: 1, activeMemberCount: 0 },
  ])("两项回显独立复核，老板不能按seatsUsed排除 %#", async (confirm) => {
    const w = await make.merchant(),
      before = await snapshotTables(prisma, TABLES);
    await error(await request(w.entity.id, body({ confirm })), 409, "CONFIRM_MISMATCH");
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });
  it.each(["delivery_manager", "cs", "finance"] as const)("真实%s员工无权关闭", async (roleKey) => {
    const w = await make.merchant(),
      caller = await signInAsStaff(prisma, { roleKey, now: api.clock.now() });
    const before = await snapshotTables(prisma, TABLES);
    await error(await request(w.entity.id, body(), caller), 403, "PERMISSION_DENIED");
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });
  it("StepUp恰10分钟可关闭，+1ms旧成功键仍拒绝", async () => {
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
  it("当前真实角色失权后原成功键不能绕授权", async () => {
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
    { reasonText: "字".repeat(9) },
    { reasonText: "🍜".repeat(201) },
    { confirm: { activeStoreCount: 1 } },
    { confirm: { activeMemberCount: 1 } },
    { confirm: { activeStoreCount: "1", activeMemberCount: 1 } },
    { confirm: { activeStoreCount: 1, activeMemberCount: -1 } },
    { confirm: { activeStoreCount: 1, activeMemberCount: 1, seatsUsed: 0 } },
    { lockVersion: 0 },
    { permission: "merchant.entity.close" },
  ])("HTTP严格请求拒绝 %#", async (values) => {
    const w = await make.merchant(),
      before = await snapshotTables(prisma, TABLES);
    await error(await request(w.entity.id, body(values)), 400, "VALIDATION_FAILED");
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });
  it("缺required键、匿名、非法UUID与缺失对象按原HTTP错误且零写入", async () => {
    const w = await make.merchant(),
      before = await snapshotTables(prisma, TABLES);
    await error(await request(w.entity.id, body(), admin, null), 400, "IDEMPOTENCY_KEY_REQUIRED");
    await error(await request(w.entity.id, body(), null), 401, "AUTH_REQUIRED");
    await error(await request("bad-id", body()), 400, "VALIDATION_FAILED");
    await error(await request(uuidv7(), body()), 404, "NOT_FOUND");
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });
});
