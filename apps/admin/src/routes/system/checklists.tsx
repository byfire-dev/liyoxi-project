import { createRoute } from "@tanstack/react-router";
import { ChecklistsPage } from "../../features/system/config/checklists-page";
import { configTableSearch } from "../../features/system/config/model";
import { requireModule } from "../../lib/guard";
import { writeTableSearch } from "../../lib/table-search";
import { rootRoute } from "../__root";

export const checklistsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sys/checklists",
  validateSearch: (raw) => ({
    ...writeTableSearch(configTableSearch(raw, true)),
    ...(typeof raw.id === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(raw.id)
      ? { id: raw.id }
      : {}),
  }),
  beforeLoad: ({ context }) => requireModule(context.access, "system"),
  staticData: { pageKey: "system.checklists" },
  component: ChecklistsPage,
});
