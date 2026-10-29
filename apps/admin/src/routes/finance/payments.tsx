import { createRoute } from "@tanstack/react-router";
import { PaymentsPage } from "../../features/finance/payments/page";
import { paymentSearch } from "../../features/finance/payments/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const paymentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/finance/payments",
  validateSearch: paymentSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "finance"),
  staticData: { pageKey: "finance.payments" },
  component: PaymentsPage,
});
