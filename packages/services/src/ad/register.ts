import { implement as implementTenantCloseFacts } from "../kernel/index.js";
import { adCloseFactsPort } from "../tenant/index.js";
import { countBlockingStoreAds } from "./close-facts.js";
import { defineRegistration, implementKeyed, notifyReadPort } from "../kernel/index.js";
import { adConsentFacts } from "./notify-facts.js";
import { machinePort } from "../flow/index.js";
import { adCancelBinding, adCancelChain } from "./cancel-write.js";
export const registration = defineRegistration("ad", {
  portImplementations: [
    implementKeyed(machinePort, adCancelChain, adCancelBinding),
    implementTenantCloseFacts(adCloseFactsPort, { countBlockingStoreAds }),
    implementKeyed(
      notifyReadPort,
      "manualSubjectExists.ad",
      async (tx, id: string) =>
        (await tx.ad.findUnique({ where: { id }, select: { id: true } })) !== null,
    ),
    implementKeyed(notifyReadPort, "adConsentFacts", adConsentFacts),
  ],
});
