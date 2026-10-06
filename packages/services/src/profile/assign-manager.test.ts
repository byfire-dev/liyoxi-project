import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_SCOPE, ownTaskScope } from "../authz/index.js";
import { createIdentityContext, defineRegistration, implement } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { deliveryManagerPort, orderManagerPort } from "./ports.js";
const db = useSeededDatabase("services");
let h: Harness;
const orderCalls: string[] = [],
  deliveryCalls: string[] = [];
const ctx = createIdentityContext({ actor: { type: "system", job: "lyxtest.profile_assign" } });
beforeAll(async () => {
  h = harness(await db.prisma(), [
    defineRegistration("lyxtest_profile_manager", {
      portImplementations: [
        implement(orderManagerPort, async (_tx, input) => {
          orderCalls.push(input.storeId);
        }),
        implement(deliveryManagerPort, async (_tx, input) => {
          deliveryCalls.push(input.storeId);
        }),
      ],
    }),
  ]);
}, 120000);
describe("首次指派交付经理", () => {
  it("成功同事务写门店且两个下游各一次；重复返回已指派", async () => {
    const { store } = await h.owner(),
      staff = await h.make.staff();
    await h.tx.run((tx) =>
      h.profile.assignDeliveryManager(tx, ctx, { storeId: store.id, staffId: staff.id }),
    );
    expect(
      (await h.prisma.store.findUniqueOrThrow({ where: { id: store.id } })).deliveryManagerId,
    ).toBe(staff.id);
    expect(orderCalls.filter((id) => id === store.id)).toHaveLength(1);
    expect(deliveryCalls.filter((id) => id === store.id)).toHaveLength(1);
    await expect(
      h.tx.run((tx) =>
        h.profile.assignDeliveryManager(tx, ctx, { storeId: store.id, staffId: staff.id }),
      ),
    ).rejects.toMatchObject({ error: "STORE_MANAGER_ASSIGNED" });
  });
  it("接收人停用、角色不符、范围外各自原因准确", async () => {
    const { store } = await h.owner();
    const disabled = await h.make.staff({
      status: "disabled",
      disabledAt: h.clock.now(),
      disabledReason: "resigned",
    });
    const role = await h.make.staff({ staffRoleKey: "editor" });
    const outsider = await h.make.staff();
    for (const [staffId, reason] of [
      [disabled.id, "not_active"],
      [role.id, "role_mismatch"],
    ])
      await expect(
        h.tx.run((tx) =>
          h.profile.assignDeliveryManager(tx, ctx, { storeId: store.id, staffId: staffId! }),
        ),
      ).rejects.toMatchObject({ error: "ASSIGNEE_INVALID", details: { reason } });
    // store 已在操作者可见集合（待分配池），员工集合仍只含本人。
    const scope = ownTaskScope({ id: outsider.id });
    const receiver = await h.make.staff();
    await h.prisma.store.update({
      where: { id: store.id },
      data: { deliveryManagerId: outsider.id },
    });
    await expect(
      h.tx.run((tx) =>
        h.profile.assignDeliveryManager(tx, ctx, {
          storeId: store.id,
          staffId: receiver.id,
          scope,
        }),
      ),
    ).rejects.toMatchObject({ error: "ASSIGNEE_INVALID", details: { reason: "out_of_scope" } });
  });
  it("两人并发只成功一人，员工共享锁先于门店", async () => {
    const { store } = await h.owner(),
      a = await h.make.staff(),
      b = await h.make.staff();
    const results = await Promise.allSettled(
      [a, b].map((staff) =>
        h.tx.run((tx) =>
          h.profile.assignDeliveryManager(tx, ctx, {
            storeId: store.id,
            staffId: staff.id,
            scope: SYSTEM_SCOPE,
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { error: "STORE_MANAGER_ASSIGNED" },
    });
  });
  it("下游抛错门店更新与审计一起回滚", async () => {
    const failing = harness(h.prisma, [
      defineRegistration("lyxtest_profile_fail", {
        portImplementations: [
          implement(orderManagerPort, async () => {
            throw new Error("下游测试失败");
          }),
        ],
      }),
    ]);
    const { store } = await failing.owner(),
      staff = await h.make.staff();
    await expect(
      failing.tx.run((tx) =>
        failing.profile.assignDeliveryManager(tx, ctx, { storeId: store.id, staffId: staff.id }),
      ),
    ).rejects.toThrow("下游测试失败");
    expect(
      (await h.prisma.store.findUniqueOrThrow({ where: { id: store.id } })).deliveryManagerId,
    ).toBeNull();
    expect(
      await h.prisma.auditLog.count({ where: { storeId: store.id, category: "manager_assign" } }),
    ).toBe(0);
  });
});
