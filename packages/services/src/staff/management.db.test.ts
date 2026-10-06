// W1-01b：员工创建的事务边界、并发唯一约束、分配端口的共享锁顺序。
import { defaultRoleActions, STAFF_ROLE_DEFAULTS, StaffCreateBodySchema } from "@liyoxi/contract";
import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";

import { buildStaffContext, normalizeRoleConfig } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import { createTestStaffAuth, signInAsStaff, useSeededDatabase } from "../testing/index.js";
import type { TestStaffAuth } from "../testing/index.js";
import { nextPhone, SLOW } from "./__fixtures__/staff.js";
import { pickNext, staffBriefs } from "./assignment.js";
import { seedDemoStaff } from "./demo-seed.js";
import { createStaffManagement } from "./management.js";
import type { StaffManagementDeps } from "./management.js";

const db = useSeededDatabase("services");
let prisma: PrismaClient;
let harness: TestStaffAuth;
let ctx: StaffContext;
let deps: StaffManagementDeps;
let actor: ReturnType<typeof createIdentityContext>;

beforeAll(async () => {
  prisma = await db.prisma();
  harness = createTestStaffAuth(prisma);
  const owner = await signInAsStaff(prisma, { roleKey: "super_admin" });
  const defaults = STAFF_ROLE_DEFAULTS.find((role) => role.key === "super_admin")!;
  ctx = buildStaffContext({
    staff: {
      id: owner.staff.id,
      roleKey: "super_admin",
      isLead: false,
      staffGroupId: owner.staff.staffGroupId,
    },
    role: normalizeRoleConfig("super_admin", {
      ...defaults,
      actions: defaultRoleActions("super_admin"),
    }),
    groupStaffIds: [],
    stepUpAt: harness.clock.now(),
  });
  actor = createIdentityContext({ actor: { type: "staff", id: owner.staff.id, client: "admin" } });
  deps = {
    tx: harness.tx,
    clock: harness.clock,
    flow: harness.flow,
    keyring: () => harness.keyring,
    config: {
      flags: { value: async () => false },
      dicts: { label: async () => null },
    } as unknown as StaffManagementDeps["config"],
  };
}, SLOW);

describe("员工创建的原子性与手机号并发", { timeout: SLOW }, () => {
  it("新增的状态历史、脱敏审计与出站事件各一；事务提交前失败则全部回滚", async () => {
    const phone = nextPhone();
    const result = await createStaffManagement(deps).create(
      ctx,
      actor,
      StaffCreateBodySchema.parse({
        name: "事务员工",
        phone,
        roleKey: "editor",
        activateNow: true,
      }),
    );
    const id = result.staff.staffId;
    expect(await prisma.statusTransition.findMany({ where: { subjectId: id } })).toMatchObject([
      { machine: "staff", fromState: null, toState: "active", event: "staff.create" },
    ]);
    const audit = await prisma.auditLog.findMany({ where: { targetId: id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      stream: "ops",
      category: "staff_authz",
      action: "sys.staff.create",
      after: { phone: result.staff.phoneMask },
    });
    expect(JSON.stringify(audit[0]!.after)).not.toContain(phone);
    expect(await prisma.outboxEvent.findMany({ where: { aggregateId: id } })).toMatchObject([
      { eventType: "staff.created", payload: { v: 1, staffId: id, roleKey: "editor" } },
    ]);

    const counts = async () =>
      Promise.all([
        prisma.staff.count(),
        prisma.staffActivation.count(),
        prisma.statusTransition.count(),
        prisma.auditLog.count(),
        prisma.outboxEvent.count(),
      ]);
    const before = await counts();
    const broken = createStaffManagement({
      ...deps,
      flow: {
        transition: async (...args) => {
          await harness.flow.transition(...args);
          throw new Error("提交前故障");
        },
      },
    });
    await expect(
      broken.create(
        ctx,
        actor,
        StaffCreateBodySchema.parse({
          name: "应回滚",
          phone: nextPhone(),
          roleKey: "cs",
          activateNow: true,
        }),
      ),
    ).rejects.toThrow("提交前故障");
    expect(await counts()).toEqual(before);
  });

  it("相同手机号的两个独立事务只成功一个，另一个映射为 STAFF_PHONE_TAKEN", async () => {
    const input = StaffCreateBodySchema.parse({
      name: "并发员工",
      phone: nextPhone(),
      roleKey: "cs",
      activateNow: false,
    });
    const service = createStaffManagement(deps);
    const results = await Promise.allSettled([
      service.create(ctx, actor, input),
      service.create(ctx, actor, input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect(failed).toMatchObject({ status: "rejected", reason: { error: "STAFF_PHONE_TAKEN" } });
    const rows = await prisma.staff.findMany({ where: { name: "并发员工" } });
    expect(rows).toHaveLength(1);
    expect(await prisma.statusTransition.count({ where: { subjectId: rows[0]!.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { targetId: rows[0]!.id } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: rows[0]!.id } })).toBe(1);
  });
});

describe("员工分配与摘要边界", { timeout: SLOW }, () => {
  it("演示默认交付经理跨城市一致；非启用/空池不返回，批量摘要仅有展示列", async () => {
    const demo = await seedDemoStaff({ ...harness, appEnv: "test" });
    const manager = demo.staff.find((member) => member.key === "delivery_manager")!;
    await harness.tx.run(async (tx) => {
      expect(await pickNext(tx, "delivery_manager", "510100")).toMatchObject({
        staffId: manager.staffId,
      });
      expect(await pickNext(tx, "delivery_manager", "440300")).toMatchObject({
        staffId: manager.staffId,
      });
      const briefs = await staffBriefs(tx, [manager.staffId, manager.staffId, uuidv7()]);
      expect(briefs).toHaveLength(1);
      expect(Object.keys(briefs[0]!).sort()).toEqual(
        ["staffId", "staffNo", "name", "roleKey", "isLead", "status"].sort(),
      );
    });
    await prisma.staff.update({ where: { id: manager.staffId }, data: { status: "pending" } });
    expect(await harness.tx.run((tx) => pickNext(tx, "delivery_manager", "510100"))).toBeNull();
    expect(await harness.tx.run((tx) => pickNext(tx, "cs", ""))).toBeNull();
    await prisma.staff.update({ where: { id: manager.staffId }, data: { status: "active" } });
  });

  it("共享员工锁必须在业务行前；反序会被内核断言阻止", async () => {
    await harness.tx.run(async (tx) => {
      expect(await pickNext(tx, "delivery_manager", "")).not.toBeNull();
      await lockRows(tx, "store", [uuidv7()], "share");
    });
    await expect(
      harness.tx.run(async (tx) => {
        await lockRows(tx, "store", [uuidv7()], "share");
        await pickNext(tx, "delivery_manager", "");
      }),
    ).rejects.toThrow(/加锁顺序反了/);
    const snapshot = await prisma.assignmentCursor.count();
    expect(snapshot).toBe(0);
    expect(await prisma.assignmentHistory.count()).toBe(0);
  });
});
