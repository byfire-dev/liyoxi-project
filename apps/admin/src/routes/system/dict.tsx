import { createRoute } from "@tanstack/react-router";
import { DictPage } from "../../features/system/config/dict-page";
import { dictSearch } from "../../features/system/config/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";

export const dictRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sys/dict",
  validateSearch: dictSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "system"),
  staticData: { pageKey: "system.dict" },
  component: DictPage,
});
