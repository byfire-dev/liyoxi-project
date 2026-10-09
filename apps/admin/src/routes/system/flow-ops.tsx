import { createRoute, redirect } from "@tanstack/react-router";
import { FlowOpsPage } from "../../features/system/flow-ops/page";
import { canReadFlow, flowSearch } from "../../features/system/flow-ops/model";
import { FORBIDDEN_PATH } from "../../lib/guard";
import { rootRoute } from "../__root";
export const flowOpsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sys/flow-ops",
  validateSearch: flowSearch,
  beforeLoad: ({ context }) => {
    if (!canReadFlow(context.access)) throw redirect({ to: FORBIDDEN_PATH });
  },
  staticData: { pageKey: "system.flow_ops" },
  component: FlowOpsPage,
});
