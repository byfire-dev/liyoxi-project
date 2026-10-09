import { defineRegistration, implementKeyed, notifyReadPort } from "../kernel/index.js";
import { adConsentFacts } from "./notify-facts.js";
export const registration = defineRegistration("ad", {
  portImplementations: [
    implementKeyed(
      notifyReadPort,
      "manualSubjectExists.ad",
      async (tx, id: string) =>
        (await tx.ad.findUnique({ where: { id }, select: { id: true } })) !== null,
    ),
    implementKeyed(notifyReadPort, "adConsentFacts", adConsentFacts),
  ],
});
