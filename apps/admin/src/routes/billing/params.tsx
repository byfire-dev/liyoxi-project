import { createRoute } from "@tanstack/react-router";
import { BillingParamsPage } from "../../features/billing/params";
import { paramsSearch } from "../../features/billing/params/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const paramsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/billing/params",
  validateSearch: paramsSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "billing"),
  staticData: { pageKey: "billing.params" },
  component: BillingParamsPage,
});
