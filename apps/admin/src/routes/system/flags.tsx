import { createRoute, redirect } from "@tanstack/react-router";
import { FlagsPage } from "../../features/system/config/flags-page";
import { configTableSearch } from "../../features/system/config/model";
import { requireModule } from "../../lib/guard";
import { canAction } from "../../lib/permissions";
import { writeTableSearch } from "../../lib/table-search";
import { rootRoute } from "../__root";

export const flagsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sys/flags",
  validateSearch: (raw) => ({
    ...writeTableSearch(configTableSearch(raw)),
    ...(typeof raw.id === "string" && /^[a-z][a-z0-9_.]{0,99}$/.test(raw.id) ? { id: raw.id } : {}),
  }),
  beforeLoad: ({ context }) => {
    requireModule(context.access, "system");
    if (!canAction(context.access, "sys.super_admin")) throw redirect({ to: "/403" });
  },
  staticData: { pageKey: "system.flags" },
  component: FlagsPage,
});
