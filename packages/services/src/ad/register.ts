import { implement as implementTenantCloseFacts } from "../kernel/index.js";
import { adCloseFactsPort } from "../tenant/index.js";
import { countBlockingStoreAds } from "./close-facts.js";
import {
  defineRegistration,
  implementKeyed,
  implementMerchantFacts,
  notifyReadPort,
  staffWorkPort,
  remindersPort,
} from "../kernel/index.js";
import {
  adConsentFacts,
  adVersionForNotify,
  adSlaForNotify,
  adsAwaitingMerchant,
  revalidateAdReminder,
} from "./notify-facts.js";
import { adStaffWork } from "./staff-work.js";
import { fileCategoryGuardPort } from "../media/index.js";
import { machinePort } from "../flow/index.js";
import { adCancelBinding, adCancelChain } from "./cancel-write.js";
import { adLifecycleBinding } from "./lifecycle.js";
import { adMerchantFacts } from "./merchant-facts.js";
import { adFileRefs } from "./reference-types.js";
export const registration = defineRegistration("ad", {
  timerHandlers: [
    {
      kind: "ad.returned_stale",
      critical: false,
      handle: async () => {
        throw new TypeError("广告待补充到期须由本实例运行时绑定");
      },
    },
  ],
  portImplementations: [
    implementKeyed(fileCategoryGuardPort, "ad_video", {
      assert: async () => {
        throw new TypeError("广告上传须由本实例运行时绑定");
      },
    }),
    implementKeyed(machinePort, adCancelChain, {
      companions: [
        ...new Set([
          ...(adCancelBinding.companions ?? []),
          ...(adLifecycleBinding.companions ?? []),
        ]),
      ],
      guards: { ...adCancelBinding.guards, ...adLifecycleBinding.guards },
    }),
    implementMerchantFacts("ad", adMerchantFacts),
    ...adFileRefs,
    implementTenantCloseFacts(adCloseFactsPort, { countBlockingStoreAds }),
    implementKeyed(
      notifyReadPort,
      "manualSubjectExists.ad",
      async (tx, id: string) =>
        (await tx.ad.findUnique({ where: { id }, select: { id: true } })) !== null,
    ),
    implementKeyed(notifyReadPort, "adConsentFacts", adConsentFacts),
    implementKeyed(notifyReadPort, "adVersionForNotify", adVersionForNotify),
    implementKeyed(notifyReadPort, "adSlaForNotify", adSlaForNotify),
    implementKeyed(remindersPort, "R5", {
      targets: adsAwaitingMerchant,
      revalidate: revalidateAdReminder,
    }),
    implementKeyed(staffWorkPort, "ad", adStaffWork),
  ],
});
