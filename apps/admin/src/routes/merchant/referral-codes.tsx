import { createRoute } from "@tanstack/react-router";
import { ReferralCodesPage } from "../../features/merchant/referral-codes/page";
import { referralSearch } from "../../features/merchant/referral-codes/model";
import { requireModule } from "../../lib/guard";
import { rootRoute } from "../__root";
export const referralCodesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/merchants/referral-codes",
  validateSearch: referralSearch,
  beforeLoad: ({ context }) => requireModule(context.access, "merchant"),
  staticData: { pageKey: "merchant.referral_codes" },
  component: ReferralCodesPage,
});
