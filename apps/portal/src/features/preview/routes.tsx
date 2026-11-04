import type { PortalRoute } from "../../lib/routes";
import type { PortalRuntime } from "../../lib/runtime";
import { PreviewPage } from "./PreviewPage";

export function createPreviewRoutes(runtime: PortalRuntime): readonly PortalRoute[] {
  return [
    {
      path: "/preview/$kind/$id",
      owner: "W6-12",
      access: "session",
      render: (params) => (
        <PreviewPage runtime={runtime} kind={params.kind ?? ""} id={params.id ?? ""} />
      ),
    },
  ];
}
