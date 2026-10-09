import { createRoute } from "@tanstack/react-router";
import { ParamsPage } from "../../features/system/config/params-page";
import { paramsSearch } from "../../features/system/config/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";

export const paramsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sys/params",
  validateSearch: (raw) => paramsSearch(raw),
  beforeLoad: ({ context }) => requireModule(context.access, "system"),
  staticData: { pageKey: "system.params" },
  component: ParamsPage,
});
