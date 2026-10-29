import type { Prisma } from "@liyoxi/db";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  ChecklistItemsSchema,
  AdminSampleWriteResultSchema,
  SampleWriteResultSchema,
  EpisodeRegisterResultSchema,
  EpisodeGridSchema,
  InspectEpisodesResultSchema,
  InspectPackageResultSchema,
  PushPackageResultSchema,
  DeliveryTicketDetailSchema,
  SampleViewSchema,
} from "@liyoxi/contract";
import { useSeededDatabase } from "../testing/index.js";
import { record } from "../audit/index.js";
import type { IdentityContext, IdempotencyContext } from "../kernel/index.js";
import { createIdempotencyContext, uuidv7 } from "../kernel/index.js";
import { findI2Violations, findI14Violations } from "../media/index.js";
import { findDeliveryViolations } from "./invariants.js";
import { createDelivery } from "./service.js";
import { draft } from "./__fixtures__/harness.js";
import { productionHarness } from "./__fixtures__/production-tools.js";
import type { ProductionHarness as Harness } from "./__fixtures__/production-tools.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = productionHarness(await db.prisma());
}, 120000);
afterAll(async () => {
  await h?.close();
});
async function ready() {
  const poster = await h.make.fileObject(),
    o = await h.order(true, 1, poster.id, 2),
    editor = await h.staff(),
    qc = await h.staff();
  // 种子协议的虚构 PDF 由工厂直接建行；补齐真实引用后才核全装配 I14。
  const versions = await h.prisma.agreementVersion.findMany();
  const refs = versions
    .flatMap((v) => [
      ...(v.sourceFileId ? [{ fileId: v.sourceFileId, refId: v.id, role: "source" }] : []),
      ...(v.pdfFileId ? [{ fileId: v.pdfFileId, refId: v.id, role: "pdf" }] : []),
    ])
    .sort((a, b) => a.fileId.localeCompare(b.fileId));
  await h.tx.run(async (tx) => {
    for (const ref of refs)
      await h.media.link(tx, {
        ...ref,
        refType: "agreement_version",
        entityId: null,
        storeId: null,
      });
  });
  await h.prisma.drama.update({
    where: { id: o.items[0]!.dramaId },
    data: { synopsis: "门店定制虚构验收短剧简介" },
  });
  await h.delivery.replaceDraft(editor.ctx, editor.staff, o.deliveryPlanId, {
    draftLockVersion: 0,
    content: draft(o),
  });
  await h.delivery.push(editor.ctx, editor.staff, o.deliveryPlanId, { draftLockVersion: 1 });
  await h.delivery.confirm(o.viewer, o.deliveryPlanId, { versionNo: 1 });
  return { o, editor, qc, id: o.deliveryTicketIds[0]!, item: o.items[0]! };
}
async function file(
  o: Awaited<ReturnType<typeof ready>>["o"],
  category: "sample_video" | "final_episode",
  editor: Awaited<ReturnType<Harness["staff"]>>,
  episodeNo = 1,
  used = false,
  onRegistered?: (fileId: string, clientToken: string) => Promise<void>,
) {
  await h.master(o.items[0]!.dramaId, episodeNo, editor.row.id);
  const actor = { identity: editor.ctx, staff: editor.staff },
    bytes = new Uint8Array(1234),
    clientToken = uuidv7();
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const registration = await h.media.register(actor, {
    category,
    storeId: o.store.id,
    production: {
      kind: category === "sample_video" ? "sample" : "final",
      orderItemId: o.items[0]!.id,
      episodeNo,
      aiUsage: { used, tools: [] },
    },
    files: [{ fileName: `test-${episodeNo}.mp4`, sizeBytes: String(bytes.length), clientToken }],
  });
  const entry = registration.items[0]!;
  await onRegistered?.(entry.fileId, clientToken);
  h.fake.storage.put(
    {
      bucket: "media",
      key: entry.key,
    },
    bytes,
    "video/mp4",
  );
  await h.media.completeAdmin(actor, entry.fileId);
  const job = await h.prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${entry.fileId}` },
  });
  await h.media.promote({ jobId: job.id });
  const result = await h.prisma.fileObject.findUniqueOrThrow({ where: { id: entry.fileId } });
  expect(result.status).toBe("stored");
  expect(
    (await h.prisma.productionRecord.findUniqueOrThrow({ where: { fileId: result.id } }))
      .pipelineState,
  ).toBe("uploading");
  return result;
}
async function checks(code: string) {
  const t = await h.prisma.checklistTemplate.findFirstOrThrow({
    where: { code, status: "active" },
  });
  return {
    checklistVersionNo: t.versionNo,
    results: ChecklistItemsSchema.parse(t.items).map((i) => ({
      key: i.key,
      result: "pass" as const,
    })),
  };
}
async function evidence(sid: string, o: Awaited<ReturnType<typeof ready>>["o"]) {
  await h.tx.run((tx) =>
    record(
      tx,
      o.viewer.ctx.actor,
      { requestId: null, ip: null, userAgent: null, sessionId: null, authMethod: null },
      {
        stream: "access",
        category: "delivery",
        action: "delivery.sample.album_download",
        summary: "虚构测试相册查看证据",
        target: { type: "sample", id: sid },
        entityId: o.entity.id,
        storeId: o.store.id,
      },
    ),
  );
}
async function replay<T>(
  scope: string,
  actor: IdentityContext["actor"],
  body: unknown,
  run: (o: { idem: IdempotencyContext }) => Promise<T>,
  redact: readonly string[] = [],
) {
  const key = uuidv7(),
    idem = () =>
      createIdempotencyContext({
        mode: "required",
        scope,
        actor,
        key,
        request: { method: "POST", body },
        redact,
      });
  const first = await run({ idem: idem() }),
    snapshot = async () =>
      Promise.all([
        h.prisma.statusTransition.count(),
        h.prisma.auditLog.count(),
        h.prisma.outboxEvent.count(),
        h.prisma.qcRecord.count(),
        h.prisma.sample.count(),
        h.prisma.episodeOutput.count(),
        h.prisma.deliveryRelease.count(),
        h.prisma.downloadGrant.count(),
        h.prisma.launchTask.count(),
      ]);
  const before = await snapshot(),
    again = await run({ idem: idem() });
  expect(again).toMatchObject({ replayed: true });
  expect(await snapshot()).toEqual(before);
  if (scope.startsWith("admin.sample") || scope === "admin.deliveryTicket.sample.create")
    expect(again).toMatchObject({ preview: null });
  return first;
}
describe("delivery PR2 十 API 真库主链", { timeout: 60000 }, () => {
  it("样片上传/独立质检/推送/证据确认，样片采用首集+成片次集、两级质检、真实授权与上线任务", async () => {
    const { o, editor, qc, id, item } = await ready(),
      f = await file(o, "sample_video", editor);
    await h.finish(f.id, true);
    const sampleBody = { fileId: f.id, adSlots: [] };
    const s = await replay(
      "admin.deliveryTicket.sample.create",
      editor.ctx.actor,
      sampleBody,
      (o) => h.delivery.sampleCreate(editor.ctx, editor.staff, id, sampleBody, o),
      ["preview", "decision.feedbackImages"],
    );
    expect(AdminSampleWriteResultSchema.parse(s).status).toBe("uploaded");
    await expect(
      h.delivery.sampleInspect(editor.ctx, editor.staff, s.sampleId, await checks("qc.sample")),
    ).rejects.toMatchObject({ error: "QC_SELF_INSPECTION" });
    const sampleQc = await checks("qc.sample"),
      inspected = await replay(
        "admin.sample.inspect",
        qc.ctx.actor,
        sampleQc,
        (o) => h.delivery.sampleInspect(qc.ctx, qc.staff, s.sampleId, sampleQc, o),
        ["preview", "decision.feedbackImages"],
      );
    expect(AdminSampleWriteResultSchema.parse(inspected).status).toBe("qc_passed");
    const pushed = await replay(
      "admin.sample.push",
      qc.ctx.actor,
      {},
      (o) => h.delivery.samplePush(qc.ctx, qc.staff, s.sampleId, {}, o),
      ["preview", "decision.feedbackImages"],
    );
    expect(pushed.previewChannels).toEqual(["weapp"]);
    expect(pushed.durationMs).toBe(60000);
    const before = await h.tx.run((tx) => h.counts(tx, s.sampleId));
    const page = SampleViewSchema.parse(await h.delivery.merchantSample(o.viewer, item.id));
    expect(page.confirmableVia).toEqual(["weapp"]);
    expect(page.playable?.sources).toHaveLength(1);
    expect(await h.tx.run((tx) => h.counts(tx, s.sampleId))).toEqual(before);
    await expect(
      h.delivery.sampleConfirm(o.viewer, s.sampleId, {
        versionNo: 1,
        viewedVia: "album",
        hasViewed: true,
      }),
    ).rejects.toMatchObject({
      error: "SAMPLE_VIEW_CHANNEL_NOT_OFFERED",
      details: { previewChannels: ["weapp"] },
    });
    await evidence(s.sampleId, o);
    expect((await h.delivery.merchantSample(o.viewer, item.id)).confirmableVia).toEqual(["weapp"]);
    const key = uuidv7(),
      body = { versionNo: 1, viewedVia: "weapp", hasViewed: true },
      idem = () =>
        createIdempotencyContext({
          mode: "required",
          scope: "m.sample.confirm",
          actor: o.viewer.ctx.actor,
          key,
          request: { method: "POST", body },
          redact: [
            "playable",
            "decision.feedbackImages[].url",
            "decision.feedbackImages[].expiresAt",
          ],
        });
    expect(
      SampleWriteResultSchema.parse(
        await h.delivery.sampleConfirm(o.viewer, s.sampleId, body, { idem: idem() }),
      ).status,
    ).toBe("confirmed");
    expect(
      await h.delivery.sampleConfirm(o.viewer, s.sampleId, body, { idem: idem() }),
    ).toMatchObject({ replayed: true, playable: null });
    expect(h.rederivations.at(-1)?.steps).toEqual(["batch_compose"]);
    const second = await file(o, "final_episode", editor, 2),
      episodeBody = {
        items: [
          { episodeNo: 1, sampleId: s.sampleId },
          { episodeNo: 2, fileId: second.id },
        ],
      },
      made = await replay(
        "admin.deliveryTicket.episodeOutput.create",
        editor.ctx.actor,
        episodeBody,
        (o) => h.delivery.episodeRegister(editor.ctx, editor.staff, id, episodeBody, o),
      );
    expect(EpisodeRegisterResultSchema.parse(made).items.map((e) => e.source)).toEqual([
      "sample_adopted",
      "manual_upload",
    ]);
    expect(
      EpisodeGridSchema.parse(await h.delivery.episodes(qc.staff, id)).currentPassedCount,
    ).toBe(0);
    await h.finish(second.id);
    const q = await checks("qc.episode"),
      epBody = {
        episodeOutputIds: made.items.map((e) => e.episodeOutputId),
        checklistVersionNo: q.checklistVersionNo,
        defaultResults: q.results,
      },
      ep = await replay("admin.deliveryTicket.inspectEpisodes", qc.ctx.actor, epBody, (o) =>
        h.delivery.episodeInspect(qc.ctx, qc.staff, id, epBody, o),
      );
    expect(InspectEpisodesResultSchema.parse(ep).ticket.step).toBe("batch_compose");
    const packageQc = await checks("qc.package"),
      pkg = await replay("admin.deliveryTicket.inspectPackage", qc.ctx.actor, packageQc, (o) =>
        h.delivery.packageInspect(qc.ctx, qc.staff, id, packageQc, o),
      );
    expect(InspectPackageResultSchema.parse(pkg).ticket.step).toBe("delivering");
    expect(h.rederivations.at(-1)?.steps).toEqual(["delivering"]);
    const packageBody = { precheck: await checks("delivery.precheck") },
      out = await replay("admin.deliveryTicket.pushPackage", qc.ctx.actor, packageBody, (o) =>
        h.delivery.packagePush(qc.ctx, qc.staff, id, packageBody, o),
      );
    expect(PushPackageResultSchema.parse(out)).toMatchObject({
      release: { releaseNo: 1, totalBytes: "2468" },
      launchTaskCount: 1,
      ticket: { step: "awaiting_launch" },
    });
    const release = await h.prisma.deliveryRelease.findUniqueOrThrow({
      where: { id: out.release.deliveryReleaseId },
    });
    expect(release.manifestSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ episodeNo: 1, fileId: f.id, name: "测试短剧1_第01集.mp4" }),
      ]),
    );
    expect(
      await h.prisma.downloadGrant.count({
        where: { deliveryReleaseId: release.id, state: "active", actorType: "system" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.launchTask.count({ where: { deliveryTicketId: id, reviewStatus: "pending" } }),
    ).toBe(1);
    expect(await h.prisma.statusTransition.count({ where: { subjectId: s.sampleId } })).toBe(4);
    expect(h.rederivations.at(-1)?.steps).toEqual(["awaiting_launch"]);
    const cache = await h.prisma.idempotencyRecord.findFirstOrThrow({
      where: { scope: "m.sample.confirm", key },
    });
    expect(JSON.stringify(cache.result)).not.toContain("https://");
    expect(cache.result).toMatchObject({ playable: null });
    const detail = DeliveryTicketDetailSchema.parse(await h.delivery.get(qc.staff, id));
    expect(detail.currentSample?.sampleId).toBe(s.sampleId);
    expect(detail.currentSample?.preview?.url).toContain("https://");
    expect(detail.release?.deliveryReleaseId).toBe(release.id);
    expect(detail.publishList?.isComplete).toBe(true);
    const fullChecks = h.assembly.invariants.filter(
      (c) => c.code.startsWith("delivery.") && c.modes?.includes("full"),
    );
    expect(fullChecks).toHaveLength(13);
    for (const c of fullChecks)
      expect(await h.tx.run((tx) => c.run!(tx, {}, { now: h.clock.now() })), c.code).toEqual([]);
    expect(await h.tx.run(findI2Violations)).toEqual([]);
    expect(await h.tx.run((tx) => findI14Violations(tx))).toEqual([]);
    await expect(
      h.prisma.deliveryRelease.create({
        data: {
          ...release,
          manifestSnapshot: release.manifestSnapshot as Prisma.InputJsonValue,
          precheckResults: release.precheckResults as Prisma.InputJsonValue,
          id: uuidv7(),
          releaseNo: 100,
          idempotencyKey: uuidv7(),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    const episode = await h.prisma.episodeOutput.findFirstOrThrow({
        where: { deliveryTicketId: id, isCurrent: true },
      }),
      qcRecord = await h.prisma.qcRecord.findFirstOrThrow({
        where: { targetType: "sample", targetId: s.sampleId },
      });
    for (const code of ["I8", "I9", "I11", "I12", "I13", "I15"]) {
      await h.tx
        .run(async (tx) => {
          if (code === "I8")
            await tx.episodeOutput.update({
              where: { id: episode.id },
              data: { isCurrent: false },
            });
          if (code === "I9")
            await tx.qcRecord.create({
              data: {
                ...qcRecord,
                results: qcRecord.results as Prisma.InputJsonValue,
                id: uuidv7(),
                checklistVersionNo: 999,
              },
            });
          if (code === "I11")
            await tx.fileRef.updateMany({
              where: { refType: "delivery_release", refId: release.id },
              data: { state: "released", releasedAt: h.clock.now(), keepUntil: h.clock.now() },
            });
          if (code === "I12")
            await tx.productionRecord.update({
              where: { fileId: episode.fileId },
              data: { aigcState: "failed", pipelineState: "checking" },
            });
          if (code === "I13")
            await tx.deliveryRelease.create({
              data: {
                ...release,
                precheckResults: release.precheckResults as Prisma.InputJsonValue,
                id: uuidv7(),
                releaseNo: 99,
                state: "superseded",
                supersededAt: h.clock.now(),
                idempotencyKey: uuidv7(),
                manifestSnapshot: (
                  release.manifestSnapshot as Array<Record<string, Prisma.JsonValue>>
                ).map((m, i) =>
                  i === 0 ? { ...m, outputId: uuidv7() } : m,
                ) as Prisma.InputJsonValue,
                checklistVersionNo: 999,
              },
            });
          if (code === "I15")
            await tx.deliveryRelease.update({
              where: { id: release.id },
              data: { state: "superseded", supersededAt: h.clock.now() },
            });
          expect((await findDeliveryViolations(tx, code)).length, code).toBeGreaterThan(0);
          throw new Error("probe rollback");
        })
        .catch((e) => {
          expect(e.message).toBe("probe rollback");
        });
    }
    // 实际污染探针，各次事务回滚；不可变快照只能 INSERT 不合法历史，不能 UPDATE 冻结行。
    for (const code of ["I7", "I4"]) {
      await h.tx
        .run(async (tx) => {
          if (code === "I7")
            await tx.deliveryTicket.update({
              where: { id },
              data: { step: "sample_confirm", currentSampleVersionNo: 999 },
            });
          else
            await tx.sample.update({
              where: { id: s.sampleId },
              data: { storeId: (await h.make.store({ entityId: o.entity.id })).id },
            });
          expect(
            (await findDeliveryViolations(tx, code)).some(
              (v) =>
                v.subject &&
                "id" in v.subject &&
                v.subject.id === (code === "I7" ? id : s.sampleId),
            ),
          ).toBe(true);
          throw new Error("probe rollback");
        })
        .catch((e) => {
          expect(e.message).toBe("probe rollback");
        });
    }
  });
  it("缺真实 duration 时 QC 受控拒绝且历史/审核/事件/QC 均零新增；实际probe后可质检", async () => {
    const { o, editor, qc, id } = await ready(),
      f = await file(o, "sample_video", editor),
      s = await h.delivery.sampleCreate(editor.ctx, editor.staff, id, {
        fileId: f.id,
        adSlots: [],
      });
    const before = await h.tx.run((tx) => h.counts(tx, s.sampleId)),
      qcBefore = await h.prisma.qcRecord.count({ where: { targetId: s.sampleId } });
    await expect(
      h.delivery.sampleInspect(qc.ctx, qc.staff, s.sampleId, await checks("qc.sample")),
    ).rejects.toMatchObject({
      error: "PRODUCTION_NOT_READY",
      details: { fileId: f.id, gate: null },
    });
    expect(await h.tx.run((tx) => h.counts(tx, s.sampleId))).toEqual(before);
    expect(await h.prisma.qcRecord.count({ where: { targetId: s.sampleId } })).toBe(qcBefore);
    expect(await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } })).toMatchObject({
      status: "uploaded",
      durationMs: null,
    });
    await h.finish(f.id, true);
    expect(
      await h.delivery.sampleInspect(qc.ctx, qc.staff, s.sampleId, await checks("qc.sample")),
    ).toMatchObject({ status: "qc_passed", durationMs: 60000 });
  });
  it("同工单新样片取代旧版本、批次真实提交换引用；两连接包质检及推送只迁移/建包一次", async () => {
    const { o, editor, qc, id, item } = await ready(),
      f = await file(o, "sample_video", editor);
    await h.finish(f.id, true);
    const first = await h.delivery.sampleCreate(editor.ctx, editor.staff, id, {
        fileId: f.id,
        adSlots: [],
      }),
      sample = await h.delivery.sampleCreate(editor.ctx, editor.staff, id, {
        fileId: f.id,
        adSlots: [],
      });
    expect(sample.versionNo).toBe(2);
    expect(
      (await h.prisma.sample.findUniqueOrThrow({ where: { id: first.sampleId } })).status,
    ).toBe("superseded");
    expect(
      await h.prisma.fileRef.count({ where: { refType: "sample", fileId: f.id, state: "live" } }),
    ).toBe(2);
    const before = await h.tx.run((tx) => h.counts(tx, sample.sampleId)),
      c = await checks("qc.sample");
    await expect(
      h.delivery.sampleInspect(qc.ctx, qc.staff, sample.sampleId, {
        ...c,
        checklistVersionNo: c.checklistVersionNo + 1,
      }),
    ).rejects.toMatchObject({ error: "CHECKLIST_VERSION_STALE" });
    expect(await h.tx.run((tx) => h.counts(tx, sample.sampleId))).toEqual(before);
    await h.delivery.sampleInspect(qc.ctx, qc.staff, sample.sampleId, c);
    await h.delivery.samplePush(qc.ctx, qc.staff, sample.sampleId, {});
    await expect(
      h.delivery.sampleConfirm(o.viewer, sample.sampleId, {
        versionNo: 1,
        viewedVia: "weapp",
        hasViewed: true,
      }),
    ).rejects.toMatchObject({
      error: "SAMPLE_VERSION_STALE",
      details: { currentSampleId: sample.sampleId, currentVersionNo: 2 },
    });
    await h.delivery.sampleConfirm(o.viewer, sample.sampleId, {
      versionNo: 2,
      viewedVia: "weapp",
      hasViewed: true,
    });
    const now = h.clock.now(),
      batch = await h.prisma.uploadBatch.create({
        data: {
          id: uuidv7(),
          purpose: "final_release",
          targetId: item.id,
          scope: "full",
          variant: "common",
          expectedCount: 2,
          state: "ready",
          createdByStaffId: editor.row.id,
          idempotencyKey: uuidv7(),
          aiUsage: {
            used: false,
            tools: [],
            declaredBy: editor.row.id,
            declaredAt: now.toISOString(),
            forcedByDrama: false,
          },
          expiresAt: new Date(now.getTime() + 3600000),
          createdAt: now,
          updatedAt: now,
        },
      });
    for (const episodeNo of [1, 2]) {
      const f = await file(o, "final_episode", editor, episodeNo);
      await h.finish(f.id);
      await h.prisma.fileObject.update({ where: { id: f.id }, data: { uploadBatchId: batch.id } });
      await h.prisma.uploadBatchItem.create({
        data: {
          id: uuidv7(),
          uploadBatchId: batch.id,
          fileId: f.id,
          originalName: `episode${episodeNo}.mp4`,
          episodeNo,
          matchMethod: "manual",
          state: "checked",
          createdAt: now,
          updatedAt: now,
        },
      });
      await h.tx.run((tx) =>
        h.deps.media.link(tx, {
          fileId: f.id,
          refType: "upload_batch",
          refId: batch.id,
          role: "main",
          entityId: o.entity.id,
          storeId: o.store.id,
        }),
      );
    }
    const registered = await h.delivery.episodeRegister(editor.ctx, editor.staff, id, {
      uploadBatchId: batch.id,
    });
    expect(registered.items).toHaveLength(2);
    expect((await h.prisma.uploadBatch.findUniqueOrThrow({ where: { id: batch.id } })).state).toBe(
      "committed",
    );
    expect(
      await h.prisma.fileRef.count({
        where: { refType: "upload_batch", refId: batch.id, state: "live" },
      }),
    ).toBe(0);
    expect(
      await h.prisma.fileRef.count({
        where: {
          refType: "episode_output",
          refId: { in: registered.items.map((e) => e.episodeOutputId) },
          state: "live",
        },
      }),
    ).toBe(2);
    const q = await checks("qc.episode");
    await h.delivery.episodeInspect(qc.ctx, qc.staff, id, {
      episodeOutputIds: registered.items.map((e) => e.episodeOutputId),
      checklistVersionNo: q.checklistVersionNo,
      defaultResults: q.results,
    });
    const pkg = await checks("qc.package"),
      done = await Promise.allSettled([
        h.delivery.packageInspect(qc.ctx, qc.staff, id, pkg),
        h.delivery.packageInspect(qc.ctx, qc.staff, id, pkg),
      ]);
    expect(done.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const precheck = await checks("delivery.precheck"),
      pushed = await Promise.allSettled([
        h.delivery.packagePush(qc.ctx, qc.staff, id, { precheck }),
        h.delivery.packagePush(qc.ctx, qc.staff, id, { precheck }),
      ]);
    expect(pushed.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await h.prisma.deliveryRelease.count({ where: { deliveryTicketId: id } })).toBe(1);
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: id, toState: "awaiting_launch" },
      }),
    ).toBe(1);
  });
  it("Q9推送后关闭不改快照，GET零写；历史相册证据不恢复播放和确认", async () => {
    const { o, editor, qc, id, item } = await ready(),
      f = await file(o, "sample_video", editor);
    await h.finish(f.id, true);
    let enabled = true;
    const delivery = createDelivery({ ...h.deps, samplePlayback: async () => enabled }),
      s = await delivery.sampleCreate(editor.ctx, editor.staff, id, { fileId: f.id, adSlots: [] });
    await delivery.sampleInspect(qc.ctx, qc.staff, s.sampleId, await checks("qc.sample"));
    expect((await delivery.samplePush(qc.ctx, qc.staff, s.sampleId, {})).previewChannels).toEqual([
      "weapp",
    ]);
    const on = SampleViewSchema.parse(await delivery.merchantSample(o.viewer, item.id));
    expect(on.playable?.sources).toHaveLength(1);
    expect(on.confirmableVia).toEqual(["weapp"]);
    enabled = false;
    const before = await h.tx.run((tx) => h.counts(tx, s.sampleId)),
      off = SampleViewSchema.parse(await delivery.merchantSample(o.viewer, item.id));
    expect(off.previewChannels).toEqual(["weapp"]);
    expect(off.playable?.sources).toEqual([]);
    expect(off.confirmableVia).toEqual([]);
    expect(await h.tx.run((tx) => h.counts(tx, s.sampleId))).toEqual(before);
    await expect(
      delivery.sampleConfirm(o.viewer, s.sampleId, {
        versionNo: 1,
        viewedVia: "weapp",
        hasViewed: true,
      }),
    ).rejects.toMatchObject({
      error: "FEATURE_DISABLED",
    });
    await evidence(s.sampleId, o);
    await expect(
      delivery.sampleConfirm(o.viewer, s.sampleId, {
        versionNo: 1,
        viewedVia: "weapp",
        hasViewed: false,
      }),
    ).rejects.toMatchObject({ error: "FEATURE_DISABLED" });
    await expect(
      delivery.sampleConfirm(o.viewer, s.sampleId, {
        versionNo: 1,
        viewedVia: "weapp",
        hasViewed: true,
      }),
    ).rejects.toMatchObject({ error: "FEATURE_DISABLED" });
    enabled = true;
    await expect(
      delivery.sampleConfirm(o.viewer, s.sampleId, {
        versionNo: 1,
        viewedVia: "weapp",
        hasViewed: false,
      }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  });
  it("Q9关闭或缺失开关依赖拒绝新推送，企业微信请求不能产生另一种查看入口", async () => {
    const { o, editor, qc, id } = await ready(),
      f = await file(o, "sample_video", editor);
    await h.finish(f.id, true);
    const sample = await h.delivery.sampleCreate(editor.ctx, editor.staff, id, {
      fileId: f.id,
      adSlots: [],
    });
    await h.delivery.sampleInspect(qc.ctx, qc.staff, sample.sampleId, await checks("qc.sample"));
    const before = await h.tx.run((tx) => h.counts(tx, sample.sampleId));
    const enabledView = DeliveryTicketDetailSchema.parse(await h.delivery.get(qc.staff, id));
    expect(enabledView.currentSample?.actions).toContain("push");
    for (const samplePlayback of [undefined, async () => false]) {
      const disabled = createDelivery({ ...h.deps, samplePlayback });
      const disabledView = DeliveryTicketDetailSchema.parse(await disabled.get(qc.staff, id));
      expect(disabledView.currentSample?.actions).not.toContain("push");
      await expect(
        disabled.samplePush(qc.ctx, qc.staff, sample.sampleId, {}),
      ).rejects.toMatchObject({ error: "FEATURE_DISABLED" });
    }
    for (const body of [{ includeWecom: true }, { markWecomSent: true }])
      await expect(
        h.delivery.samplePush(qc.ctx, qc.staff, sample.sampleId, body),
      ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    expect(await h.tx.run((tx) => h.counts(tx, sample.sampleId))).toEqual(before);
    expect(await h.delivery.samplePush(qc.ctx, qc.staff, sample.sampleId, {})).toMatchObject({
      previewChannels: ["weapp"],
      offlineSentAt: null,
    });
    expect(o.items[0]).toBeDefined();
  });
  it("Q9历史album-only待确认和已确认快照保持事实，不签播放地址或借旧证据确认", async () => {
    const { o, editor, qc, id, item } = await ready(),
      f = await file(o, "sample_video", editor);
    await h.finish(f.id, true);
    const sample = await h.delivery.sampleCreate(editor.ctx, editor.staff, id, {
      fileId: f.id,
      adSlots: [],
    });
    await h.delivery.sampleInspect(qc.ctx, qc.staff, sample.sampleId, await checks("qc.sample"));
    await h.delivery.samplePush(qc.ctx, qc.staff, sample.sampleId, {});
    // Historical pre-Q9 facts are seeded explicitly; new writes never produce these channels.
    await h.prisma.sample.update({
      where: { id: sample.sampleId },
      data: { previewChannels: ["album", "portal"] },
    });
    await evidence(sample.sampleId, o);
    const before = await h.tx.run((tx) => h.counts(tx, sample.sampleId));
    const pending = await h.delivery.merchantSample(o.viewer, item.id);
    expect(pending).toMatchObject({
      previewChannels: ["album", "portal"],
      confirmableVia: [],
      actions: [],
    });
    expect(pending.playable?.sources).toEqual([]);
    expect(pending.viewEvidence.albumSavedAt).not.toBeNull();
    for (const viewedVia of ["album", "portal", "weapp", "wecom"])
      await expect(
        h.delivery.sampleConfirm(o.viewer, sample.sampleId, {
          versionNo: 1,
          viewedVia,
          hasViewed: true,
        }),
      ).rejects.toMatchObject({ error: "SAMPLE_VIEW_CHANNEL_NOT_OFFERED" });
    expect(await h.tx.run((tx) => h.counts(tx, sample.sampleId))).toEqual(before);
    await h.prisma.sample.update({
      where: { id: sample.sampleId },
      data: {
        status: "confirmed",
        decidedAt: h.clock.now(),
        decidedByUserId: o.user.id,
        decideClient: "weapp",
        confirmViewedVia: "album",
        viewedAckAt: h.clock.now(),
        viewedAckByUserId: o.user.id,
      },
    });
    const historical = await h.delivery.merchantSample(o.viewer, item.id);
    expect(historical).toMatchObject({
      previewChannels: ["album", "portal"],
      decision: { viewedVia: "album" },
    });
    expect(historical.playable?.sources).toEqual([]);
  });
  it("真实剧目 AI × 声明正反强制 used/forcedByDrama，分类重放及样片/成片 fallback 不越过 pending", async () => {
    const { o, editor, qc, id, item } = await ready();
    let nonAiSampleFile: string | undefined;
    for (const kind of ["sample", "final"] as const) {
      if (kind === "final") {
        // 用合法非 AI 样片走真实确认迁移，避免伪写工单步骤来开放成片分类。
        await h.prisma.drama.update({
          where: { id: item.dramaId },
          data: { isAiGenerated: false },
        });
        await h.finish(nonAiSampleFile!, true);
        const healthy = await h.delivery.sampleCreate(editor.ctx, editor.staff, id, {
          fileId: nonAiSampleFile!,
          adSlots: [],
        });
        await h.delivery.sampleInspect(
          qc.ctx,
          qc.staff,
          healthy.sampleId,
          await checks("qc.sample"),
        );
        await h.delivery.samplePush(qc.ctx, qc.staff, healthy.sampleId, {});
        await h.delivery.sampleConfirm(o.viewer, healthy.sampleId, {
          versionNo: healthy.versionNo,
          viewedVia: "weapp",
          hasViewed: true,
        });
      }
      const category = kind === "sample" ? "sample_video" : "final_episode",
        episodeNo = kind === "sample" ? 1 : 2;
      for (const isAiGenerated of [false, true])
        for (const used of [false, true]) {
          await h.prisma.drama.update({ where: { id: item.dramaId }, data: { isAiGenerated } });
          const f = await file(o, category, editor, episodeNo, used, async (fileId, token) => {
            const declared = await h.prisma.productionRecord.findUniqueOrThrow({
              where: { fileId },
            });
            expect(declared).toMatchObject({
              aigcState: used || isAiGenerated ? "pending" : "not_required",
              pipelineState: "uploading",
              aiUsage: {
                used: used || isAiGenerated,
                forcedByDrama: isAiGenerated,
                tools: [],
                declaredBy: editor.row.id,
              },
            });
            const countsBefore = [
              await h.prisma.fileObject.count(),
              await h.prisma.productionRecord.count(),
            ];
            // 登记的自然重放只复用 pending 文件；在 complete/promote 前核真实语义。
            const replayed = await h.media.register(
              { identity: editor.ctx, staff: editor.staff },
              {
                category,
                storeId: o.store.id,
                production: { kind, orderItemId: item.id, episodeNo, aiUsage: { used, tools: [] } },
                files: [
                  { fileName: `test-${episodeNo}.mp4`, sizeBytes: "1234", clientToken: token },
                ],
              },
            );
            expect(replayed.items[0]!.fileId).toBe(fileId);
            expect(
              await h.prisma.productionRecord.findUniqueOrThrow({ where: { fileId } }),
            ).toEqual(declared);
            expect([
              await h.prisma.fileObject.count(),
              await h.prisma.productionRecord.count(),
            ]).toEqual(countsBefore);
          });
          const [bridged] = await h.tx.run((tx) =>
            h.deps.media.prepareDeliveryProduction(tx, [
              {
                fileId: f.id,
                kind,
                orderItemId: item.id,
                episodeNo,
                entityId: o.entity.id,
                storeId: o.store.id,
                productionTier: item.productionModel,
                uploadedByStaffId: editor.row.id,
                forcedByDrama: isAiGenerated,
              },
            ]),
          );
          expect(bridged!.record).toMatchObject({
            pipelineState: "uploading",
            aigcState: used || isAiGenerated ? "pending" : "not_required",
            aiUsage: { used: used || isAiGenerated, forcedByDrama: isAiGenerated },
          });
          expect(await h.prisma.playableAsset.count({ where: { sourceFileId: f.id } })).toBe(0);
          if (kind === "sample" && !used && !isAiGenerated) nonAiSampleFile = f.id;
        }
      // 兼容既存 stored 文件缺制作留痕的分支，也必须读取真实所属 AI 剧目。
      const legacy = await h.make.fileObject({
        category,
        scopeType: "store",
        entityId: o.entity.id,
        storeId: o.store.id,
      });
      if (kind === "sample") {
        const s = await h.delivery.sampleCreate(editor.ctx, editor.staff, id, {
          fileId: legacy.id,
          adSlots: [],
        });
        const before = await h.tx.run((tx) => h.counts(tx, s.sampleId)),
          qcBefore = await h.prisma.qcRecord.count();
        await expect(
          h.delivery.sampleInspect(qc.ctx, qc.staff, s.sampleId, await checks("qc.sample")),
        ).rejects.toMatchObject({ error: "PRODUCTION_NOT_READY" });
        expect(await h.tx.run((tx) => h.counts(tx, s.sampleId))).toEqual(before);
        expect(await h.prisma.qcRecord.count()).toBe(qcBefore);
      } else
        await h.delivery.episodeRegister(editor.ctx, editor.staff, id, {
          items: [{ episodeNo, fileId: legacy.id }],
        });
      expect(
        await h.prisma.productionRecord.findUniqueOrThrow({ where: { fileId: legacy.id } }),
      ).toMatchObject({
        pipelineState: "uploading",
        aigcState: "pending",
        aiUsage: { used: true, forcedByDrama: true },
      });
      expect(await h.prisma.playableAsset.count({ where: { sourceFileId: legacy.id } })).toBe(0);
    }
  });
  it("完整清单 fail 写一次 qc_failed，补传新版本；旧 metadata 与引用不删，AI 预判按真实 not_required", async () => {
    const { o, editor, qc, id } = await ready(),
      f = await file(o, "sample_video", editor);
    await h.finish(f.id, true);
    const s = await h.delivery.sampleCreate(editor.ctx, editor.staff, id, {
        fileId: f.id,
        adSlots: [],
      }),
      c = await checks("qc.sample");
    const failure = {
      ...c,
      results: c.results.map((r, i) =>
        i === 0 ? { ...r, result: "fail" as const, note: "虚构音画不同步" } : r,
      ),
      rejectReason: "虚构音画不同步",
    };
    const rejected = await h.delivery.sampleInspect(qc.ctx, qc.staff, s.sampleId, failure);
    expect(rejected.status).toBe("qc_rejected");
    expect(rejected.qc?.items.find((i) => i.key === "ai_label")?.result).toBe("na");
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: s.sampleId, event: "sample.qc_failed" },
      }),
    ).toBe(1);
    const next = await h.delivery.sampleCreate(editor.ctx, editor.staff, id, {
      fileId: f.id,
      adSlots: [],
    });
    expect(next.versionNo).toBe(2);
    expect((await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } })).status).toBe(
      "qc_rejected",
    );
    expect(await h.prisma.fileRef.count({ where: { refType: "sample", fileId: f.id } })).toBe(2);
  });
});
