import { createRoute } from "@tanstack/react-router";
import { PatrolPage } from "../../features/publish/patrol/page";
import { patrolSearch } from "../../features/publish/patrol/model";
import { requireModule } from "../../lib/guard";
import { writeTableSearch } from "../../lib/table-search";
import { rootRoute } from "../__root";
export const patrolRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/publish/patrol",
  beforeLoad: ({ context }) => requireModule(context.access, "publish"),
  validateSearch: (raw) => {
    const search = patrolSearch(raw);
    return { ...writeTableSearch(search), ...(search.id ? { id: search.id } : {}) };
  },
  staticData: { pageKey: "publish.patrol" },
  component: PatrolPage,
});
