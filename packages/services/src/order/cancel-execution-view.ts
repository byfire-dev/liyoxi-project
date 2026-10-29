import {
  CancelRequestDetailSchema,
  ReturnBreakdownSchema,
  PricingSnapshotSchema,
} from "@liyoxi/contract";
import type { CancelRequestDetail } from "@liyoxi/contract";
import { readAdCancelFacts } from "../ad/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { CancelActor, CancelDeps } from "./cancel-context.js";
import { readCancelExecutionRequest } from "./cancel-execution.js";
import { dictRefs } from "./quote.js";

const iso = (at: Date | null) => at?.toISOString() ?? null;
const date = (at: Date | null) => at?.toISOString().slice(0, 10) ?? null;
const adLabel = (type: string, seconds: number) =>
  `${type === "opening" ? "片头贴片" : type === "ending" ? "片尾贴片" : type === "corner" ? "角标字幕条" : type === "mid_roll" ? "片中插播" : type} ${seconds} 秒`;

/** Execute-only projection: scope and real execute permission have already been checked in this Tx. */
export async function readExecutedCancelDetail(
  tx: Tx,
  deps: CancelDeps,
  actor: CancelActor,
  id: string,
): Promise<CancelRequestDetail> {
  const r = await readCancelExecutionRequest(tx, actor, id);
  if (r.status !== "done" || !r.executedAt || !actor.staff) throw new AppError("STATE_NOT_ALLOWED");
  return projectCancelRequestDetail(tx, deps, r, []);
}
export type CancelReadRequest = Awaited<ReturnType<typeof readCancelExecutionRequest>>;
const title = (value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("title" in value) ||
    typeof value.title !== "string"
  )
    throw new AppError("PRECONDITION_CHANGED", { message: "取消明细缺少真实剧名快照" });
  return value.title;
};
/** Caller has checked domain read visibility or the stronger execute authorization. Never writes. */
export async function projectCancelRequestDetail(
  tx: Tx,
  deps: CancelDeps,
  r: CancelReadRequest,
  actions: CancelRequestDetail["actions"],
): Promise<CancelRequestDetail> {
  const a = r.approvalRequest;
  const done = r.status === "done";
  if (done && !r.executedAt) throw new AppError("PRECONDITION_CHANGED");
  const store = await tx.store.findUniqueOrThrow({
    where: { id: r.storeId },
    include: {
      entity: { select: { name: true } },
      storeProfileStore: { select: { cityCode: true, districtCode: true } },
    },
  });
  const staffRows = await tx.staff.findMany({
    where: {
      id: {
        in: [a.requesterStaffId, a.decidedByStaffId, r.executedByStaffId].filter(
          (v): v is string => v !== null,
        ),
      },
    },
    select: { id: true, staffNo: true, name: true, staffRoleKey: true, isLead: true, status: true },
  });
  const brief = (staffId: string | null) => {
    const s = staffRows.find((row) => row.id === staffId);
    return s
      ? {
          staffId: s.id,
          staffNo: s.staffNo,
          name: s.name,
          roleKey: s.staffRoleKey,
          isLead: s.isLead,
          status: s.status,
        }
      : null;
  };
  const items = await tx.orderItem.findMany({
    where: {
      id: {
        in: r.cancelRequestLines
          .filter((l) => l.targetType === "order_item")
          .map((l) => l.targetId),
      },
    },
    include: { orderItemAccounts: true },
  });
  const order = r.dramaOrderId
    ? await tx.dramaOrder.findUniqueOrThrow({
        where: { id: r.dramaOrderId },
        include: { subscriptionTerm: { include: { plan: true } } },
      })
    : null;
  const ad = r.adId ? await readAdCancelFacts(tx, r.adId) : null;
  if (
    (order && (order.entityId !== r.entityId || order.storeId !== r.storeId)) ||
    (r.adId && (!ad || ad.entityId !== r.entityId || ad.storeId !== r.storeId))
  )
    throw new AppError("PRECONDITION_CHANGED", { message: "取消对象归属不一致" });
  const adPricing = ad ? PricingSnapshotSchema.parse(ad.pricingSnapshot) : null;
  const adPlan = adPricing
    ? await tx.plan.findUniqueOrThrow({ where: { id: adPricing.planId } })
    : null;
  const lines = await Promise.all(
    r.cancelRequestLines.map(async (line) => {
      const item =
        line.targetType === "order_item" ? items.find((i) => i.id === line.targetId) : undefined;
      const targetAd =
        line.targetType === "ad"
          ? ad?.id === line.targetId
            ? ad
            : await readAdCancelFacts(tx, line.targetId)
          : null;
      if (!item && !targetAd) throw new AppError("PRECONDITION_CHANGED");
      if (
        (item &&
          (item.entityId !== r.entityId ||
            item.storeId !== r.storeId ||
            (r.kind === "order_cancel" && item.dramaOrderId !== r.dramaOrderId))) ||
        (targetAd && (targetAd.entityId !== r.entityId || targetAd.storeId !== r.storeId))
      )
        throw new AppError("PRECONDITION_CHANGED", { message: "取消明细对象归属不一致" });
      if (
        done &&
        (line.executedAt === null ||
          line.returnedPoints === null ||
          line.convertedPoints === null ||
          line.forfeitedPoints === null ||
          line.resultSnapshot === null)
      )
        throw new AppError("PRECONDITION_CHANGED", { message: "已执行取消缺少真实明细结果" });
      if (
        !done &&
        (line.executedAt !== null ||
          line.returnedPoints !== null ||
          line.convertedPoints !== null ||
          line.forfeitedPoints !== null ||
          line.resultSnapshot !== null)
      )
        throw new AppError("PRECONDITION_CHANGED", { message: "未执行取消含不完整执行结果" });
      const breakdown = done ? ReturnBreakdownSchema.parse(line.resultSnapshot) : null;
      if (
        done &&
        (!breakdown ||
          breakdown.qty !== line.refundPoints ||
          breakdown.backToOriginal !== line.returnedPoints ||
          breakdown.convertedToAddon !== line.convertedPoints ||
          breakdown.forfeited !== line.forfeitedPoints)
      )
        throw new AppError("PRECONDITION_CHANGED", { message: "已执行明细结果与真实去向不一致" });
      return {
        cancelRequestLineId: line.id,
        targetType: line.targetType,
        targetId: line.targetId,
        label: item
          ? title(item.dramaSnapshot)
          : `${adLabel(targetAd!.type, targetAd!.durationSec)} · ${targetAd!.adNo}`,
        episodeCount: item?.episodeCount ?? null,
        productionModel: item?.productionModel ?? null,
        platforms: item?.orderItemAccounts.map((v) => v.platform) ?? [],
        mode: line.mode,
        stage: line.stage,
        stepAtSubmit: line.stepAtSubmit,
        reasonClass: line.reasonClass,
        chargePoints: line.chargePoints,
        priorRequestedPoints: line.priorRequestedPoints,
        ratioBp: line.ratioBp,
        isManualDeduct: line.stage === "post_sample" && line.ratioBp === null,
        deductPoints: line.deductPoints,
        deductNote: line.deductNote,
        refundPoints: line.refundPoints,
        terminationDate: date(line.terminationDate),
        usageStartDate: date(line.usageStartDate),
        usageEndDate: date(line.usageEndDate),
        usageEndSource: line.usageEndSource,
        capturedAt: iso(item?.capturedAt ?? targetAd?.capturedAt ?? null),
        preview: ReturnBreakdownSchema.parse(line.previewSnapshot),
        result: done
          ? {
              returnedPoints: line.returnedPoints,
              convertedPoints: line.convertedPoints,
              forfeitedPoints: line.forfeitedPoints,
              executedAt: iso(line.executedAt),
              breakdown,
            }
          : null,
        targetState: item?.phase ?? targetAd!.status,
      };
    }),
  );
  const summary = (key: "qty" | "backToOriginal" | "convertedToAddon" | "forfeited") =>
    lines.reduce((n, l) => n + l.preview[key], 0);
  const city = store.storeProfileStore?.cityCode,
    district = store.storeProfileStore?.districtCode;
  const reasons = await dictRefs(tx, "reject_reason", a.reasonCodes);
  const now = deps.clock.now();
  const isOverdue =
    (r.status === "pending_approval" && a.dueAt !== null && a.dueAt < now) ||
    (r.status === "pending_execution" && r.execDueAt !== null && r.execDueAt < now);
  const approval = {
    approvalId: a.id,
    kind: a.kind,
    status: a.status,
    roundNo: a.roundNo,
    submittedAt: iso(a.submittedAt),
    dueAt: iso(a.dueAt),
    badges: isOverdue ? ["overdue"] : [],
    requester: brief(a.requesterStaffId),
    decidedBy: brief(a.decidedByStaffId),
    isDecidedBySystem: a.isDecidedBySystem,
    decidedAt: iso(a.decidedAt),
    decisionNote: a.decisionNote,
    reasons,
    lockVersion: a.lockVersion,
    actions,
  };
  return CancelRequestDetailSchema.parse({
    cancelRequestId: r.id,
    requestNo: a.requestNo,
    kind: r.kind,
    store: {
      storeId: store.id,
      storeName: store.name,
      entityId: store.entityId,
      entityName: store.entity.name,
      city: city ? (await dictRefs(tx, "region", [city]))[0] : null,
      district: district ? (await dictRefs(tx, "region", [district]))[0] : null,
      qualificationStatus: store.qualificationStatus,
    },
    target: order
      ? {
          type: "drama_order",
          id: order.id,
          no: order.orderNo,
          label: `《${lines[0]?.label ?? order.orderNo}》等 ${r.lineCount} 部`,
        }
      : ad
        ? { type: "ad", id: ad.id, no: ad.adNo, label: adLabel(ad.type, ad.durationSec) }
        : {
            type: "store",
            id: store.id,
            no: store.name ?? store.id,
            label: store.name ?? "整店取消",
          },
    reasonCode: r.reasonCode,
    lineCount: r.lineCount,
    totalBasePoints: r.totalBasePoints,
    totalDeductPoints: r.totalDeductPoints,
    totalRefundPoints: r.totalRefundPoints,
    isFullReturn: r.totalDeductPoints === 0,
    status: r.status,
    closeReason: r.closeReason,
    approvalStatus: a.status,
    submittedAt: iso(a.submittedAt),
    requester: brief(a.requesterStaffId),
    isSystemSubmitted: a.submitActorType === "system",
    approvalDueAt: iso(a.dueAt),
    decidedAt: iso(a.decidedAt),
    execDueAt: iso(r.execDueAt),
    executedAt: iso(r.executedAt),
    isOverdue,
    note: r.note ?? "",
    lines,
    destination: {
      qty: summary("qty"),
      backToOriginal: summary("backToOriginal"),
      convertedToAddon: summary("convertedToAddon"),
      forfeited: summary("forfeited"),
      lots: lines.flatMap((l) => l.preview.lots),
    },
    resultTotals: done
      ? {
          returnedPoints: lines.reduce((n, l) => n + (l.result?.returnedPoints ?? 0), 0),
          convertedPoints: lines.reduce((n, l) => n + (l.result?.convertedPoints ?? 0), 0),
          forfeitedPoints: lines.reduce((n, l) => n + (l.result?.forfeitedPoints ?? 0), 0),
        }
      : null,
    approval,
    confirmChecks: a.confirmChecks,
    execution: done
      ? {
          executedBy: brief(r.executedByStaffId),
          isExecutedBySystem: r.isExecutedBySystem,
          executedAt: iso(r.executedAt),
          execConfirmChecks: r.execConfirmChecks,
        }
      : null,
    closeNote: r.closeNote,
    recheckLog: {
      approve:
        r.recheckLog && typeof r.recheckLog === "object" && "approve" in r.recheckLog
          ? r.recheckLog.approve
          : null,
      execute:
        r.recheckLog && typeof r.recheckLog === "object" && "execute" in r.recheckLog
          ? r.recheckLog.execute
          : null,
    },
    order: order
      ? {
          orderId: order.id,
          orderNo: order.orderNo,
          status: order.status,
          subStatus: order.subStatus,
          planName: order.subscriptionTerm.plan.name,
          discountBp: order.discountBp,
        }
      : null,
    ad: ad
      ? {
          adId: ad.id,
          adNo: ad.adNo,
          type: ad.type,
          durationSec: ad.durationSec,
          status: ad.status,
          planName: adPlan!.name,
          discountBp: adPricing!.discountBp,
        }
      : null,
    serviceTickets:
      (await deps.readApprovalRefs?.(tx, {
        approvalRequestId: a.id,
        entityId: r.entityId,
        storeId: r.storeId,
      })) ?? [],
    timeline: [
      {
        at: iso(a.submittedAt),
        action: "submitted",
        actorName:
          a.submitActorType === "system" ? "系统" : (brief(a.requesterStaffId)?.name ?? null),
        note: r.note,
      },
      ...(a.decidedAt
        ? [
            {
              at: iso(a.decidedAt),
              action: a.status,
              actorName: a.isDecidedBySystem ? "系统" : (brief(a.decidedByStaffId)?.name ?? null),
              note: a.decisionNote,
            },
          ]
        : []),
      ...(r.closeReason === "voided"
        ? [
            {
              at: iso(r.closedAt),
              action: "voided",
              actorName: brief(a.requesterStaffId)?.name ?? null,
              note: r.closeNote,
            },
          ]
        : []),
      ...(done
        ? [
            {
              at: iso(r.executedAt),
              action: "executed",
              actorName: r.isExecutedBySystem ? "系统" : (brief(r.executedByStaffId)?.name ?? null),
              note: null,
            },
          ]
        : []),
    ],
    lockVersion: r.lockVersion,
    actions,
  });
}
