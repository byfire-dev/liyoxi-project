import type { Tx } from "../kernel/index.js";
import type { AdminFacts, AdminFactsQuery } from "../profile/index.js";

export async function readProfileAdminDeliveryFacts(
  tx: Tx,
  q: AdminFactsQuery,
): Promise<AdminFacts["delivery"]> {
  const rows = await tx.deliveryTicket.groupBy({
    by: ["step", "deliveryManagerId"],
    where: { entityId: q.entityId, storeId: q.storeId },
    _count: true,
  });
  const producing = (step: string) =>
    !["in_service", "takedown", "archived", "terminated"].includes(step);
  return {
    deliveringTicketCount: rows.filter((r) => producing(r.step)).reduce((n, r) => n + r._count, 0),
    producingCount: rows
      .filter(
        (r) => q.managerId !== null && r.deliveryManagerId === q.managerId && producing(r.step),
      )
      .reduce((n, r) => n + r._count, 0),
    inServiceCount: rows
      .filter(
        (r) =>
          q.managerId !== null &&
          r.deliveryManagerId === q.managerId &&
          ["in_service", "takedown"].includes(r.step),
      )
      .reduce((n, r) => n + r._count, 0),
  };
}
