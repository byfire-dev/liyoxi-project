import { createRoute } from "@tanstack/react-router";
import { AccountsPage } from "../../features/publish/accounts/page";
import { accountSearch } from "../../features/publish/accounts/model";
import { requireModule } from "../../lib/guard";
import { writeQueueSearch } from "../../lib/queue";
import { rootRoute } from "../__root";
export const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/publish/accounts",
  beforeLoad: ({ context }) => requireModule(context.access, "publish"),
  validateSearch: (raw) => writeQueueSearch(accountSearch(raw)),
  staticData: { pageKey: "publish.accounts" },
  component: AccountsPage,
});
