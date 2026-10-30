import type { Sample } from "@liyoxi/db";
import type { Tx } from "../kernel/index.js";
import type { DeliveryDeps } from "./context.js";
import type { TicketRow } from "./repo.js";

/** Read historical access evidence without manufacturing a view or merchant acknowledgement. */
export async function sampleEvidence(tx: Tx, deps: DeliveryDeps, t: TicketRow, s: Sample) {
  const rows = await tx.auditLog.findMany({
    where: {
      stream: "access",
      targetType: "sample",
      targetId: s.id,
      action: { in: ["delivery.sample.album_download", "delivery.sample.portal_preview"] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const album = rows.find((r) => r.action === "delivery.sample.album_download")?.createdAt ?? null,
    portal = rows.find((r) => r.action === "delivery.sample.portal_preview")?.createdAt ?? null,
    enabled = (await deps.samplePlayback?.(t.entityId)) ?? false;
  const production = await deps.media.deliveryProductionFacts(tx, s.fileId);
  const possible =
    enabled && s.previewChannels.includes("weapp") && production.ready && production.playable
      ? ["weapp"]
      : [];
  return { album, portal, enabled, possible, production };
}
