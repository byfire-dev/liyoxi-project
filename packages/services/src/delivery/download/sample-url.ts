import { record } from "../../audit/index.js";
import type { AuditRequestMeta } from "../../audit/index.js";
import { AppError, isUuid, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { DeliveryViewer } from "../context.js";
import { sampleOf } from "../samples.js";
import type { DeliveryDownloadDeps } from "./context.js";
import { productionEvidence } from "../production-guard.js";
import { lockParents, viewerOf } from "./repo.js";
async function facts(tx: Tx, deps: DeliveryDownloadDeps, v: DeliveryViewer, id: string) {
  await viewerOf(tx, v, true);
  const { s, t } = await sampleOf(tx, id, v);
  if (
    !["pushed", "confirmed", "change_requested"].includes(s.status) ||
    s.versionNo !== t.currentSampleVersionNo
  )
    throw new AppError("STATE_NOT_ALLOWED");
  if (!s.previewChannels.includes("album") && (await deps.samplePlayback?.(s.entityId)))
    throw new AppError("SAMPLE_VIEW_CHANNEL_NOT_OFFERED", {
      details: { previewChannels: s.previewChannels },
    });
  const production = await deps.media.deliveryProductionFacts(tx, s.fileId);
  const playable = production.playable;
  const fileId = (playable?.renditions as Array<{ fileId?: string }> | undefined)?.[0]?.fileId;
  if (playable?.state !== "ready" || !fileId || !isUuid(fileId))
    throw new AppError("SAMPLE_PREVIEW_NOT_READY");
  const file = await tx.fileObject.findFirst({
    where: {
      id: fileId,
      entityId: s.entityId,
      storeId: s.storeId,
      status: "stored",
      moderationState: { not: "block" },
    },
  });
  if (!file) throw new AppError("SAMPLE_PREVIEW_NOT_READY");
  const title = (t.orderItem.dramaSnapshot as { title: string }).title;
  return { s, t, playable, file, fileName: `${title}_样片_第${s.versionNo}版.mp4` };
}
export async function sampleUrl(
  deps: DeliveryDownloadDeps,
  v: DeliveryViewer,
  id: string,
  meta: AuditRequestMeta,
) {
  const first = await deps.tx.run((tx) => facts(tx, deps, v, id));
  const signed = await deps.media.signDeliveryDownload({
    fileId: first.file.id,
    fileName: first.fileName,
  });
  return deps.tx.run(async (tx) => {
    await lockParents(tx, v, first.t.id);
    await lockRows(tx, "sample", [id]);
    await productionEvidence(tx, deps.media, first.s.fileId, true);
    const current = await facts(tx, deps, v, id);
    if (
      current.playable.id !== first.playable.id ||
      current.file.id !== first.file.id ||
      current.file.objectKey !== first.file.objectKey ||
      current.file.bucket !== first.file.bucket ||
      current.file.sizeBytes !== first.file.sizeBytes ||
      current.fileName !== first.fileName ||
      JSON.stringify(current.playable.renditions) !== JSON.stringify(first.playable.renditions) ||
      new Date(signed.expiresAt) <= deps.clock.now()
    )
      throw new AppError("SAMPLE_PREVIEW_NOT_READY");
    await record(tx, v.ctx.actor, meta, {
      stream: "access",
      category: "file_access",
      action: "delivery.sample.album_download",
      summary: "保存样片到相册",
      target: { type: "sample", id },
      entityId: current.s.entityId,
      storeId: current.s.storeId,
      meta: { fileCategory: "sample_wm", urlTtlSec: 900 },
    });
    if (!current.s.firstViewedAt)
      await tx.sample.update({
        where: { id },
        data: { firstViewedAt: deps.clock.now(), updatedAt: deps.clock.now() },
      });
    return { ...signed, fileName: current.fileName, sizeBytes: current.file.sizeBytes!.toString() };
  });
}
