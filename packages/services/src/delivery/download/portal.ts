import type { PortalOrderItemListQuery, PortalDownloadBody } from "@liyoxi/contract";
import type { AuditRequestMeta } from "../../audit/index.js";
import type { PortalPrincipal } from "../../identity/index.js";
import { portalList, portalRelease } from "./portal-read.js";
import { portalDownloadUrls } from "./portal-urls.js";
import type { PortalDeliveryDownloadDeps } from "./portal-context.js";

export function createPortalDeliveryDownloads(deps: PortalDeliveryDownloadDeps) {
  return {
    list: (principal: PortalPrincipal, query: PortalOrderItemListQuery) =>
      portalList(deps, principal, query),
    release: (principal: PortalPrincipal, id: string) =>
      deps.tx.run((tx) => portalRelease(tx, deps, principal, id)),
    downloadUrls: (
      principal: PortalPrincipal,
      id: string,
      body: PortalDownloadBody,
      meta: AuditRequestMeta,
    ) => portalDownloadUrls(deps, principal, id, body, meta),
  };
}
