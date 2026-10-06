import type { Tx } from "../kernel/index.js";
import { iso } from "./repo.js";
const brief = (r: {
  id: string;
  ticketNo: string;
  step: string;
  pauseCount: number;
  waitingOn: string;
  stepDueAt: Date | null;
  deliveryManagerId: string | null;
  editorId: string | null;
  publisherId: string | null;
  orderItemId: string;
}) => ({
  deliveryTicketId: r.id,
  ticketNo: r.ticketNo,
  step: r.step,
  isPaused: r.pauseCount > 0,
  waitingOn: r.waitingOn,
  stepDueAt: iso(r.stepDueAt),
  deliveryManagerId: r.deliveryManagerId,
  editorId: r.editorId,
  publisherId: r.publisherId,
  orderItemId: r.orderItemId,
});
/** 仅同事务内部聚合使用；HTTP 范围由调用的订单用例判定。 */
export async function getTicketBriefByOrderItem(tx: Tx, orderItemId: string) {
  const r = await tx.deliveryTicket.findUnique({ where: { orderItemId } });
  return r ? brief(r) : null;
}
export async function getTicketBriefsByOrder(tx: Tx, dramaOrderId: string) {
  return (
    await tx.deliveryTicket.findMany({ where: { dramaOrderId }, orderBy: { id: "asc" } })
  ).map(brief);
}
export async function getPlanBriefByOrder(tx: Tx, dramaOrderId: string) {
  const p = await tx.deliveryPlan.findUnique({ where: { dramaOrderId } });
  return p
    ? {
        deliveryPlanId: p.id,
        status: p.status,
        currentVersionNo: p.currentVersionNo,
        confirmedVersionNo: p.confirmedVersionNo,
        pushedAt: iso(p.pushedAt),
        confirmedAt: iso(p.confirmedAt),
      }
    : null;
}
export async function getTicketTimeline(tx: Tx, deliveryTicketId: string) {
  return (
    await tx.deliveryTicketStage.findMany({
      where: { deliveryTicketId },
      orderBy: [{ enteredAt: "asc" }, { id: "asc" }],
    })
  ).map((r) => ({
    step: r.step,
    visitNo: r.visitNo,
    enteredAt: iso(r.enteredAt),
    completedAt: iso(r.completedAt),
    exitEvent: r.exitEvent,
  }));
}
