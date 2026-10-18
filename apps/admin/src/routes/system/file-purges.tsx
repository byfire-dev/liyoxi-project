import { createRoute } from "@tanstack/react-router";
import { FilePurgesPage } from "../../features/system/file-purges/page";
import { purgeSearch } from "../../features/system/file-purges/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const filePurgesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sys/file-purges",
  validateSearch: purgeSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "system"),
  staticData: { pageKey: "system.file_purges" },
  component: FilePurgesPage,
});
