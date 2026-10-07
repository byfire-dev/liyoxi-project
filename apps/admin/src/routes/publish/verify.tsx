import { createRoute } from "@tanstack/react-router";
import { VerifyPage } from "../../features/publish/verify/page";
import { verifySearch } from "../../features/publish/verify/model";
import { requireModule } from "../../lib/guard";
import { writeQueueSearch } from "../../lib/queue";
import { rootRoute } from "../__root";
export const verifyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/publish/verify",
  beforeLoad: ({ context }) => requireModule(context.access, "publish"),
  validateSearch: (raw) => writeQueueSearch(verifySearch(raw)),
  staticData: { pageKey: "publish.verify" },
  component: VerifyPage,
});
