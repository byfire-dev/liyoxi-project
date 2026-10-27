import { createRoute } from "@tanstack/react-router";
import { OrdersPage } from "../../features/order/orders/list";
import { paymentSearch } from "../../features/order/orders/payment-model";
import { orderSearch } from "../../features/order/orders/model";
import { requireModule } from "../../lib/guard";
import { writeTableSearch } from "../../lib/table-search";
import { rootRoute } from "../__root";
export const ordersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/orders",
  validateSearch: (
    raw,
  ): Partial<ReturnType<typeof paymentSearch>> & Record<string, string | number | undefined> => ({
    ...writeTableSearch(orderSearch(raw)),
    ...paymentSearch(raw),
  }),
  beforeLoad: ({ context }) => requireModule(context.access, "order"),
  staticData: { pageKey: "order.list" },
  component: OrdersPage,
});
