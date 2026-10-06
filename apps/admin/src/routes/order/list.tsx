import { createRoute } from "@tanstack/react-router";
import { OrdersPage } from "../../features/order/orders/list";
import { orderSearch } from "../../features/order/orders/model";
import { requireModule } from "../../lib/guard";
import { writeTableSearch } from "../../lib/table-search";
import { rootRoute } from "../__root";
export const ordersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/orders",
  validateSearch: (raw) => writeTableSearch(orderSearch(raw)),
  beforeLoad: ({ context }) => requireModule(context.access, "order"),
  staticData: { pageKey: "order.list" },
  component: OrdersPage,
});
