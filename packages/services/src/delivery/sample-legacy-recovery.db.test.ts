import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChecklistItemsSchema } from "@liyoxi/contract";
import { AppError, uuidv7 } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { draft } from "./__fixtures__/harness.js";
import { productionHarness } from "./__fixtures__/production-tools.js";
import type { ProductionHarness } from "./__fixtures__/production-tools.js";
import { checked } from "./machines.js";
import { lockTickets } from "./repo.js";
import { createDelivery } from "./service.js";

const db = useSeededDatabase("services");
let h: ProductionHarness;
beforeAll(async () => {
  h = productionHarness(await db.prisma());
});
afterAll(async () => {
  await h?.close();
});

async function checks() {
  const template = await h.prisma.checklistTemplate.findFirstOrThrow({
    where: { code: "qc.sample", status: "active" },
  });
  return {
    checklistVersionNo: template.versionNo,
    results: ChecklistItemsSchema.parse(template.items).map((item) => ({
      key: item.key,
      result: "pass" as const,
    })),
  };
}

async function legacy() {
  const o = await h.order(true, 1, undefined, 2),
    editor = await h.staff(),
    qc = await h.staff(),
    item = o.items[0]!,
    ticketId = o.deliveryTicketIds[0]!;
  await h.prisma.drama.update({
    where: { id: item.dramaId },
    data: { isAiGenerated: false, synopsis: "历史样片受控恢复验收" },
  });
  await h.delivery.replaceDraft(editor.ctx, editor.staff, o.deliveryPlanId, {
    draftLockVersion: 0,
    content: draft(o),
  });
  await h.delivery.push(editor.ctx, editor.staff, o.deliveryPlanId, { draftLockVersion: 1 });
  await h.delivery.confirm(o.viewer, o.deliveryPlanId, { versionNo: 1 });
  await h.master(item.dramaId, 1, editor.row.id);
  const actor = { identity: editor.ctx, staff: editor.staff },
    bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const registered = await h.media.register(actor, {
    category: "sample_video",
    storeId: o.store.id,
    production: {
      kind: "sample",
      orderItemId: item.id,
      episodeNo: 1,
      aiUsage: { used: false, tools: [] },
    },
    files: [{ fileName: "legacy.mp4", sizeBytes: String(bytes.length), clientToken: uuidv7() }],
  });
  const file = registered.items[0]!;
  h.fake.storage.put({ bucket: "media", key: file.key }, bytes, "video/mp4");
  await h.media.completeAdmin(actor, file.fileId);
  const promote = await h.prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.fileId}` },
  });
  await h.media.promote({ jobId: promote.id });
  await h.finish(file.fileId, true);
  const created = await h.delivery.sampleCreate(editor.ctx, editor.staff, ticketId, {
    fileId: file.fileId,
    adSlots: [],
  });
  await h.delivery.sampleInspect(qc.ctx, qc.staff, created.sampleId, await checks());
  await h.delivery.samplePush(qc.ctx, qc.staff, created.sampleId, {});
  // Explicit historical fixture only; the production recovery never rewrites these facts.
  const source = await h.prisma.sample.update({
    where: { id: created.sampleId },
    data: { previewChannels: ["album", "portal"], firstViewedAt: h.clock.now() },
  });
  return { o, editor, qc, item, ticketId, source };
}

async function snapshot() {
  return {
    samples: await h.prisma.sample.findMany({ orderBy: { id: "asc" } }),
    tickets: await h.prisma.deliveryTicket.findMany({ orderBy: { id: "asc" } }),
    stages: await h.prisma.deliveryTicketStage.findMany({ orderBy: { id: "asc" } }),
    qc: await h.prisma.qcRecord.count(),
    history: await h.prisma.statusTransition.count(),
    audit: await h.prisma.auditLog.count(),
    events: await h.prisma.outboxEvent.count(),
    refs: await h.prisma.fileRef.count(),
  };
}

describe("Q9历史样片恢复的事务边界", { timeout: 60_000 }, () => {
  it("所有拒绝和末端失败零业务副作用；专用flow标记限定自循环，新版独立QC且不重置环节", async () => {
    const { o, editor, qc, item, ticketId, source } = await legacy(),
      unrelated = await legacy(),
      body = {
        legacyRecovery: {
          versionNo: source.versionNo,
          reason: "历史样片改由小程序查看并重新质检",
          quality: await checks(),
        },
      },
      before = await snapshot();
    const deny = async (run: () => Promise<unknown>, error: string) => {
      await expect(run()).rejects.toMatchObject({ error });
      expect(await snapshot()).toEqual(before);
    };
    await deny(() => h.delivery.samplePush(qc.ctx, qc.staff, source.id, {}), "STATE_NOT_ALLOWED");
    await deny(
      () => h.delivery.samplePush(editor.ctx, editor.staff, source.id, body),
      "QC_SELF_INSPECTION",
    );
    const noQc = {
      ...qc.staff,
      permissions: new Set([...qc.staff.permissions].filter((key) => key !== "delivery.sample.qc")),
    };
    await deny(() => h.delivery.samplePush(qc.ctx, noQc, source.id, body), "PERMISSION_DENIED");
    await deny(
      () =>
        createDelivery({ ...h.deps, samplePlayback: async () => false }).samplePush(
          qc.ctx,
          qc.staff,
          source.id,
          body,
        ),
      "FEATURE_DISABLED",
    );
    await deny(
      () => h.delivery.samplePush(qc.ctx, qc.staff, source.id, { ...body, includeWecom: true }),
      "VALIDATION_FAILED",
    );
    await deny(
      () =>
        h.delivery.samplePush(qc.ctx, qc.staff, source.id, {
          legacyRecovery: { ...body.legacyRecovery, versionNo: source.versionNo + 1 },
        }),
      "SAMPLE_VERSION_STALE",
    );
    await deny(
      () =>
        h.delivery.samplePush(qc.ctx, qc.staff, source.id, {
          legacyRecovery: { ...body.legacyRecovery, reason: "过短" },
        }),
      "VALIDATION_FAILED",
    );
    await deny(
      () =>
        h.delivery.samplePush(qc.ctx, qc.staff, source.id, {
          legacyRecovery: {
            ...body.legacyRecovery,
            quality: { ...body.legacyRecovery.quality, checklistVersionNo: 32767 },
          },
        }),
      "CHECKLIST_VERSION_STALE",
    );
    await deny(
      () =>
        h.delivery.samplePush(qc.ctx, qc.staff, source.id, {
          legacyRecovery: {
            ...body.legacyRecovery,
            quality: { ...body.legacyRecovery.quality, results: [] },
          },
        }),
      "CHECKLIST_NOT_PASSED",
    );
    const failureKey = body.legacyRecovery.quality.results.find(
      (row) => row.key !== "ai_label",
    )!.key;
    await deny(
      () =>
        h.delivery.samplePush(qc.ctx, qc.staff, source.id, {
          legacyRecovery: {
            ...body.legacyRecovery,
            quality: {
              ...body.legacyRecovery.quality,
              results: body.legacyRecovery.quality.results.map((row) =>
                row.key === failureKey
                  ? { ...row, result: "fail" as const, note: "本次检查未通过" }
                  : row,
              ),
            },
          },
        }),
      "CHECKLIST_NOT_PASSED",
    );
    const rejectedCurrent = async (error: string) => {
      const current = await snapshot();
      await expect(h.delivery.samplePush(qc.ctx, qc.staff, source.id, body)).rejects.toMatchObject({
        error,
      });
      expect(await snapshot()).toEqual(current);
    };
    // Keep the pushed-row QC CHECK valid while pointing at another real sample's passing QC.
    await h.prisma.sample.update({
      where: { id: source.id },
      data: { qcRecordId: unrelated.source.qcRecordId },
    });
    await rejectedCurrent("STATE_NOT_ALLOWED");
    await h.prisma.sample.update({
      where: { id: source.id },
      data: { qcRecordId: source.qcRecordId },
    });
    await h.prisma.sample.update({
      where: { id: source.id },
      data: { previewChannels: ["weapp"] },
    });
    await rejectedCurrent("STATE_NOT_ALLOWED");
    await h.prisma.sample.update({
      where: { id: source.id },
      data: { previewChannels: source.previewChannels },
    });
    await h.prisma.deliveryTicket.update({
      where: { id: ticketId },
      data: { pauseCount: 1, pausedAt: h.clock.now() },
    });
    await rejectedCurrent("TICKET_ON_HOLD");
    await h.prisma.deliveryTicket.update({
      where: { id: ticketId },
      data: { pauseCount: 0, pausedAt: null },
    });
    const watermark = await h.prisma.playableAsset.findFirstOrThrow({
      where: { sourceFileId: source.fileId, kind: "sample" },
    });
    await h.prisma.playableAsset.update({ where: { id: watermark.id }, data: { state: "failed" } });
    await rejectedCurrent("SAMPLE_PREVIEW_NOT_READY");
    await h.prisma.playableAsset.update({
      where: { id: watermark.id },
      data: { state: watermark.state },
    });
    expect(await snapshot()).toEqual(before);
    await deny(
      () =>
        h.tx.run(async (tx) => {
          await lockTickets(tx, [ticketId]);
          return h.flow.transition(tx, qc.ctx, {
            machine: "delivery_ticket",
            stateField: "step",
            id: ticketId,
            event: "sample.pushed",
            to: "sample_confirm",
            ref: "10:175",
            args: checked(),
            emit: { none: true, primary: "sample.pushed" },
          });
        }),
      "STATE_NOT_ALLOWED",
    );
    h.rederiveHook.run = async () => {
      throw new AppError("INTERNAL");
    };
    try {
      await deny(() => h.delivery.samplePush(qc.ctx, qc.staff, source.id, body), "INTERNAL");
    } finally {
      delete h.rederiveHook.run;
    }
    const enabled = await h.delivery.get(qc.staff, ticketId);
    expect(enabled.currentSample?.actions).toContain("recover_legacy");
    expect((await h.delivery.get(editor.staff, ticketId)).currentSample?.actions).not.toContain(
      "recover_legacy",
    );
    h.clock.advance(60_000);
    const recovered = await h.delivery.samplePush(qc.ctx, qc.staff, source.id, body),
      after = await snapshot(),
      newSample = after.samples.find((row) => row.id === recovered.sampleId)!;
    expect(recovered).toMatchObject({ versionNo: 2, status: "pushed", previewChannels: ["weapp"] });
    expect(newSample.id).not.toBe(source.id);
    expect(newSample).toMatchObject({
      fileId: source.fileId,
      uploadedByStaffId: source.uploadedByStaffId,
      uploadedAt: source.uploadedAt,
      firstViewedAt: null,
      viewedAckAt: null,
      decidedAt: null,
      offlineSentAt: null,
    });
    const oldAfter = after.samples.find((row) => row.id === source.id)!;
    expect(oldAfter).toEqual({
      ...source,
      status: "superseded",
      lockVersion: source.lockVersion + 1,
      updatedAt: h.clock.now(),
    });
    expect(newSample.qcRecordId).not.toBe(source.qcRecordId);
    expect(
      await h.prisma.qcRecord.findUnique({ where: { id: newSample.qcRecordId! } }),
    ).toMatchObject({ targetId: newSample.id, inspectedByStaffId: qc.row.id, verdict: "pass" });
    const oldTicket = before.tickets.find((row) => row.id === ticketId)!;
    expect(after.tickets.find((row) => row.id === ticketId)).toMatchObject({
      step: oldTicket.step,
      stepEnteredAt: oldTicket.stepEnteredAt,
      stepDueAt: oldTicket.stepDueAt,
      sampleFirstPushedAt: oldTicket.sampleFirstPushedAt,
      sampleRoundNo: oldTicket.sampleRoundNo,
      currentSampleVersionNo: 2,
    });
    expect(after.stages).toEqual(before.stages);
    expect(after.qc).toBe(before.qc + 1);
    expect(await h.prisma.statusTransition.count({ where: { subjectId: newSample.id } })).toBe(3);
    const merchant = await h.delivery.merchantSample(o.viewer, item.id);
    expect(merchant).toMatchObject({
      sampleId: newSample.id,
      versionNo: 2,
      confirmableVia: ["weapp"],
    });
    expect(merchant?.playable?.sources).toHaveLength(1);
  });
});
