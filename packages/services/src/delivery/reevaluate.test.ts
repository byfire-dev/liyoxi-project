import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import { reevaluate, reevaluateSweep } from "./reevaluate.js";
import { findDeliveryViolations } from "./invariants.js";
import { draft, harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
const ctx = createIdentityContext({ actor: { type: "system", job: "lyxtest.reevaluate" } });
async function atStep(step: string) {
  const o = await h.order(true),
    id = o.deliveryTicketIds[0]!;
  // 停滞反例只造事实；生产只经 flow 迁移。
  await h.prisma.deliveryTicket.update({ where: { id }, data: { step } });
  await h.prisma.deliveryTicketStage.updateMany({
    where: { deliveryTicketId: id, completedAt: null },
    data: { step },
  });
  return { ...o, id };
}
async function task(o: Awaited<ReturnType<typeof atStep>>, status: string, live = false) {
  return h.prisma.launchTask.create({
    data: {
      id: uuidv7(),
      entityId: o.entity.id,
      storeId: o.store.id,
      orderItemId: o.items[0]!.id,
      deliveryTicketId: o.id,
      channelAccountId: o.account.id,
      platform: o.account.platform,
      reviewStatus: status,
      currentRoundNo: status === "pending" ? 0 : 1,
      isLive: live,
      verifiedEpisodeCount: live ? 1 : 0,
      firstLaunchDate: live ? new Date("2026-01-05") : null,
      wentLiveAt: live ? h.clock.now() : null,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
}
describe("六条求值、并发与真实 worker 装配", { timeout: 60000 }, () => {
  it("2、3 行只在方案真实应用后推进；未应用与暂停跳过，第二次零副作用", async () => {
    const o = await h.order(true),
      a = await h.staff(),
      id = o.deliveryTicketIds[0]!;
    await h.delivery.replaceDraft(a.ctx, a.staff, o.deliveryPlanId, {
      draftLockVersion: 0,
      content: draft(o),
    });
    await h.delivery.push(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 1 });
    expect(await h.tx.run((t) => reevaluate(t, h.deps, ctx, id))).toEqual({ moved: 0 });
    await h.delivery.confirm(o.viewer, o.deliveryPlanId, { versionNo: 1 });
    const before = await h.tx.run((t) => h.counts(t, id));
    expect(await h.tx.run((t) => reevaluate(t, h.deps, ctx, id))).toEqual({ moved: 0 });
    expect(await h.tx.run((t) => h.counts(t, id))).toEqual(before);
    const paused = await atStep("ad_prep");
    await h.prisma.deliveryTicket.update({
      where: { id: paused.id },
      data: { pauseCount: 1, pausedAt: h.clock.now() },
    });
    expect(await h.tx.run((t) => reevaluate(t, h.deps, ctx, paused.id))).toEqual({ moved: 0 });
  });
  it.each([
    ["awaiting_launch", "verifying", false, "launch_verify"],
    ["launch_verify", "pending", false, "awaiting_launch"],
    ["awaiting_launch", "passed", true, "in_service"],
    ["launch_verify", "passed", true, "in_service"],
  ] as const)("12–14 行 %s/%s/live=%s → %s", async (step, status, live, to) => {
    const o = await atStep(step);
    await task(o, status, live);
    const before = await h.tx.run((t) => h.counts(t, o.id));
    const callbacks = h.rederivations.length;
    expect(await h.tx.run((t) => reevaluate(t, h.deps, ctx, o.id))).toEqual({ moved: 1 });
    expect(h.rederivations.slice(callbacks)).toEqual([
      {
        steps: [to],
        input: {
          orderItemIds: [o.items[0]!.id],
          launchFacts: expect.objectContaining({
            hasLive: live,
            hasVerifying: status === "verifying",
          }),
        },
      },
    ]);
    expect((await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: o.id } })).step).toBe(
      to,
    );
    expect(await h.tx.run((t) => h.counts(t, o.id))).toEqual({
      history: before.history + 1,
      events: before.events + 1,
      audit: before.audit + 1,
    });
    const after = await h.tx.run((t) => h.counts(t, o.id));
    expect(await h.tx.run((t) => reevaluate(t, h.deps, ctx, o.id))).toEqual({ moved: 0 });
    expect(await h.tx.run((t) => h.counts(t, o.id))).toEqual(after);
  });
  it("迁移后回调读取新步骤；后续失败连订单侧样例写入、步骤与历史一起回滚", async () => {
    const o = await atStep("ad_prep"),
      before = await h.tx.run((t) => h.counts(t, o.id));
    h.rederiveHook.run = async (t, input) => {
      const ticket = await t.deliveryTicket.findUniqueOrThrow({
        where: { orderItemId: input.orderItemIds[0]! },
      });
      expect(ticket.step).toBe("sample_making");
      // 仅测试替身记录观察值，用同一事务验证接收方写入也回滚。
      await t.dramaOrder.update({ where: { id: o.order.id }, data: { note: ticket.step } });
      throw new Error("接收方失败");
    };
    try {
      await expect(h.tx.run((t) => reevaluate(t, h.deps, ctx, o.id))).rejects.toThrow("接收方失败");
    } finally {
      delete h.rederiveHook.run;
    }
    expect((await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: o.id } })).step).toBe(
      "ad_prep",
    );
    expect(
      (await h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: o.order.id } })).note,
    ).toEqual(o.order.note);
    expect(await h.tx.run((t) => h.counts(t, o.id))).toEqual(before);
  });
  it("9 行必须逐集全过且包级 QC 通过；两连接求值只迁移一次", async () => {
    const o = await atStep("batch_compose"),
      a = await h.staff(),
      file = await h.make.fileObject({
        category: "final_episode",
        bucket: "secure",
        scopeType: "store",
        entityId: o.entity.id,
        storeId: o.store.id,
      });
    for (let n = 1; n <= o.items[0]!.episodeCount; n++) {
      const id = uuidv7(),
        qc = await h.prisma.qcRecord.create({
          data: {
            id: uuidv7(),
            entityId: o.entity.id,
            storeId: o.store.id,
            deliveryTicketId: o.id,
            targetType: "episode_output",
            targetId: id,
            checklistCode: "qc.episode",
            checklistVersionNo: 1,
            results: [],
            verdict: "pass",
            inspectedByStaffId: a.row.id,
            inspectedAt: h.clock.now(),
            createdAt: h.clock.now(),
          },
        });
      await h.prisma.episodeOutput.create({
        data: {
          id,
          entityId: o.entity.id,
          storeId: o.store.id,
          deliveryTicketId: o.id,
          episodeNo: n,
          fileId: file.id,
          sizeBytes: 1024,
          status: "qc_passed",
          isCurrent: true,
          qcRecordId: qc.id,
          uploadedByStaffId: a.row.id,
          uploadedAt: h.clock.now(),
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
    }
    expect(await h.tx.run((t) => reevaluate(t, h.deps, ctx, o.id))).toEqual({ moved: 0 });
    await h.prisma.qcRecord.create({
      data: {
        id: uuidv7(),
        entityId: o.entity.id,
        storeId: o.store.id,
        deliveryTicketId: o.id,
        targetType: "delivery_ticket",
        targetId: o.id,
        checklistCode: "qc.package",
        checklistVersionNo: 1,
        results: [],
        verdict: "pass",
        inspectedByStaffId: a.row.id,
        inspectedAt: h.clock.now(),
        createdAt: h.clock.now(),
      },
    });
    const results = await Promise.all([
      h.tx.run((t) => reevaluate(t, h.deps, ctx, o.id)),
      h.tx.run((t) => reevaluate(t, h.deps, ctx, o.id)),
    ]);
    expect(results.map((r) => r.moved).sort()).toEqual([0, 1]);
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: o.id, event: "episodes.all_passed" },
      }),
    ).toBe(1);
  });
  it("补偿一次上报 STUCK、重复无动作", async () => {
    const o = await atStep("ad_prep"),
      before = h.reports.length;
    expect((await reevaluateSweep(h.deps)).moved).toBeGreaterThanOrEqual(1);
    expect(
      h.reports
        .slice(before)
        .filter((r) => r.subject && "id" in r.subject && r.subject.id === o.id),
    ).toHaveLength(1);
    expect((await reevaluateSweep(h.deps)).moved).toBe(0);
    const second = await atStep("ad_prep");
    expect(await h.tx.run((t) => reevaluate(t, h.deps, ctx, second.id))).toEqual({ moved: 1 });
  });
  it("I3 真正自愈并标记 healed；I1/I4/I5/I6 反例检出", async () => {
    const o = await atStep("ad_prep");
    expect(
      (await h.tx.run((t) => findDeliveryViolations(t, "I3"))).some(
        (v) =>
          v.subject &&
          "id" in v.subject &&
          v.subject.id === o.id &&
          v.healed?.action === "reevaluate",
      ),
    ).toBe(true);
    await h.prisma.deliveryTicket.update({ where: { id: o.id }, data: { step: "sample_confirm" } });
    expect(
      (await h.tx.run((t) => findDeliveryViolations(t, "I1"))).some(
        (v) => v.subject && "id" in v.subject && v.subject.id === o.id,
      ),
    ).toBe(true);
    expect(
      (await h.tx.run((t) => findDeliveryViolations(t, "I5"))).some(
        (v) => v.subject && "id" in v.subject && v.subject.id === o.id,
      ),
    ).toBe(true);
    const other = await h.make.drama();
    await h.prisma.deliveryTicket.update({ where: { id: o.id }, data: { dramaId: other.id } });
    expect(
      (await h.tx.run((t) => findDeliveryViolations(t, "I4"))).some(
        (v) => v.subject && "id" in v.subject && v.subject.id === o.id,
      ),
    ).toBe(true);
    await h.prisma.deliveryPlan.update({
      where: { id: o.deliveryPlanId },
      data: { currentVersionNo: 5, status: "pending_confirm", pushedAt: h.clock.now() },
    });
    expect(
      (await h.tx.run((t) => findDeliveryViolations(t, "I6"))).some(
        (v) => v.subject && "id" in v.subject && v.subject.id === o.deliveryPlanId,
      ),
    ).toBe(true);
  });
});
