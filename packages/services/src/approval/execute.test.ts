// 验收第 4 条（任务书 W1-06 第 7 节）：执行与决定分开。有执行步的样例类型通过后，执行是另一个事务：
// 执行抛错，审批单仍是 approved、没有 approval.executed；重试成功后恰一条 approval.executed。
import { describe, expect, it } from "vitest";

import { refusal, SLOW, useApprovalWorld } from "./__fixtures__/world.js";

const world = useApprovalWorld();
const T = { timeout: SLOW };

describe("执行失败不改审批结论（验收 4）", () => {
  it(
    "通过后停在 approved；执行抛错什么都不变；重试成功恰发一条 approval.executed，再记一次也不多发",
    T,
    async () => {
      const { sample, input, prisma } = world;
      const requester = await world.person({ role: "cs" });
      const finance = await world.person();
      const { approvalId } = await sample.submit(
        requester.identity,
        input.orderCancel(await world.merchant()),
      );
      await sample.approve(finance.identity, { approvalId, staff: finance.staff, lockVersion: 0 });
      const approved = {
        status: "approved",
        lockVersion: 1,
        transitions: 2,
        audits: 2,
        events: ["approval.submitted", "approval.approved"],
      };
      expect(await sample.trace(approvalId)).toMatchObject({
        ...approved,
        domain: { status: "pending_execution", approved: 1, executed: 0 },
      });
      const before = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });

      const failed = sample.execute(finance.identity, approvalId, { fail: true });
      expect((await refusal(failed)).error).toBe("PROVIDER_UNAVAILABLE");
      expect(await sample.trace(approvalId)).toMatchObject({
        ...approved,
        domain: { status: "pending_execution", executed: 0 },
      });
      expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } })).toEqual(
        before,
      );

      await sample.execute(finance.identity, approvalId);
      const done = await sample.trace(approvalId);
      expect(done).toMatchObject({ status: "approved", lockVersion: 1, transitions: 2, audits: 2 });
      expect(done.events).toEqual(["approval.submitted", "approval.approved", "approval.executed"]);
      expect(done.domain).toMatchObject({ status: "done", executed: 1 });
      const event = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: approvalId, eventType: "approval.executed" },
      });
      expect(event.payload).toEqual({
        v: 1,
        approvalRequestId: approvalId,
        kind: "order_cancel",
        domainType: "cancel_request",
        domainId: done.domain?.id,
      });
      expect(event.dedupeKey).toBe(`approval.executed:${approvalId}`);

      // 领域一侧重复记执行（回调晚到、补单）：事件按去重键只有一条
      await sample.execute(finance.identity, approvalId);
      expect(
        (await sample.trace(approvalId)).events.filter((type) => type === "approval.executed"),
      ).toHaveLength(1);
    },
  );

  it("没有执行步的类型、还没通过的审批单不能记执行", T, async () => {
    const { sample, input } = world;
    const requester = await world.person({ role: "cs" });
    const merchant = await world.merchant();
    const adjust = await sample.submit(requester.identity, input.pointsAdjust(merchant));
    const cancel = await sample.submit(requester.identity, input.orderCancel(merchant));
    for (const approvalId of [adjust.approvalId, cancel.approvalId]) {
      await expect(sample.execute(requester.identity, approvalId)).rejects.toMatchObject({
        name: "ApprovalError",
        reason: "execution",
      });
      expect((await sample.trace(approvalId)).events).toEqual(["approval.submitted"]);
    }
  });
});
