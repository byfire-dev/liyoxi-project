import { createRoute } from "@tanstack/react-router";
import { DeliveriesPage } from "../../features/publish/deliveries/page";
import { deliverySearch } from "../../features/publish/deliveries/model";
import { requireModule } from "../../lib/guard";
import { writeQueueSearch } from "../../lib/queue";
import { rootRoute } from "../__root";
export const deliveriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/publish/deliveries",
  beforeLoad: ({ context }) => requireModule(context.access, "publish"),
  validateSearch: (raw) => writeQueueSearch(deliverySearch(raw)),
  staticData: { pageKey: "publish.deliveries" },
  component: DeliveriesPage,
});
