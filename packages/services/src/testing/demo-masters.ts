import { commitUploadMasters } from "../content/index.js";
import type { ContentDemoDeps } from "../content/index.js";
import { lockRows, uuidv7 } from "../kernel/index.js";
import type { Clock, TxRunner } from "../kernel/index.js";
import type { Events } from "../events/index.js";
import type { Media } from "../media/index.js";
import { createFactories } from "./data/factories/index.js";

/** Database codec fixture only: no bytes, probe, real storage or cloud success is asserted. */
export function createCodecDemoMasterPreparer(deps: {
  appEnv: "test";
  tx: TxRunner;
  clock: Clock;
  media: Pick<Media, "link" | "release">;
  events: Pick<Events, "emit">;
}): NonNullable<ContentDemoDeps["prepareMasters"]> {
  if (deps.appEnv !== "test") throw new Error("codec masters require an isolated test runtime");
  return (input) =>
    deps.tx.run(async (tx) => {
      await lockRows(tx, "drama", [input.dramaId]);
      const drama = await tx.drama.findUniqueOrThrow({ where: { id: input.dramaId } });
      if (drama.archivedAt || drama.totalEpisodes !== input.totalEpisodes)
        throw new Error("codec master target changed");
      const now = deps.clock.now(),
        make = createFactories({ db: tx, clock: deps.clock });
      const batch = await tx.uploadBatch.create({
        data: {
          id: uuidv7(),
          purpose: "drama_master",
          targetId: drama.id,
          createdByStaffId: input.staffId,
          state: "ready",
          expectedCount: input.totalEpisodes,
          scope: "full",
          replaceReason: null,
          isContentChanged: false,
          idempotencyKey: uuidv7(),
          expiresAt: new Date(now.getTime() + 86400000),
          createdAt: now,
          updatedAt: now,
        },
      });
      await lockRows(tx, "upload_batch", [batch.id]);
      const items = [];
      for (let episodeNo = 1; episodeNo <= input.totalEpisodes; episodeNo++) {
        const file = await make.fileObject({
          category: "drama_master",
          bucket: "media",
          ext: "mp4",
          mime: "video/mp4",
          declaredMime: "video/mp4",
          moderationState: "none",
          uploadBatchId: batch.id,
          uploadActorType: "staff",
          uploadActorId: input.staffId,
          uploadClient: "admin",
        });
        await tx.mediaCheck.create({
          data: {
            fileId: file.id,
            profile: "master",
            ruleVersion: 1,
            gate: "pass",
            hard: [],
            soft: [],
            checkedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        });
        items.push({ episodeNo, fileId: file.id, durationMs: 20000 });
      }
      const old = await tx.dramaEpisodeMaster.findMany({
        where: { dramaId: drama.id, isCurrent: true },
        select: { fileId: true },
      });
      await lockRows(tx, "file_object", [
        ...old.map((v) => v.fileId),
        ...items.map((v) => v.fileId),
      ]);
      await commitUploadMasters(tx, deps, {
        batch,
        staffId: input.staffId,
        identity: input.identity,
        items,
      });
      await tx.uploadBatch.update({
        where: { id: batch.id },
        data: { state: "committed", committedAt: now, updatedAt: now },
      });
    });
}
