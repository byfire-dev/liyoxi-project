import { z } from "zod";
import type { MediaJob } from "@liyoxi/db";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { BoundMediaDeps } from "../context.js";
import type { JobOutcome } from "../jobs/types.js";
import { createDerivedFile, json } from "../production.js";
import {
  LocalSamplePlayableInputSchema,
  PlayableInputSchema,
  PlayableOutputSchema,
  RenditionSchema,
} from "../playable-schemas.js";
import { link, release } from "../refs.js";
import { saveTechnical } from "./probe.js";

/** Both real renderers install the same files, references and rendition facts before convergence. */
export async function finishPlayable(
  deps: BoundMediaDeps,
  tx: Tx,
  job: MediaJob,
  outcome: JobOutcome,
) {
  if (outcome.state !== "succeeded") return;
  const input = PlayableInputSchema.parse(job.input),
    output = PlayableOutputSchema.parse(outcome.output),
    local = LocalSamplePlayableInputSchema.safeParse(job.input).success;
  if (
    !deps.production ||
    (local
      ? deps.production.mode !== "local_sample_watermark"
      : deps.production.mode !== undefined && deps.production.mode !== "full")
  )
    throw new AppError("PROVIDER_UNAVAILABLE");
  if (output.fileId !== input.destinationFileId || output.quality !== input.quality)
    throw new AppError("STATE_NOT_ALLOWED");
  const source = await tx.fileObject.findUniqueOrThrow({ where: { id: job.subjectId } }),
    now = deps.clock.now();
  const file = await createDerivedFile(
    tx,
    {
      ...source,
      bucket: job.kind === "transcode_mp4" ? "pub" : "media",
      category: job.kind === "transcode_mp4" ? "trailer_out" : "sample_wm",
    },
    { id: output.fileId, objectKey: input.objectKey, ...output },
    now,
  );
  await saveTechnical(tx, file.id, output.technical, null, now);
  const playable = await tx.playableAsset.findUniqueOrThrow({
    where: { id: input.playableAssetId },
  });
  const previous =
    job.kind === "watermark_sample"
      ? []
      : z
          .array(RenditionSchema)
          .max(2)
          .parse(playable.renditions ?? []);
  const rendition = {
    quality: output.quality,
    fileId: output.fileId,
    width: output.technical.displayWidth!,
    height: output.technical.displayHeight!,
    bitrateKbps: output.technical.bitrateKbps,
  };
  await tx.playableAsset.update({
    where: { id: playable.id },
    data: {
      renditions: json([...previous.filter((row) => row.quality !== rendition.quality), rendition]),
      durationMs: output.technical.durationMs,
      width: output.technical.displayWidth,
      height: output.technical.displayHeight,
      ...(job.kind === "watermark_sample"
        ? {
            watermark: json({
              ...("recipe" in input ? { recipe: input.recipe } : { template: input.template }),
              text: input.watermarks.find((mark) => "text" in mark)?.text ?? "",
            }),
          }
        : {}),
      updatedAt: now,
    },
  });
  await link(deps, tx, {
    fileId: source.id,
    entityId: playable.entityId,
    storeId: playable.storeId,
    refType: "playable_asset",
    refId: playable.id,
    role: "source",
  });
  if (job.kind === "watermark_sample") {
    const old = await tx.fileRef.findMany({
      where: {
        refType: "playable_asset",
        refId: playable.id,
        role: "rendition",
        state: "live",
        fileId: { not: file.id },
      },
    });
    for (const ref of old)
      await release(deps, tx, {
        fileId: ref.fileId,
        entityId: playable.entityId,
        storeId: playable.storeId,
        refType: "playable_asset",
        refId: playable.id,
        role: "rendition",
        keepUntil: new Date(now.getTime() + 30 * 86_400_000),
      });
  }
  await link(deps, tx, {
    fileId: file.id,
    entityId: playable.entityId,
    storeId: playable.storeId,
    refType: "playable_asset",
    refId: playable.id,
    role: "rendition",
  });
  if (playable.coverFileId)
    await link(deps, tx, {
      fileId: playable.coverFileId,
      entityId: playable.entityId,
      storeId: playable.storeId,
      refType: "playable_asset",
      refId: playable.id,
      role: "cover",
    });
}
