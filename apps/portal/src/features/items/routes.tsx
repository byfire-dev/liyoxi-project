import type { PortalRoute } from "../../lib/routes";
import type { PortalRuntime } from "../../lib/runtime";
import { ItemPage } from "../item/ItemPage";
import { ItemsPage } from "./ItemsPage";

export function createDownloadRoutes(runtime: PortalRuntime): readonly PortalRoute[] {
  return [
    {
      path: "/items",
      owner: "W6-11",
      access: "session",
      render: () => <ItemsPage runtime={runtime} />,
    },
    {
      path: "/items/$id",
      owner: "W6-11",
      access: "session",
      render: (params) => <ItemPage runtime={runtime} orderItemId={params.id!} />,
    },
  ];
}
