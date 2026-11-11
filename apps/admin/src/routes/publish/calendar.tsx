import { createRoute } from "@tanstack/react-router";
import { CalendarPage } from "../../features/publish/calendar/page";
import { calendarSearch, writeCalendarSearch } from "../../features/publish/calendar/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const calendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/publish/calendar",
  beforeLoad: ({ context }) => requireModule(context.access, "publish"),
  validateSearch: (raw) => writeCalendarSearch(calendarSearch(raw)),
  staticData: { pageKey: "publish.calendar" },
  component: CalendarPage,
});
