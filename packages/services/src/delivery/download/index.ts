import type { AuditRequestMeta } from "../../audit/index.js";
import type { DataScope } from "../../authz/index.js";
import type { EpisodeDownloadBody, DownloadReportBody } from "@liyoxi/contract";
import type { DeliveryViewer, DeliveryWriteOptions } from "../context.js";
import type { DeliveryDownloadDeps } from "./context.js";
import { sampleUrl } from "./sample-url.js";
import { episodeUrl } from "./episode-url.js";
import { releaseView, adminReleaseView } from "./release.js";
import { createGrant, reportDownload } from "./progress.js";
export function createDeliveryDownloads(deps: DeliveryDownloadDeps) {
  return {
    createGrant: (viewer: DeliveryViewer, id: string, options: DeliveryWriteOptions = {}) =>
      createGrant(deps, viewer, id, options),
    report: (
      viewer: DeliveryViewer,
      id: string,
      body: DownloadReportBody,
      options: DeliveryWriteOptions = {},
    ) => reportDownload(deps, viewer, id, body, options),
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
export { createPortalDeliveryDownloads } from "./portal.js";
export type { PortalDeliveryDownloadDeps } from "./portal-context.js";
