import { createRoute } from "@tanstack/react-router";
import { OfflinePage } from "../../features/publish/offline/page";
import { offlineSearch } from "../../features/publish/offline/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const offlineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/publish/offline",
  beforeLoad: ({ context }) => requireModule(context.access, "publish"),
  validateSearch: offlineSearch,
  staticData: { pageKey: "publish.offline" },
  component: OfflinePage,
});
