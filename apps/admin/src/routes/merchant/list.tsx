import { createRoute } from "@tanstack/react-router";
import { MerchantListPage } from "../../features/merchant/list/page";
import { merchantListSearch } from "../../features/merchant/list/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const merchantListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/merchants",
  validateSearch: merchantListSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "merchant"),
  staticData: { pageKey: "merchant.list" },
  component: MerchantListPage,
});
