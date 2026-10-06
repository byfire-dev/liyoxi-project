import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlanContentSchema } from "@liyoxi/contract";
import { useSeededDatabase } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { draft, harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import {
  getPlanBriefByOrder,
  getTicketBriefByOrderItem,
  getTicketBriefsByOrder,
  getTicketTimeline,
} from "./reads.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
describe("公开履约只读聚合", { timeout: 60000 }, () => {
  it("未推送不泄露草稿；推送取最新版本，修订期间仍优先已确认版；公开字典/位置去重/日期一致", async () => {
    const o = await h.order(true, 2),
      a = await h.staff();
    expect(await h.tx.run((tx) => getPlanBriefByOrder(tx, o.order.id))).toMatchObject({
      currentVersionNo: 0,
      summaryVersionNo: null,
      focus: [],
      placements: [],
      launchMode: null,
      agreedLaunchDate: null,
    });
    await h.delivery.replaceDraft(a.ctx, a.staff, o.deliveryPlanId, {
      draftLockVersion: 0,
      content: draft(o),
    });
    await h.delivery.push(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 1 });
    const v = await h.prisma.deliveryPlanVersion.findFirstOrThrow({
      where: { deliveryPlanId: o.deliveryPlanId, versionNo: 1 },
    });
    // 已推送快照固定：覆盖不存在于M1默认草稿的广告位摘要，不修改旧版本。
    const content = PlanContentSchema.parse(v.contentSnapshot);
    for (const i of content.items)
      i.placements = [{ slot: "opening", durationSec: 5, adId: uuidv7() }];
    await h.prisma.deliveryPlanVersion.create({
      data: { ...v, id: uuidv7(), versionNo: 2, contentSnapshot: content, decision: null },
    });
    await h.prisma.deliveryPlan.update({
      where: { id: o.deliveryPlanId },
      data: { currentVersionNo: 2 },
    });
    expect(await h.tx.run((tx) => getPlanBriefByOrder(tx, o.order.id))).toMatchObject({
      summaryVersionNo: 2,
      focus: [{ code: "CF01", name: "测试定制重点" }],
      placements: [{ slot: "opening", durationSec: 5 }],
    });
    await h.prisma.orderItem.updateMany({
      where: { dramaOrderId: o.order.id },
      data: { agreedLaunchDate: new Date("2026-01-20") },
    });
    await h.prisma.deliveryPlan.update({
      where: { id: o.deliveryPlanId },
      data: { confirmedVersionNo: 1, confirmedAt: h.clock.now() },
    });
    const before = await h.prisma.deliveryPlan.findUniqueOrThrow({
      where: { id: o.deliveryPlanId },
    });
    expect(await h.tx.run((tx) => getPlanBriefByOrder(tx, o.order.id))).toMatchObject({
      summaryVersionNo: 1,
      placements: [],
      agreedLaunchDate: "2026-01-20",
    });
    expect(
      await h.prisma.deliveryPlan.findUniqueOrThrow({ where: { id: o.deliveryPlanId } }),
    ).toEqual(before);
    await h.prisma.orderItem.update({
      where: { id: o.items[1]!.id },
      data: { agreedLaunchDate: new Date("2026-01-21") },
    });
    expect(
      (await h.tx.run((tx) => getPlanBriefByOrder(tx, o.order.id)))?.agreedLaunchDate,
    ).toBeNull();
    expect(await h.tx.run((tx) => getPlanBriefByOrder(tx, uuidv7()))).toBeNull();
  });
  it("里程碑取真实列且不以环节进入时间替代，旧阶段读口逐字不变", async () => {
    const o = await h.order(true),
      id = o.deliveryTicketIds[0]!,
      assignedAt = new Date("2026-01-05T01:01:00Z"),
      planConfirmedAt = new Date("2026-01-05T01:02:00Z");
    await h.prisma.deliveryTicket.update({ where: { id }, data: { assignedAt, planConfirmedAt } });
    const stages = await h.tx.run((tx) => getTicketTimeline(tx, id));
    const before = await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } });
    const expected = {
      assignedAt: assignedAt.toISOString(),
      planConfirmedAt: planConfirmedAt.toISOString(),
      adsReadyAt: null,
      sampleConfirmedAt: null,
      deliveredAt: null,
      liveAt: null,
      usageEndedAt: null,
    };
    expect(await h.tx.run((tx) => getTicketBriefByOrderItem(tx, o.items[0]!.id))).toMatchObject(
      expected,
    );
    expect((await h.tx.run((tx) => getTicketBriefsByOrder(tx, o.order.id)))[0]).toMatchObject(
      expected,
    );
    expect(await h.tx.run((tx) => getTicketTimeline(tx, id))).toEqual(stages);
    expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id } })).toEqual(before);
  });
});
