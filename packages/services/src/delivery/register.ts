import { deliveryManagerPort } from "../profile/index.js";
import { launchChangedPort, launchHandlerPort } from "../publish/index.js";
import { createIdentityContext, defineRegistration, implement } from "../kernel/index.js";
import { assignStoreTickets } from "./assign.js";
import { boundDelivery } from "./binding.js";
import { DELIVERY_INVARIANT_CODES, findDeliveryViolations } from "./invariants.js";
import { deliveryMachines } from "./machines.js";
import { orderSidePort } from "./ports.js";
import { reevaluate } from "./reevaluate.js";
export const registration = defineRegistration("delivery", {
  ports: [orderSidePort],
  portImplementations: [
    ...deliveryMachines,
    implement(deliveryManagerPort, (tx, input) => assignStoreTickets(tx, boundDelivery(), input)),
    implement(launchChangedPort, (tx, input) =>
      reevaluate(
        tx,
        boundDelivery(),
        createIdentityContext({ actor: { type: "system", job: "publish.launch_changed" } }),
        input.deliveryTicketId,
      ).then(() => {}),
    ),
    implement(launchHandlerPort, async (tx, id) => {
      const ticket = await tx.deliveryTicket.findUnique({
        where: { id },
        include: { publisher: true, deliveryManager: true },
      });
      return ticket?.publisher?.status === "active"
        ? ticket.publisher.id
        : ticket?.deliveryManager?.status === "active"
          ? ticket.deliveryManager.id
          : null;
    }),
  ],
  invariants: [
    ...DELIVERY_INVARIANT_CODES.map((code) => ({
      code: `delivery.${code}`,
      severity: "P2" as const,
      modes: ["full" as const],
      heal: code === "I3" ? ("heal_and_alert" as const) : ("none" as const),
      run: (tx: Parameters<typeof findDeliveryViolations>[0]) => findDeliveryViolations(tx, code),
    })),
    { code: "flow.STUCK_TICKET", severity: "P2", modes: [], heal: "none" },
  ],
});
