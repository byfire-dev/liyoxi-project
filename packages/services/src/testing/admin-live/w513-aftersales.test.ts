import { describe, expect, it } from "vitest";
import type { Runtime } from "../../runtime.js";
import { fakeKeyEnv } from "../staff.js";
import {
  assertW513AftersalesScope,
  parseW513AftersalesContext,
  W513AftersalesScopeSchema,
} from "./w513-aftersales.js";

const runId = "a123456789abcdef",
  root = "/owned/checkout/apps/admin/dist/tmp",
  path = `${root}/admin-live-${runId}/context.json`,
  at = new Date("2026-11-01T12:00:00.000Z"),
  id = (index: number) => `019a0000-0000-7000-8000-${String(index).padStart(12, "0")}`;
const scope = {
  runId,
  name: `lyx_test_admin_live_${runId}`,
  prefix: `lyx:test:admin_live_${runId}:`,
  startedAt: at.toISOString(),
  entityId: id(1),
  storeId: id(2),
  merchantUserId: id(3),
  memberId: id(4),
  requesterId: id(5),
  financeId: id(6),
};
const context = (value: unknown = scope) => ({
  fixtures: {
    fixtures: {
      w513: { aftersales: { scope: value }, flow: { scope: { unrelated: true } } },
    },
  },
});
function runtime(changed: { store?: object; finance?: object; member?: object } = {}) {
  const db = {
    entity: {
      findUniqueOrThrow: async () => ({
        id: scope.entityId,
        name: `W513售后主体-${runId}`,
        createdByUserId: scope.merchantUserId,
        createdAt: at,
      }),
    },
    store: {
      findUniqueOrThrow: async () => ({
        id: scope.storeId,
        name: `W513售后门店-${runId}`,
        entityId: scope.entityId,
        createdAt: at,
        ...changed.store,
      }),
    },
    entityMember: {
      findUniqueOrThrow: async () => ({
        entityId: scope.entityId,
        merchantUserId: scope.merchantUserId,
        role: "owner",
        status: "active",
        ...changed.member,
      }),
    },
    staff: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) =>
        where.id === scope.requesterId
          ? { staffRoleKey: "super_admin", status: "active" }
          : {
              staffRoleKey: "finance",
              name: "W513取消审批财务",
              status: "active",
              totpEnrolledAt: at,
              passwordHash: "test-only-bound-password",
              createdAt: at,
              ...changed.finance,
            },
    },
  };
  return {
    clock: { now: () => new Date(at.getTime() + 1000) },
    env: {
      APP_ENV: "test",
      DATABASE_URL: `postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/${scope.name}?options=-c%20role%3Dlyx_app`,
      REDIS_URL: "redis://127.0.0.1:6389/0",
      ...fakeKeyEnv(),
    },
    tx: { run: async (read: (tx: typeof db) => Promise<unknown>) => read(db) },
  } as unknown as Runtime;
}

describe("W513P2 private CLI owned inputs", () => {
  it("只从本轮独立aftersales解析，保留P1数据但不消费其scope", () => {
    expect(parseW513AftersalesContext(context(), path, root)).toEqual(scope);
    expect(W513AftersalesScopeSchema.safeParse({ ...scope, unexpected: true }).success).toBe(false);
  });
  it.each([
    { path: path.replace("/owned/checkout", "/other/checkout"), scope },
    { path, scope: { ...scope, prefix: "lyx:test:other:" } },
    { path, scope: { ...scope, name: "liyoxi" } },
    { path, scope: { ...scope, runId: "b123456789abcdef" } },
  ])("拒绝其他检出/库/Redis前缀/轮次 %#", (input) => {
    expect(() => parseW513AftersalesContext(context(input.scope), input.path, root)).toThrow();
  });
  it("只读核实本轮主体、门店、老板与实际激活的异人财务", async () => {
    await expect(assertW513AftersalesScope(runtime(), scope)).resolves.toEqual(scope);
  });
  it.each([
    { store: { name: `W513工单-${runId}` } },
    { store: { entityId: id(9) } },
    { member: { merchantUserId: id(9) } },
    { finance: { status: "disabled" } },
    { finance: { totpEnrolledAt: null } },
    { finance: { name: "另一个演员" } },
  ])("拒绝借用P1门店、错主体/老板或无效财务 %#", async (changed) => {
    await expect(assertW513AftersalesScope(runtime(changed), scope)).rejects.toThrow();
  });
  it("未来起点与同人申请/审批在任何DB读取前拒绝", async () => {
    const noDb = runtime();
    Object.assign(noDb, {
      tx: {
        run: () => {
          throw new Error("不应读取数据库");
        },
      },
    });
    await expect(
      assertW513AftersalesScope(noDb, {
        ...scope,
        startedAt: new Date(at.getTime() + 2000).toISOString(),
      }),
    ).rejects.toThrow("运行范围不符");
    await expect(
      assertW513AftersalesScope(noDb, {
        ...scope,
        financeId: scope.requesterId,
      }),
    ).rejects.toThrow("运行范围不符");
  });
});
