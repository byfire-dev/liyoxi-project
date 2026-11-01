import { createRoute } from "@tanstack/react-router";
import { AdTasksPage } from "../../features/delivery/ad-tasks/page";
import { adSearch } from "../../features/delivery/ad-tasks/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const adTasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/delivery/ad-tasks",
  beforeLoad: ({ context }) => requireModule(context.access, "delivery"),
  validateSearch: adSearch,
  staticData: { pageKey: "delivery.ad_tasks" },
  component: AdTasksPage,
});
