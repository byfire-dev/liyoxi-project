import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChecklistItemsSchema } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { uuidv7 } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { draft } from "./__fixtures__/harness.js";
import { productionHarness } from "./__fixtures__/production-tools.js";
import type { ProductionHarness } from "./__fixtures__/production-tools.js";
import { lockCurrentSampleWatermarkTarget } from "./sample-watermark.js";

const db = useSeededDatabase("services");
let h: ProductionHarness;
beforeAll(async () => {
  h = productionHarness(await db.prisma());
});
afterAll(async () => {
  await h?.close();
});

describe("当前人工质检样片的水印补排父域", { timeout: 60_000 }, () => {
  it("正式上传/体检/人工质检后可锁定；非passQC、暂停、被更新版本取代均拒绝且不改源事实", async () => {
    const o = await h.order(true, 1, undefined, 2),
      editor = await h.staff(),
      qc = await h.staff();
    await h.prisma.drama.update({
      where: { id: o.items[0]!.dramaId },
      data: { isAiGenerated: false },
    });
    await h.delivery.replaceDraft(editor.ctx, editor.staff, o.deliveryPlanId, {
      draftLockVersion: 0,
      content: draft(o),
    });
    await h.delivery.push(editor.ctx, editor.staff, o.deliveryPlanId, { draftLockVersion: 1 });
    await h.delivery.confirm(o.viewer, o.deliveryPlanId, { versionNo: 1 });
    await h.master(o.items[0]!.dramaId, 1, editor.row.id);
    const actor = { identity: editor.ctx, staff: editor.staff },
      bytes = new Uint8Array(1234);
    bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const registered = await h.media.register(actor, {
      category: "sample_video",
      storeId: o.store.id,
      production: {
        kind: "sample",
        orderItemId: o.items[0]!.id,
        episodeNo: 1,
        aiUsage: { used: false, tools: [] },
      },
      files: [{ fileName: "checked.mp4", sizeBytes: String(bytes.length), clientToken: uuidv7() }],
    });
    const file = registered.items[0]!;
    h.fake.storage.put({ bucket: "media", key: file.key }, bytes, "video/mp4");
    await h.media.completeAdmin(actor, file.fileId);
    const promote = await h.prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${file.fileId}` },
    });
    await h.media.promote({ jobId: promote.id });
    const created = await h.delivery.sampleCreate(
      editor.ctx,
      editor.staff,
      o.deliveryTicketIds[0]!,
      { fileId: file.fileId, adSlots: [] },
    );
    await h.finish(file.fileId);
    const template = await h.prisma.checklistTemplate.findFirstOrThrow({
      where: { code: "qc.sample", status: "active" },
    });
    await h.delivery.sampleInspect(qc.ctx, qc.staff, created.sampleId, {
      checklistVersionNo: template.versionNo,
      results: ChecklistItemsSchema.parse(template.items).map(({ key }) => ({
        key,
        result: "pass" as const,
      })),
    });
    const before = await h.prisma.sample.findUniqueOrThrow({ where: { id: created.sampleId } });
    const source = await h.prisma.productionRecord.findUniqueOrThrow({
      where: { fileId: file.fileId },
    });
    const target = () =>
      h.tx.run((tx) => lockCurrentSampleWatermarkTarget(tx, before.id, qc.staff));
    expect(await target()).toMatchObject({
      fileId: file.fileId,
      ticketId: before.deliveryTicketId,
      versionNo: 1,
    });

    // A separate append-only QC fixture proves status alone cannot authorize the action.
    const passedQc = await h.prisma.qcRecord.findUniqueOrThrow({
      where: { id: before.qcRecordId! },
    });
    const failedQc = await h.prisma.qcRecord.create({
      data: {
        ...passedQc,
        id: uuidv7(),
        verdict: "fail",
        rejectReason: "测试拒绝记录",
        results: passedQc.results as Prisma.InputJsonValue,
      },
    });
    await h.prisma.sample.update({ where: { id: before.id }, data: { qcRecordId: failedQc.id } });
    await expect(target()).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await h.prisma.sample.update({ where: { id: before.id }, data: { qcRecordId: passedQc.id } });

    const pause = await h.prisma.deliveryTicketPause.create({
      data: {
        id: uuidv7(),
        deliveryTicketId: before.deliveryTicketId,
        reason: "plan_amendment",
        refType: "delivery_plan_version",
        refId: uuidv7(),
        actorType: "staff",
        actorId: qc.row.id,
        client: "admin",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await h.prisma.deliveryTicket.update({
      where: { id: before.deliveryTicketId },
      data: { pauseCount: 1, pausedAt: h.clock.now() },
    });
    await expect(target()).rejects.toMatchObject({ error: "TICKET_ON_HOLD" });
    await h.prisma.deliveryTicketPause.update({
      where: { id: pause.id },
      data: { releasedAt: h.clock.now(), releaseEvent: "plan_confirmed" },
    });
    await h.prisma.deliveryTicket.update({
      where: { id: before.deliveryTicketId },
      data: { pauseCount: 0, pausedAt: null },
    });

    // A replacement supersedes the old row; the database forbids two unresolved versions.
    await h.prisma.sample.update({ where: { id: before.id }, data: { status: "superseded" } });
    await h.prisma.sample.create({
      data: {
        ...before,
        id: uuidv7(),
        versionNo: 2,
        status: "uploaded",
        qcRecordId: null,
        adSlots: before.adSlots as Prisma.InputJsonValue,
        adVersionsUsed: before.adVersionsUsed as Prisma.InputJsonValue,
      },
    });
    await expect(target()).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(await h.prisma.sample.findUniqueOrThrow({ where: { id: before.id } })).toEqual({
      ...before,
      status: "superseded",
    });
    expect(
      await h.prisma.productionRecord.findUniqueOrThrow({ where: { fileId: file.fileId } }),
    ).toEqual(source);
  });
});
