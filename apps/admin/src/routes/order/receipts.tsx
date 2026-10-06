import { createRoute } from "@tanstack/react-router";
import { ReceiptsPage } from "../../features/order/receipts/page";
import { requireModule } from "../../lib/guard";
import { readQueueSearch, writeQueueSearch } from "../../lib/queue";
import { rootRoute } from "../__root";
export const receiptsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/orders/receipts",
  validateSearch: (raw) => {
    const search = readQueueSearch(raw);
    return writeQueueSearch({
      ...search,
      tab: search.tab === "processed_today" ? "processed_today" : "pending",
      q: search.q?.slice(0, 100),
    });
  },
  beforeLoad: ({ context }) => requireModule(context.access, "order"),
  staticData: { pageKey: "order.receipts" },
  component: ReceiptsPage,
});
