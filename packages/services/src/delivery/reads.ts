import { PlanContentSchema } from "@liyoxi/contract";
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
  assignedAt: Date | null;
  planConfirmedAt: Date | null;
  adsReadyAt: Date | null;
  sampleConfirmedAt: Date | null;
  deliveredAt: Date | null;
  liveAt: Date | null;
  usageEndedAt: Date | null;
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
  assignedAt: iso(r.assignedAt),
  planConfirmedAt: iso(r.planConfirmedAt),
  adsReadyAt: iso(r.adsReadyAt),
  sampleConfirmedAt: iso(r.sampleConfirmedAt),
  deliveredAt: iso(r.deliveredAt),
  liveAt: iso(r.liveAt),
  usageEndedAt: iso(r.usageEndedAt),
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
  const p = await tx.deliveryPlan.findUnique({
    where: { dramaOrderId },
    include: { deliveryPlanVersions: true, dramaOrder: { include: { orderItems: true } } },
  });
  if (!p) return null;
  const summaryVersionNo = p.confirmedVersionNo ?? (p.currentVersionNo || null);
  const version =
    summaryVersionNo === null
      ? null
      : p.deliveryPlanVersions.find((v) => v.versionNo === summaryVersionNo);
  if (summaryVersionNo !== null && !version) throw new Error("交付方案摘要版本缺失");
  const content = version ? PlanContentSchema.parse(version.contentSnapshot) : null;
  const focus = await Promise.all(
    (content?.focusTags ?? []).map(async (code) => {
      const item = await tx.dictItem.findUnique({
        where: { dictTypeKey_code: { dictTypeKey: "custom_focus", code } },
      });
      return { code, name: item?.name ?? code };
    }),
  );
  const dates = p.dramaOrder.orderItems
    .filter((i) => !["cancelled", "refunded", "terminated"].includes(i.phase))
    .map((i) => i.agreedLaunchDate?.toISOString().slice(0, 10) ?? null);
  return {
    deliveryPlanId: p.id,
    status: p.status,
    currentVersionNo: p.currentVersionNo,
    confirmedVersionNo: p.confirmedVersionNo,
    pushedAt: iso(p.pushedAt),
    confirmedAt: iso(p.confirmedAt),
    summaryVersionNo,
    focus,
    launchMode: content?.launchMode ?? null,
    placements: [
      ...new Map(
        (content?.items ?? [])
          .flatMap((i) => i.placements)
          .map((p) => [`${p.slot}:${p.durationSec}`, { slot: p.slot, durationSec: p.durationSec }]),
      ).values(),
    ],
    agreedLaunchDate: dates[0] && dates.every((d) => d === dates[0]) ? dates[0] : null,
  };
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
