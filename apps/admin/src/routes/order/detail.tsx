import { createRoute } from "@tanstack/react-router";
import { OrderDetailPage } from "../../features/order/orders/detail";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const orderDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/orders/$orderNo",
  beforeLoad: ({ context }) => requireModule(context.access, "order"),
  staticData: { pageKey: "order.detail" },
  component: OrderDetailPage,
});
