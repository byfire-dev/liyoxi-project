import { createRoute } from "@tanstack/react-router";
import { CreditAdjustPage } from "../../features/finance/credit-adjust/page";
import { adjustmentSearch } from "../../features/finance/credit-adjust/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const creditAdjustRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/finance/credit-adjust",
  validateSearch: adjustmentSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "finance"),
  staticData: { pageKey: "finance.credit_adjust" },
  component: CreditAdjustPage,
});
