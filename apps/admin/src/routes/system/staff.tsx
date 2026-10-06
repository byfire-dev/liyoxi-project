import { createRoute } from "@tanstack/react-router";

import { StaffPage } from "../../features/system/staff-page";
import { staffSearch } from "../../features/system/staff-model";
import { requireModule } from "../../lib/guard";
import { writeTableSearch } from "../../lib/table-search";
import { rootRoute } from "../__root";

export const staffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sys/staff",
  validateSearch: (raw) => writeTableSearch(staffSearch(raw)),
  beforeLoad: ({ context }) => requireModule(context.access, "system"),
  staticData: { pageKey: "system.staff" },
  component: StaffPage,
});
