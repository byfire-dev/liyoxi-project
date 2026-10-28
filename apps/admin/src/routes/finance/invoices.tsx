import { createRoute } from "@tanstack/react-router";
import { InvoicesPage } from "../../features/finance/invoices/page";
import { invoiceSearch } from "../../features/finance/invoices/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const invoicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/finance/invoices",
  validateSearch: invoiceSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "finance"),
  staticData: { pageKey: "finance.invoices" },
  component: InvoicesPage,
});
