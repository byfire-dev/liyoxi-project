import { createRoute } from "@tanstack/react-router";
import { RolesPage } from "../../features/system/roles/page";
import { roleSearch } from "../../features/system/roles/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";

export const rolesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sys/roles",
  validateSearch: roleSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "system"),
  staticData: { pageKey: "system.roles" },
  component: RolesPage,
});
