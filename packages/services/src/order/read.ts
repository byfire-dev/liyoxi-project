import { DramaSnapshotSchema, OrderDetailSchema } from "@liyoxi/contract";
import type { OrderDetail } from "@liyoxi/contract";
import { listOperationsByHold } from "../billing/index.js";
import { getTicketBriefsByOrder, getPlanBriefByOrder } from "../delivery/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { OrderActor, OrderDeps } from "./context.js";
import { dictRefs } from "./quote.js";
const iso = (at: Date | null) => at?.toISOString() ?? null;
const date = (at: Date | null) => at?.toISOString().slice(0, 10) ?? null;
const TIMELINE = [
  "submitted",
  "started",
  "manager_assigned",
  "plan_confirmed",
  "ads_confirmed",
  "sample_confirmed",
  "delivered",
  "live",
  "usage_ended",
] as const;
// 履约字段经公开只读端口聚合；售后与授权书由后续工作包回补。
export async function detail(
  tx: Tx,
  actor: { membership: Pick<OrderActor["membership"], "storeId" | "entityId"> },
  id: string,
): Promise<OrderDetail> {
  const o = await tx.dramaOrder.findFirst({
    where: { id, storeId: actor.membership.storeId, entityId: actor.membership.entityId },
    include: {
      entity: true,
      store: true,
      subscriptionTerm: { include: { plan: true } },
      agreementConsent: { include: { agreementVersion: { include: { agreement: true } } } },
      orderItems: {
        orderBy: { itemNo: "asc" },
        include: { orderItemAccounts: { include: { channelAccount: true } } },
      },
    },
  });
  if (!o) throw new AppError("NOT_FOUND");
  const grouped = new Map<
    string,
    { opType: string; occurredAt: string; points: number; planPoints: number; addonPoints: number }
  >();
  for (const item of o.orderItems) {
    for (const op of await listOperationsByHold(tx, item.pointHoldId)) {
      if (!["hold", "capture", "release", "refund"].includes(op.opType)) continue;
      const key = `${op.opType}:${op.occurredAt.toISOString()}`,
        entry = grouped.get(key) ?? {
          opType: op.opType,
          occurredAt: op.occurredAt.toISOString(),
          points: 0,
          planPoints: 0,
          addonPoints: 0,
        };
      const plan = Math.abs(op.planDeltaPoints),
        addon = Math.abs(op.addonDeltaPoints);
      // capture 的 available delta 为 0；冻结数量是其完整消费数。
      entry.planPoints += plan;
      entry.addonPoints += addon;
      entry.points += op.opType === "capture" ? item.chargePoints : plan + addon;
      grouped.set(key, entry);
    }
  }
  const tickets = await getTicketBriefsByOrder(tx, o.id),
    plan = await getPlanBriefByOrder(tx, o.id);
  const consent = o.agreementConsent,
    version = consent.agreementVersion;
  return OrderDetailSchema.parse({
    orderId: o.id,
    orderNo: o.orderNo,
    submittedAt: iso(o.submittedAt),
    status: o.status,
    subStatus: o.subStatus,
    tab:
      o.status === "pending_start" || o.status === "producing"
        ? "producing"
        : o.status === "cancelled" || o.status === "refunded"
          ? "after_sale"
          : o.status,
    itemCount: o.itemCount,
    totalChargePoints: o.totalChargePoints,
    statusChangedAt: iso(o.statusChangedAt),
    startedAt: iso(o.startedAt),
    closedAt: iso(o.closedAt),
    entityName: o.entity.name,
    storeId: o.storeId,
    storeName: o.store.name,
    planCode: o.planCode,
    planName: o.subscriptionTerm.plan.name,
    discountBp: o.discountBp,
    isTopModel: o.isTopModel,
    surchargeBp: o.surchargeBp,
    focus: await dictRefs(tx, "custom_focus", o.focusCodes),
    note: o.note,
    expectedLaunchDate: date(o.expectedLaunchDate),
    referenceStoreAssetIds: [],
    pendingTodo: null,
    items: await Promise.all(
      o.orderItems.map(async (i) => {
        const snapshot = DramaSnapshotSchema.parse(i.dramaSnapshot);
        return {
          orderItemId: i.id,
          itemNo: i.itemNo,
          dramaId: i.dramaId,
          dramaTitle: snapshot.title,
          posterUrl: null,
          genres: await dictRefs(tx, "genre", snapshot.genreCodes),
          episodeCount: i.episodeCount,
          phase: i.phase,
          phaseChangedAt: iso(i.phaseChangedAt),
          ticketStep: tickets.find((t) => t.orderItemId === i.id)?.step ?? null,
          listPricePoints: i.listPricePoints,
          discountBp: i.discountBp,
          surchargeBp: i.surchargeBp,
          chargePoints: i.chargePoints,
          productionModel: i.productionModel,
          accounts: i.orderItemAccounts.map((a) => ({
            channelAccountId: a.channelAccountId,
            platform: a.platform,
            accountName: a.channelAccount.accountName,
          })),
          placements: [],
          agreedLaunchDate: date(i.agreedLaunchDate),
          usageStartDate: date(i.usageStartDate),
          usageEndDate: date(i.usageEndDate),
          usageEndSource: i.usageEndSource,
          liveEpisodeCount: i.liveEpisodeCount,
          returnPoints: {
            refundRequestedPoints: i.refundRequestedPoints,
            returnedPoints: i.returnedPoints,
            convertedPoints: i.convertedPoints,
            forfeitedPoints: i.forfeitedPoints,
          },
          cancelReasonCode: i.cancelReasonCode,
          cancelledAt: iso(i.cancelledAt),
          timeline: (() => {
            const ticket = tickets.find((t) => t.orderItemId === i.id);
            const times: Record<(typeof TIMELINE)[number], string | null> = {
              submitted: iso(o.submittedAt),
              started: iso(o.startedAt),
              manager_assigned: ticket?.assignedAt ?? null,
              plan_confirmed: ticket?.planConfirmedAt ?? null,
              ads_confirmed: ticket?.adsReadyAt ?? null,
              sample_confirmed: ticket?.sampleConfirmedAt ?? null,
              delivered: ticket?.deliveredAt ?? null,
              live: ticket?.liveAt ?? null,
              usage_ended: ticket?.usageEndedAt ?? null,
            };
            const firstPending = ["cancelled", "terminated"].includes(i.phase)
              ? undefined
              : TIMELINE.find((key) => !times[key]);
            return TIMELINE.map((key) => ({
              key,
              state: times[key] ? "done" : key === firstPending ? "current" : "todo",
              at: times[key] ?? (key === "usage_ended" ? date(i.usageEndDate) : null),
            }));
          })(),
        };
      }),
    ),
    deliveryPlan: plan,
    pointsEvents: [...grouped.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
    afterSales: [],
    agreements: [
      {
        agreementKey: consent.agreementKey,
        name: version.agreement.name,
        agreementVersionId: version.id,
        versionLabel: `v${version.major}.${version.minor}`,
        consentedAt: consent.consentedAt.toISOString(),
      },
    ],
    licenseLetters: [],
    actions: [],
  });
}
export async function signDetail(deps: OrderDeps, view: OrderDetail) {
  const files = await deps.tx.run(async (tx) =>
    (
      await tx.orderItem.findMany({
        where: { dramaOrderId: view.orderId },
        select: { id: true, dramaSnapshot: true },
      })
    ).map((i) => ({ id: i.id, fileId: DramaSnapshotSchema.parse(i.dramaSnapshot).posterFileId })),
  );
  // 不在业务事务内触达 Provider，短期 URL 也不进入幂等记录。
  for (const item of view.items) {
    const file = files.find((f) => f.id === item.orderItemId);
    if (file?.fileId) item.posterUrl = await deps.media.signRead({ fileId: file.fileId });
  }
  return view;
}
