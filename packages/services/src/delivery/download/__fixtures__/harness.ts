import { ChecklistItemsSchema } from "@liyoxi/contract";
import { uuidv7 } from "../../../kernel/index.js";
import { createDelivery } from "../../service.js";
import { draft } from "../../__fixtures__/harness.js";
import type { ProductionHarness as Harness } from "../../__fixtures__/production-tools.js";
import { createDeliveryDownloads } from "../index.js";
export const meta = {
  requestId: uuidv7(),
  ip: "198.19.116.1",
  userAgent: "LYX fictional download",
  sessionId: null,
  authMethod: "weapp" as const,
};
export async function checks(h: Harness, code: string) {
  const row = await h.prisma.checklistTemplate.findFirstOrThrow({
    where: { code, status: "active" },
  });
  return {
    checklistVersionNo: row.versionNo,
    results: ChecklistItemsSchema.parse(row.items).map((i) => ({
      key: i.key,
      result: "pass" as const,
    })),
  };
}
async function knownFile(
  h: Harness,
  o: Awaited<ReturnType<Harness["order"]>>,
  editor: Awaited<ReturnType<Harness["staff"]>>,
  category: "sample_video" | "final_episode",
  episodeNo: number,
) {
  await h.master(o.items[0]!.dramaId, episodeNo, editor.row.id);
  const bytes = new Uint8Array(1234),
    actor = { identity: editor.ctx, staff: editor.staff };
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const registered = await h.media.register(actor, {
    category,
    storeId: o.store.id,
    production: {
      kind: category === "sample_video" ? "sample" : "final",
      orderItemId: o.items[0]!.id,
      episodeNo,
      aiUsage: { used: false, tools: [] },
    },
    files: [
      {
        fileName: `fiction-${episodeNo}.mp4`,
        sizeBytes: String(bytes.length),
        clientToken: uuidv7(),
      },
    ],
  });
  const entry = registered.items[0]!;
  h.fake.storage.put({ bucket: "media", key: entry.key }, bytes, "video/mp4");
  await h.media.completeAdmin(actor, entry.fileId);
  const job = await h.prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${entry.fileId}` },
  });
  await h.media.promote({ jobId: job.id });
  await h.finish(entry.fileId, category === "sample_video");
  return h.prisma.fileObject.findUniqueOrThrow({ where: { id: entry.fileId } });
}
export async function sampleReady(h: Harness, samplePlayback = async () => true) {
  const poster = await h.make.fileObject(),
    o = await h.order(true, 1, poster.id, 2),
    editor = await h.staff(),
    qc = await h.staff(),
    item = o.items[0]!,
    id = o.deliveryTicketIds[0]!;
  const a = createDelivery({ ...h.deps, samplePlayback }),
    downloads = createDeliveryDownloads({ ...h.deps, samplePlayback });
  const versions = await h.prisma.agreementVersion.findMany(),
    refs = versions
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
    where: { id: item.dramaId },
    data: { synopsis: "虚构逐集下载验收剧简介" },
  });
  await a.replaceDraft(editor.ctx, editor.staff, o.deliveryPlanId, {
    draftLockVersion: 0,
    content: draft(o),
  });
  await a.push(editor.ctx, editor.staff, o.deliveryPlanId, { draftLockVersion: 1 });
  await a.confirm(o.viewer, o.deliveryPlanId, { versionNo: 1 });
  const file = await knownFile(h, o, editor, "sample_video", 1),
    made = await a.sampleCreate(editor.ctx, editor.staff, id, { fileId: file.id, adSlots: [] });
  await a.sampleInspect(qc.ctx, qc.staff, made.sampleId, await checks(h, "qc.sample"));
  const sample = await a.samplePush(qc.ctx, qc.staff, made.sampleId, {});
  return { a, downloads, o, editor, qc, item, id, file, sample };
}
export async function packageReady(h: Harness) {
  const ready = await sampleReady(h),
    { a, o, sample, item, id, editor, qc } = ready;
  await a.sampleConfirm(o.viewer, sample.sampleId, {
    versionNo: 1,
    viewedVia: "weapp",
    hasViewed: true,
  });
  const file = await knownFile(h, o, editor, "final_episode", 2),
    outputs = await a.episodeRegister(editor.ctx, editor.staff, id, {
      items: [
        { episodeNo: 1, sampleId: sample.sampleId },
        { episodeNo: 2, fileId: file.id },
      ],
    });
  const q = await checks(h, "qc.episode");
  await a.episodeInspect(qc.ctx, qc.staff, id, {
    episodeOutputIds: outputs.items.map((e) => e.episodeOutputId),
    checklistVersionNo: q.checklistVersionNo,
    defaultResults: q.results,
  });
  await a.packageInspect(qc.ctx, qc.staff, id, await checks(h, "qc.package"));
  const pushed = await a.packagePush(qc.ctx, qc.staff, id, {
    precheck: await checks(h, "delivery.precheck"),
  });
  const release = await h.prisma.deliveryRelease.findUniqueOrThrow({
      where: { id: pushed.release.deliveryReleaseId },
    }),
    grant = await h.prisma.downloadGrant.findFirstOrThrow({
      where: { deliveryReleaseId: release.id, state: "active" },
    });
  // 上游工单链用harness既有orderSide测试替身；本包只取已交付的真实包，不实现订单推导。
  await h.prisma.orderItem.update({ where: { id: item.id }, data: { phase: "to_launch" } });
  return { ...ready, release, grant, episodeFile: file };
}
export const snapshot = (h: Harness) =>
  Promise.all([
    h.prisma.auditLog.count(),
    h.prisma.statusTransition.count(),
    h.prisma.outboxEvent.count(),
    h.prisma.deliveryDownloadLog.count(),
    h.prisma.sample.findMany({ orderBy: { id: "asc" } }),
  ]);
