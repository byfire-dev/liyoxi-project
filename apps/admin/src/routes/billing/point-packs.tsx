import { createRoute } from "@tanstack/react-router";
import { PointPacksPage } from "../../features/billing/point-packs";
import { packSearch } from "../../features/billing/point-packs/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const pointpacksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/billing/point-packs",
  validateSearch: packSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "billing"),
  staticData: { pageKey: "billing.point_packs" },
  component: PointPacksPage,
});
