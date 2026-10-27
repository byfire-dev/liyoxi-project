import { createRoute } from "@tanstack/react-router";
import { PlansPage } from "../../features/billing/plans";
import { plansSearch } from "../../features/billing/plans/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const plansRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/billing/plans",
  validateSearch: plansSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "billing"),
  staticData: { pageKey: "billing.plans" },
  component: PlansPage,
});
