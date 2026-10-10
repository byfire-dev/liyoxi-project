import { savepoint, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";

/** The asset use case owns this direct event; failures roll back only its savepoint. */
export async function recordAssetUpload(
  tx: Tx,
  input: {
    assetId: string;
    actor: IdentityContext["actor"];
    entityId: string;
    storeId: string;
    type: string;
    fileCount: number;
    hasDemand: boolean;
    now: Date;
  },
): Promise<void> {
  try {
    await savepoint(tx, async () => {
      const eventId = `srv-${input.assetId}-asset_upload`;
      const fresh = await tx.$queryRaw<{ eventId: string }[]>`
        INSERT INTO analytics_event_dedup (event_id, received_at)
        VALUES (${eventId}, ${input.now}::timestamptz)
        ON CONFLICT DO NOTHING RETURNING event_id AS "eventId"
      `;
      if (!fresh.length) return;
      await tx.analyticsEvent.create({
        data: {
          id: uuidv7(),
          eventId,
          name: "asset_upload",
          source: "direct",
          occurredAt: input.now,
          receivedAt: input.now,
          actorType: input.actor.type,
          actorId: input.actor.id ?? null,
          merchantUserId: input.actor.type === "merchant" ? (input.actor.id ?? null) : null,
          client: input.actor.client ?? null,
          role: input.actor.type === "merchant" ? (input.actor.role ?? null) : null,
          entityId: input.entityId,
          storeId: input.storeId,
          props: {
            type: input.type,
            fileCount: input.fileCount,
            hasDemand: input.hasDemand,
            uploaderRole: input.actor.type === "merchant" ? (input.actor.role ?? null) : "staff",
          },
        },
      });
    });
  } catch {
    console.error({ evt: "analytics.asset_upload_failed" }, "素材直记埋点失败");
  }
}
