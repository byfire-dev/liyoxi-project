import { createRoute } from "@tanstack/react-router";
import { ApprovalsPage } from "../../features/approval/page";
import { approvalSearch } from "../../features/approval/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";

export const approvalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/approvals",
  validateSearch: approvalSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "workbench"),
  staticData: { pageKey: "approval.mine" },
  component: ApprovalsPage,
});
