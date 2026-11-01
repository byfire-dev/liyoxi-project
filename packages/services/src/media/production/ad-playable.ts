import { AppError, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type { BoundMediaDeps } from "../context.js";
import type { Technical } from "../production-report.js";
import type { readProductionWork } from "../production.js";
import { link, release } from "../refs.js";
/** Called only by the real probe settlement after ordinary ad and AIGC checks pass. Ads use checked source bytes. */
export async function installAdSourcePlayable(
  deps: BoundMediaDeps,
  tx: Tx,
  ctx: IdentityContext,
  facts: Awaited<ReturnType<typeof readProductionWork>>,
  technical: Technical,
  coverFileId: string | null,
  now: Date,
) {
  const record = facts.production,
    file = facts.file;
  if (
    record?.kind !== "ad" ||
    !record.adId ||
    !technical.durationMs ||
    !technical.displayWidth ||
    !technical.displayHeight
  )
    throw new AppError("PRODUCTION_NOT_READY");
  const key = { kind: "ad", sourceFileId: file.id, specVersion: facts.parameters.specVersion };
  const existing = await tx.playableAsset.findUnique({
    where: { kind_sourceFileId_specVersion: key },
  });
  if (
    existing &&
    (existing.ownerType !== "ad" ||
      existing.ownerId !== record.adId ||
      existing.entityId !== file.entityId ||
      existing.storeId !== file.storeId)
  )
    throw new AppError("PRECONDITION_CHANGED");
  if (existing?.state === "retired") return;
  const id = existing?.id ?? uuidv7(),
    renditions = [
      {
        quality: "source",
        fileId: file.id,
        width: technical.displayWidth,
        height: technical.displayHeight,
        bitrateKbps: technical.bitrateKbps,
      },
    ];
  const data = {
    state: "ready",
    durationMs: technical.durationMs,
    width: technical.displayWidth,
    height: technical.displayHeight,
    renditions,
    coverFileId,
    readyAt: now,
    error: null,
    updatedAt: now,
  };
  if (existing) await tx.playableAsset.update({ where: { id }, data });
  else
    await tx.playableAsset.create({
      data: {
        id,
        ...key,
        ownerType: "ad",
        ownerId: record.adId,
        entityId: file.entityId,
        storeId: file.storeId,
        ...data,
        createdAt: now,
      },
    });
  if (existing?.coverFileId && existing.coverFileId !== coverFileId)
    await release(deps, tx, {
      fileId: existing.coverFileId,
      entityId: file.entityId,
      storeId: file.storeId,
      refType: "playable_asset",
      refId: id,
      role: "cover",
      keepUntil: new Date(now.getTime() + 30 * 86_400_000),
    });
  for (const role of ["source", "rendition"])
    await link(deps, tx, {
      fileId: file.id,
      entityId: file.entityId,
      storeId: file.storeId,
      refType: "playable_asset",
      refId: id,
      role,
    });
  if (coverFileId)
    await link(deps, tx, {
      fileId: coverFileId,
      entityId: file.entityId,
      storeId: file.storeId,
      refType: "playable_asset",
      refId: id,
      role: "cover",
    });
  await deps.events.emit(tx, ctx, {
    type: "media.playable.ready",
    aggregate: { type: "playable_asset", id },
    entityId: file.entityId,
    storeId: file.storeId,
    dedupeKey: id,
    payload: { v: 1, playableAssetId: id, ownerType: "ad", ownerId: record.adId, kind: "ad" },
  });
}
