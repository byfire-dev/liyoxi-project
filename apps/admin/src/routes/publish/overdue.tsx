import { createRoute } from "@tanstack/react-router";
import { OverduePage } from "../../features/publish/overdue/page";
import { overdueSearch, writeOverdueSearch } from "../../features/publish/overdue/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const overdueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/publish/overdue",
  beforeLoad: ({ context }) => requireModule(context.access, "publish"),
  validateSearch: (raw) => writeOverdueSearch(overdueSearch(raw)),
  staticData: { pageKey: "publish.overdue" },
  component: OverduePage,
});
