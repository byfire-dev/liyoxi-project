import { createRoute } from "@tanstack/react-router";
import { TicketsPage } from "../../features/delivery/tickets/page";
import { ticketSearch } from "../../features/delivery/tickets/model";
import { requireModule } from "../../lib/guard";
import { writeTableSearch } from "../../lib/table-search";
import { rootRoute } from "../__root";
export const ticketsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/delivery/tickets",
  beforeLoad: ({ context }) => requireModule(context.access, "delivery"),
  validateSearch: (raw) => writeTableSearch(ticketSearch(raw)),
  staticData: { pageKey: "delivery.tickets" },
  component: TicketsPage,
});
