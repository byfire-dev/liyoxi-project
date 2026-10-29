import { createRoute } from "@tanstack/react-router";
import { ReconcilePage } from "../../features/finance/reconcile/page";
import { reconcileSearch } from "../../features/finance/reconcile/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const reconcileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/finance/reconcile",
  validateSearch: reconcileSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "finance"),
  staticData: { pageKey: "finance.reconcile" },
  component: ReconcilePage,
});
