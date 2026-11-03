import { createRoute } from "@tanstack/react-router";
import { AccountsPage } from "../../features/publish/accounts/page";
import { accountRouteSearch } from "../../features/publish/accounts/health-model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/publish/accounts",
  beforeLoad: ({ context }) => requireModule(context.access, "publish"),
  validateSearch: accountRouteSearch,
  staticData: { pageKey: "publish.accounts" },
  component: AccountsPage,
});
