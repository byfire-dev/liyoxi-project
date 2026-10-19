import { describe, expect, it } from "vitest";

import { refusal, SLOW, useApprovalWorld } from "./__fixtures__/world.js";
import { approvalScopes, findApproval, inScope } from "./repo.js";

const world = useApprovalWorld();
const T = { timeout: SLOW };

describe("主体审批范围", () => {
  it.each(["points_adjust", "subscription_extend"] as const)(
    "%s：另一门店使主体可见，读动作与通过、驳回、代撤使用相同范围",
    T,
    async (kind) => {
      const { prisma, sample } = world;
      await prisma.staffRole.update({ where: { key: "finance" }, data: { dataScope: "own" } });
      const groupId = await world.group("delivery_manager");
      const requester = await world.person({ role: "delivery_manager", groupId });
      const reviewer = await world.person(
        kind === "points_adjust"
          ? { role: "finance" }
          : { role: "delivery_manager", isLead: true, groupId },
      );
      const outside = await world.person({ role: "delivery_manager" });
      const merchant = await world.merchant({ managerId: outside.id });
      await world.make.store({ entityId: merchant.entityId, deliveryManagerId: reviewer.id });
      const foreign = await world.merchant({ managerId: outside.id });
      const input = kind === "points_adjust" ? world.input.pointsAdjust : world.input.extend;
      const submit = (owner = merchant) =>
        sample.submit(requester.identity, { ...input(owner), storeId: owner.storeId });
      const visible = await submit();
      const hidden = await submit(foreign);
      const view = () =>
        sample.tx.run((tx) => sample.approval.decisionView(tx, reviewer.staff, visible.approvalId));

      expect((await view()).actions).toEqual(["approve", "reject"]);
      expect(
        (
          await refusal(
            sample.tx.run((tx) =>
              sample.approval.decisionView(tx, reviewer.staff, hidden.approvalId),
            ),
          )
        ).error,
      ).toBe("NOT_FOUND");
      expect(
        (
          await refusal(
            sample.approve(reviewer.identity, {
              approvalId: hidden.approvalId,
              staff: reviewer.staff,
              lockVersion: 0,
            }),
          )
        ).error,
      ).toBe("PERMISSION_DENIED");
      await sample.approve(reviewer.identity, {
        approvalId: visible.approvalId,
        staff: reviewer.staff,
        lockVersion: 0,
      });
      expect(await sample.trace(visible.approvalId)).toMatchObject({
        status: "approved",
        domain: { approved: 1 },
      });

      const rejected = await submit();
      await sample.reject(reviewer.identity, {
        approvalId: rejected.approvalId,
        staff: reviewer.staff,
        note: "核对后驳回",
      });
      expect((await sample.trace(rejected.approvalId)).status).toBe("rejected");
      const withdrawn = await submit();
      await prisma.staff.update({
        where: { id: requester.id },
        data: { status: "disabled", disabledAt: sample.clock.now(), disabledReason: "other" },
      });
      const refreshed = await world.reload(reviewer);
      expect(
        (
          await sample.tx.run((tx) =>
            sample.approval.decisionView(tx, refreshed.staff, withdrawn.approvalId),
          )
        ).actions,
      ).toContain("withdraw");
      await sample.withdraw(refreshed.identity, {
        approvalId: withdrawn.approvalId,
        staff: refreshed.staff,
      });
      expect((await sample.trace(withdrawn.approvalId)).status).toBe("withdrawn");
      expect(
        await prisma.approvalRequest.findUniqueOrThrow({ where: { id: visible.approvalId } }),
      ).toMatchObject({ entityId: merchant.entityId, storeId: merchant.storeId });
      expect((await sample.trace(hidden.approvalId)).status).toBe("pending");
    },
  );

  it("其它类型保留门店与处理人优先；两类主体审批缺主体时不能回退为全局", T, async () => {
    const reviewer = await world.person({ role: "delivery_manager" });
    const outside = await world.person({ role: "delivery_manager" });
    const admin = await world.person({ role: "super_admin" });
    const merchant = await world.merchant({ managerId: outside.id });
    const owned = await world.make.store({
      entityId: merchant.entityId,
      deliveryManagerId: reviewer.id,
    });
    const { approvalId } = await world.sample.submit(
      merchant.identity,
      world.input.qualification(merchant),
    );
    await world.sample.tx.run(async (tx) => {
      const row = (await findApproval(tx, approvalId))!;
      const ownedRow = { ...row, storeId: owned.id };
      const missing = (["points_adjust", "subscription_extend"] as const).map((kind) => ({
        ...row,
        kind,
        entityId: null,
      }));
      const rows = [row, ownedRow, ...missing];
      const scope = await approvalScopes(tx, reviewer.staff.scope, rows);
      expect(await inScope(tx, reviewer.staff.scope, row, {})).toBe(false);
      expect(scope(row, null)).toBe(false);
      expect(
        await inScope(tx, reviewer.staff.scope, row, { handlerOf: async () => reviewer.id }),
      ).toBe(true);
      expect(scope(row, reviewer.id)).toBe(true);
      expect(
        await inScope(tx, reviewer.staff.scope, ownedRow, { handlerOf: async () => outside.id }),
      ).toBe(false);
      expect(scope(ownedRow, outside.id)).toBe(false);
      const all = await approvalScopes(tx, admin.staff.scope, missing);
      for (const absent of missing) {
        expect(await inScope(tx, reviewer.staff.scope, absent, {})).toBe(false);
        expect(scope(absent, null)).toBe(false);
        expect(await inScope(tx, admin.staff.scope, absent, {})).toBe(false);
        expect(all(absent, null)).toBe(false);
      }
    });
  });
});
