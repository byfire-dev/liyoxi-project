import type { AuditRequestMeta } from "../../audit/index.js";
import { AppError } from "../../kernel/index.js";
import type { DeliveryViewer } from "../context.js";
import { sampleOf } from "../samples.js";
import type { DeliveryDownloadDeps } from "./context.js";
import { viewerOf } from "./repo.js";

/** The legacy operation stays authenticated; Q9 no longer issues album download addresses. */
export async function sampleUrl(
  deps: DeliveryDownloadDeps,
  v: DeliveryViewer,
  id: string,
  _meta: AuditRequestMeta,
): Promise<{ url: string; expiresAt: string; fileName: string; sizeBytes: string }> {
  return deps.tx.run(async (tx) => {
    await viewerOf(tx, v, true);
    const { s, t } = await sampleOf(tx, id, v);
    if (
      !["pushed", "confirmed", "change_requested"].includes(s.status) ||
      s.versionNo !== t.currentSampleVersionNo
    )
      throw new AppError("STATE_NOT_ALLOWED");
    throw new AppError("FEATURE_DISABLED");
  });
}
