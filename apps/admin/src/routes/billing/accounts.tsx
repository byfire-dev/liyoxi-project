import { createRoute } from "@tanstack/react-router";
import { AccountsPage } from "../../features/billing/accounts";
import { accountSearch } from "../../features/billing/accounts/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/billing/accounts",
  validateSearch: accountSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "billing"),
  staticData: { pageKey: "billing.accounts" },
  component: AccountsPage,
});
