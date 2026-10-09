import { assertAccess } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Clock } from "../kernel/index.js";
import { readUploadDramaFacts, commitUploadMasters } from "../content/index.js";
import { authorizeBatchUpload, readBatchUploadFacts } from "../delivery/index.js";
import type { BatchTargetFacts, MediaBatchDeps, Media } from "../media/index.js";
import type { Events } from "../events/index.js";

export function createRuntimeMediaBatches(options: {
  clock: Clock;
  events: Pick<Events, "emit">;
  media: () => Pick<Media, "link" | "release">;
}): MediaBatchDeps {
  const readTarget: MediaBatchDeps["readTarget"] = async (tx, input): Promise<BatchTargetFacts> => {
    if (input.purpose === "drama_master") {
      const drama = await readUploadDramaFacts(tx, input.targetId);
      return {
        expectedCount: drama.totalEpisodes ?? 0,
        targetLabel: drama.title,
        forcedByDrama: drama.isAiGenerated,
        entityId: null,
        storeId: null,
        episodes: drama.episodes,
        masters: drama.masters,
        productionContext: null,
      };
    }
    const facts = await readBatchUploadFacts(tx, input.targetId);
    const drama = await readUploadDramaFacts(tx, facts.dramaId);
    return { ...facts, episodes: [], masters: drama.masters };
  };
  return {
    readTarget,
    authorizeTarget: async (tx, staff, input) => {
      if (input.purpose === "drama_master") {
        assertAccess(staff, {
          module: { module: "drama", need: "view" },
          permission: "drama.media.manage",
        });
        if (input.lock) await lockRows(tx, "drama", [input.targetId]);
        const facts = await readUploadDramaFacts(tx, input.targetId);
        if (!input.readOnly && facts.archivedAt) throw new AppError("DRAMA_ARCHIVED");
        return readTarget(tx, input);
      }
      await authorizeBatchUpload(tx, staff, input.targetId, {
        lock: input.lock,
        readOnly: input.readOnly,
      });
      return readTarget(tx, input);
    },
    currentMaster: async (tx, batch, no) => {
      const facts = await readTarget(tx, batch);
      return facts.masters.find((m) => m.episodeNo === no)?.id ?? null;
    },
    commitMasters: (tx, input) =>
      commitUploadMasters(
        tx,
        { ...options, media: options.media() },
        { ...input, staffId: input.staff.staff.id },
      ),
  };
}
