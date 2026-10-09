import { staffWorkPort, staffFollowUpPort, implementKeyed } from "../kernel/index.js";
import { deliveryStaffWork } from "./staff-work.js";
import { remindersPort as currentReminders } from "../kernel/index.js";
import {
  implementKeyed as notifyReaderImplementation,
  notifyReadPort as currentNotifyReadPort,
} from "../kernel/index.js";
import {
  planForNotify,
  sampleForNotify,
  releaseForNotify,
  samplesAwaitingMerchant,
  ticketForNotify,
  ticketManagerForNotify,
  ticketEditorForNotify,
  planManagerForNotify,
  sampleManagerForNotify,
  sampleEditorForNotify,
} from "./notify-facts.js";
import { deliveryManagerPort } from "../profile/index.js";
import { launchChangedPort, launchHandlerPort } from "../publish/index.js";
import { createIdentityContext, defineRegistration, implement } from "../kernel/index.js";
import { assignStoreTickets } from "./assign.js";
import { boundDelivery } from "./binding.js";
import { DELIVERY_INVARIANT_CODES, findDeliveryViolations } from "./invariants.js";
import { deliveryMachines } from "./machines.js";
import { orderSidePort } from "./ports.js";
import { reevaluate } from "./reevaluate.js";
import { deliveryFileRefs } from "./file-refs.js";
export const registration = defineRegistration("delivery", {
  ports: [orderSidePort],
  portImplementations: [
    implementKeyed(staffFollowUpPort, "delivery_reissue", async (tx, id) => {
      const row = await tx.deliveryReissue.findUnique({
        where: { id },
        select: { entityId: true, storeId: true },
      });
      return row === null ? null : { entityId: row.entityId, storeId: row.storeId };
    }),
    implementKeyed(staffWorkPort, "delivery", deliveryStaffWork),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "manualSubjectExists.delivery_ticket",
      async (tx, id: string) =>
        (await tx.deliveryTicket.findUnique({ where: { id }, select: { id: true } })) !== null,
    ),
    notifyReaderImplementation(currentReminders, "R4", {
      targets: samplesAwaitingMerchant,
      revalidate: async (tx, item) => {
        const fact =
          typeof item.sampleId === "string" ? await sampleForNotify(tx, item.sampleId) : null;
        return { valid: fact?.status === "pushed" && fact.version === item.version };
      },
    }),
    notifyReaderImplementation(currentNotifyReadPort, "planForNotify", planForNotify),
    notifyReaderImplementation(currentNotifyReadPort, "sampleForNotify", sampleForNotify),
    notifyReaderImplementation(currentNotifyReadPort, "releaseForNotify", releaseForNotify),

    notifyReaderImplementation(currentNotifyReadPort, "ticketForNotify", ticketForNotify),
    notifyReaderImplementation(currentNotifyReadPort, "planManagerForNotify", planManagerForNotify),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "sampleManagerForNotify",
      sampleManagerForNotify,
    ),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "sampleEditorForNotify",
      sampleEditorForNotify,
    ),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "ticketManagerForNotify",
      ticketManagerForNotify,
    ),
    notifyReaderImplementation(
      currentNotifyReadPort,
      "ticketEditorForNotify",
      ticketEditorForNotify,
    ),
    ...deliveryMachines,
    ...deliveryFileRefs,
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
  subscribers: [
    {
      name: "delivery.onProductionChecked",
      events: ["media.production.checked"],
      handle: async () => {
        throw new TypeError("交付制作运行时尚未绑定");
      },
    },
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
