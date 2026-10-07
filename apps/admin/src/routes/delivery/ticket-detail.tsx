import { createRoute } from "@tanstack/react-router";
import { TicketDetailPage } from "../../features/delivery/ticket-detail/page";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const ticketDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/delivery/tickets/$ticketNo",
  beforeLoad: ({ context }) => requireModule(context.access, "delivery"),
  validateSearch: (raw: Record<string, unknown>) => ({
    tab: ["plan", "sample", "episodes", "ads"].includes(String(raw.tab))
      ? String(raw.tab)
      : "sample",
  }),
  staticData: { pageKey: "delivery.ticket_detail" },
  component: TicketDetailPage,
});
