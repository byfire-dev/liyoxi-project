import { createRoute } from "@tanstack/react-router";
import { MerchantDetailPage } from "../../features/merchant/detail/page";
import { merchantDetailSearch } from "../../features/merchant/detail/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const merchantDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/merchants/$storeId",
  validateSearch: merchantDetailSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "merchant"),
  staticData: { pageKey: "merchant.detail" },
  component: MerchantDetailPage,
});
