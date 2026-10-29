import { createRoute } from "@tanstack/react-router";
import { RefundsPage } from "../../features/finance/refunds/page";
import { refundSearch } from "../../features/finance/refunds/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const refundsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/finance/refunds",
  validateSearch: refundSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "finance"),
  staticData: { pageKey: "finance.refunds" },
  component: RefundsPage,
});
