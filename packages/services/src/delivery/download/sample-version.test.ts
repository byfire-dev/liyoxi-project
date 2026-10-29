import { afterAll, beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../../kernel/index.js";
import { useSeededDatabase } from "../../testing/index.js";
import { productionHarness as harness } from "../__fixtures__/production-tools.js";
import type { ProductionHarness as Harness } from "../__fixtures__/production-tools.js";
import { createDeliveryDownloads } from "./index.js";
import { checks, meta, sampleReady, snapshot } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(async () => {
  await h?.close();
});
async function pushReplacement(r: Awaited<ReturnType<typeof sampleReady>>) {
  // 合成修改写口属于M5；只造其合法已完成前置，不冒充该写口已实现。
  // 之后的新版本创建、独立QC与推送均走既有真实a用例，保留旧change_requested决定。
  const now = h.clock.now();
  await h.tx.run(async (tx) => {
    await tx.sample.update({
      where: { id: r.sample.sampleId },
      data: {
        status: "change_requested",
        decidedAt: now,
        decidedByUserId: r.o.user.id,
        decideClient: "weapp",
        feedbackKind: "compose",
        feedbackNote: "虚构合成修改意见",
      },
    });
    await tx.deliveryTicketStage.updateMany({
      where: { deliveryTicketId: r.id, completedAt: null },
      data: { completedAt: now, exitEvent: "sample.change_requested", updatedAt: now },
    });
    const previous = await tx.deliveryTicketStage.aggregate({
      where: { deliveryTicketId: r.id, step: "sample_making" },
      _max: { visitNo: true },
    });
    await tx.deliveryTicketStage.create({
      data: {
        id: uuidv7(),
        deliveryTicketId: r.id,
        step: "sample_making",
        visitNo: (previous._max.visitNo ?? 0) + 1,
        enteredAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await tx.deliveryTicket.update({
      where: { id: r.id },
      data: {
        step: "sample_making",
        stepEnteredAt: now,
        waitingOn: "staff",
      },
    });
  });
  const replacement = await r.a.sampleCreate(r.editor.ctx, r.editor.staff, r.id, {
    fileId: r.file.id,
    adSlots: [],
  });
  await r.a.sampleInspect(r.qc.ctx, r.qc.staff, replacement.sampleId, await checks(h, "qc.sample"));
  await r.a.samplePush(r.qc.ctx, r.qc.staff, replacement.sampleId, {});
  expect(replacement.versionNo).toBe(2);
  expect(
    await h.prisma.sample.findUniqueOrThrow({ where: { id: r.sample.sampleId } }),
  ).toMatchObject({ status: "change_requested", versionNo: 1, firstViewedAt: null });
  expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({
    currentSampleVersionNo: 2,
  });
  return replacement;
}
it("合法历史change_requested旧版在新版真实推送后拒绝，零签/零证据；新版相册同样拒绝", async () => {
  const r = await sampleReady(h),
    replacement = await pushReplacement(r),
    before = await snapshot(h),
    calls = h.fake.storage.callsOf("presignGet").length;
  await expect(r.downloads.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toMatchObject({
    error: "STATE_NOT_ALLOWED",
  });
  expect(await snapshot(h)).toEqual(before);
  expect(h.fake.storage.callsOf("presignGet")).toHaveLength(calls);
  await expect(r.downloads.sampleUrl(r.o.viewer, replacement.sampleId, meta)).rejects.toMatchObject(
    {
      error: "FEATURE_DISABLED",
    },
  );
  expect(await snapshot(h)).toEqual(before);
  expect(h.fake.storage.callsOf("presignGet")).toHaveLength(calls);
}, 60000);
it("相册请求不进入签名回调，不能在外部IO中修改当前版本或写查看事实", async () => {
  const r = await sampleReady(h),
    before = await snapshot(h);
  let signed = 0;
  const downloads = createDeliveryDownloads({
    ...h.deps,
    media: {
      deliveryProductionFacts: h.media.deliveryProductionFacts,
      signDeliveryDownload: async (input) => {
        signed++;
        await pushReplacement(r);
        return h.media.signDeliveryDownload(input);
      },
    },
  });
  await expect(downloads.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toMatchObject({
    error: "FEATURE_DISABLED",
  });
  expect(signed).toBe(0);
  expect(await snapshot(h)).toEqual(before);
  expect(
    await h.prisma.auditLog.count({
      where: {
        action: "delivery.sample.album_download",
        targetId: r.sample.sampleId,
      },
    }),
  ).toBe(0);
  expect(
    (await h.prisma.sample.findUniqueOrThrow({ where: { id: r.sample.sampleId } })).firstViewedAt,
  ).toBeNull();
}, 60000);
