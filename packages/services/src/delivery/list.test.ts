import { beforeAll, afterAll, it, expect } from "vitest";
import { TicketListQuerySchema } from "@liyoxi/contract";
import { useSeededDatabase } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { harness, draft } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
it("待办按真实环节/等待方/留痕事实；暂停排除与列表统计同口径", { timeout: 60000 }, async () => {
  const o = await h.order(true, 3),
    a = await h.staff(),
    [plan, sample, release] = o.deliveryTicketIds;
  const list = (todo: "plan_push" | "sample_qc" | "staff_assign") =>
    h.delivery.list(
      a.staff,
      TicketListQuerySchema.parse({ orderId: o.order.id, tab: "all", todo, isPaused: "false" }),
    );
  expect((await list("plan_push")).total).toBe(3);
  await h.delivery.replaceDraft(a.ctx, a.staff, o.deliveryPlanId, {
    draftLockVersion: 0,
    content: draft(o),
  });
  await h.delivery.push(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 1 });
  expect((await list("plan_push")).total).toBe(0);
  await h.delivery.requestChange(o.viewer, o.deliveryPlanId, { kinds: ["other"], note: "请修改" });
  expect((await list("plan_push")).total).toBe(3);
  // PR2 写侧未实现；这里只造真实表事实核验已交付的列表筛选。
  await h.prisma.deliveryTicket.update({
    where: { id: sample },
    data: { step: "sample_making", waitingOn: "staff", editorId: null },
  });
  await h.prisma.deliveryTicket.update({
    where: { id: release },
    data: { step: "delivering", waitingOn: "staff", publisherId: null },
  });
  const file = await h.make.fileObject({
    category: "sample_video",
    bucket: "secure",
    scopeType: "store",
    entityId: o.entity.id,
    storeId: o.store.id,
  });
  const row = await h.prisma.sample.create({
    data: {
      id: uuidv7(),
      entityId: o.entity.id,
      storeId: o.store.id,
      deliveryTicketId: sample!,
      versionNo: 1,
      fileId: file.id,
      adSlots: [],
      adVersionsUsed: [],
      status: "uploaded",
      uploadedByStaffId: a.row.id,
      uploadedAt: h.clock.now(),
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  await h.prisma.productionRecord.create({
    data: {
      fileId: file.id,
      kind: "sample",
      orderItemId: o.items[1]!.id,
      source: "manual_upload",
      productionTier: "standard",
      aiUsage: { used: false },
      aigcState: "not_required",
      pipelineState: "checking",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  expect((await list("sample_qc")).total).toBe(0);
  await h.prisma.productionRecord.update({
    where: { fileId: file.id },
    data: { pipelineState: "ready" },
  });
  expect((await list("sample_qc")).items.map((t) => t.deliveryTicketId)).toEqual([sample]);
  expect((await list("staff_assign")).total).toBe(2);
  await h.prisma.deliveryTicket.update({
    where: { id: sample },
    data: { pauseCount: 1, pausedAt: h.clock.now() },
  });
  expect((await list("sample_qc")).total).toBe(0);
  const qc = await h.prisma.qcRecord.create({
    data: {
      id: uuidv7(),
      entityId: o.entity.id,
      storeId: o.store.id,
      deliveryTicketId: sample!,
      targetType: "sample",
      targetId: row.id,
      checklistCode: "qc.sample",
      checklistVersionNo: 1,
      results: [],
      verdict: "pass",
      inspectedByStaffId: a.row.id,
      inspectedAt: h.clock.now(),
      createdAt: h.clock.now(),
    },
  });
  await h.prisma.sample.update({
    where: { id: row.id },
    data: { status: "qc_passed", qcRecordId: qc.id, durationMs: 1000 },
  });
  await h.prisma.deliveryTicket.update({
    where: { id: sample },
    data: { pauseCount: 0, pausedAt: null },
  });
  expect((await list("sample_qc")).total).toBe(0);
  const query = TicketListQuerySchema.parse({
    orderId: o.order.id,
    tab: "all",
    isPaused: "false",
    todo: "plan_push",
    q: "测试短剧1",
  });
  expect((await h.delivery.list(a.staff, query)).items.map((t) => t.deliveryTicketId)).toEqual([
    plan,
  ]);
  expect((await h.delivery.summary(a.staff, query)).tabs.all).toBe(1);
});
