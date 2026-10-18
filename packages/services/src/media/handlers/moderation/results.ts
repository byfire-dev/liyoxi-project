import type { IdentityContext, Tx } from "../../../kernel/index.js";
import type { BoundMediaDeps } from "../../context.js";
import type { ContentVerdict } from "../../../providers/types.js";
import { categoryOf } from "../../access.js";
/** Called with the current job and file locks held, inside result settlement. */
export async function recordModeration(
  tx: Tx,
  deps: BoundMediaDeps,
  ctx: IdentityContext,
  input: {
    fileId: string;
    verdict: Exclude<ContentVerdict, "pending">;
    channel: "ci" | "wechat";
    labels?: readonly string[];
    traceId?: string;
  },
): Promise<boolean> {
  const file = await tx.fileObject.findUniqueOrThrow({ where: { id: input.fileId } });
  if (file.status !== "stored" || file.moderationState !== "pending") return false;
  const now = deps.clock.now();
  const labels = (input.labels ?? [])
    .filter((value) => /^[A-Za-z0-9_-]{1,64}$/.test(value))
    .slice(0, 16);
  const changed = await tx.fileObject.updateMany({
    where: { id: file.id, status: "stored", moderationState: "pending" },
    data: {
      moderationState: input.verdict,
      moderationDetail: {
        channel: input.channel,
        verdict: input.verdict,
        labels,
        ...(input.traceId ? { traceId: input.traceId } : {}),
        decidedAt: now.toISOString(),
      },
      updatedAt: now,
    },
  });
  if (changed.count !== 1) return false;
  await deps.events.emit(tx, ctx, {
    type: "file.moderated",
    aggregate: { type: "file_object", id: file.id },
    entityId: file.entityId,
    storeId: file.storeId,
    dedupeKey: `file.moderated:${file.id}`,
    payload: {
      v: 1,
      fileId: file.id,
      category: categoryOf(file),
      moderationState: input.verdict,
      storeId: file.storeId,
    },
  });
  return true;
}
