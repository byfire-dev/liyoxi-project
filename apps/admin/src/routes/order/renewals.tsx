import { createRoute } from "@tanstack/react-router";
import { RenewalsPage } from "../../features/order/renewals";
import { renewalSearch } from "../../features/order/renewals/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const renewalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/orders/renewals",
  validateSearch: renewalSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "order"),
  staticData: { pageKey: "order.renewals" },
  component: RenewalsPage,
});
