import type { AuditRequestMeta } from "../../audit/index.js";
import type { DataScope } from "../../authz/index.js";
import type { EpisodeDownloadBody } from "@liyoxi/contract";
import type { DeliveryViewer } from "../context.js";
import type { DeliveryDownloadDeps } from "./context.js";
import { sampleUrl } from "./sample-url.js";
import { episodeUrl } from "./episode-url.js";
import { releaseView, adminReleaseView } from "./release.js";
export function createDeliveryDownloads(deps: DeliveryDownloadDeps) {
  return {
    sampleUrl: (viewer: DeliveryViewer, id: string, meta: AuditRequestMeta) =>
      sampleUrl(deps, viewer, id, meta),
    episodeUrl: (
      viewer: DeliveryViewer,
      id: string,
      body: EpisodeDownloadBody,
      meta: AuditRequestMeta,
    ) => episodeUrl(deps, viewer, id, body, meta),
    release: (viewer: DeliveryViewer, id: string) =>
      deps.tx.run((tx) => releaseView(tx, deps, viewer, id)),
    adminRelease: (scope: DataScope, id: string) =>
      deps.tx.run((tx) => adminReleaseView(tx, deps, scope, id)),
  };
}
export type DeliveryDownloads = ReturnType<typeof createDeliveryDownloads>;
export type { DeliveryDownloadDeps } from "./context.js";
