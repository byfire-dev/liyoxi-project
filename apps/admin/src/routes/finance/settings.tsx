import { createRoute } from "@tanstack/react-router";
import { FinanceSettingsPage } from "../../features/finance/settings/page";
import { settingsSearch } from "../../features/finance/settings/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const financeSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/finance/settings",
  validateSearch: settingsSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "finance"),
  staticData: { pageKey: "finance.settings" },
  component: FinanceSettingsPage,
});
