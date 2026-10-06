import { createRoute } from "@tanstack/react-router";
import { QualificationReviewPage } from "../../features/merchant/review/page";
import { reviewSearch } from "../../features/merchant/review/model";
import { requireModule } from "../../lib/guard";
import { writeQueueSearch } from "../../lib/queue";
import { rootRoute } from "../__root";
export const qualificationReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/merchants/review",
  validateSearch: (raw) => writeQueueSearch(reviewSearch(raw)),
  beforeLoad: ({ context }) => requireModule(context.access, "merchant"),
  staticData: { pageKey: "merchant.review" },
  component: QualificationReviewPage,
});
