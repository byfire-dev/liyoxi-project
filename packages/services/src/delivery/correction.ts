import { PlanContentSchema } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { AppError } from "../kernel/index.js";
import type { TransitionFacts } from "../flow/index.js";
import type { Tx } from "../kernel/index.js";
import { dateOf, ticketOf } from "./repo.js";
import { boundDelivery } from "./binding.js";
import { readDeliveryPublishTargets, resyncDeliveryPublishExpiry } from "../publish/index.js";
import { adsReady, planApplied } from "./reevaluate-facts.js";

export interface CorrectionArgs {
  readonly confirm: { readonly ticketNo: string; readonly fromStep: string };
  readonly newUsageEndDate?: string;
}
export async function correctionGuard(tx: Tx, f: TransitionFacts) {
  const t = await ticketOf(tx, f.subjectId),
    args = f.args as CorrectionArgs | undefined;
  if (t.pauseCount)
    throw new AppError("TICKET_ON_HOLD", {
      details: { reasons: t.deliveryTicketPauses.map((p) => p.reason) },
    });
  if (args?.confirm?.ticketNo !== t.ticketNo || args.confirm.fromStep !== t.step)
    throw new AppError("CONFIRM_MISMATCH");
  if (f.from === "takedown" && f.to === "in_service") {
    const rights = await tx.dramaCopyright.findUnique({ where: { dramaId: t.dramaId } });
    const next = args.newUsageEndDate;
    if (
      !next ||
      next <= calendarDate(f.now) ||
      !rights?.licenseEndDate ||
      next > dateOf(rights.licenseEndDate)!
    )
      throw new AppError("VALIDATION_FAILED", {
        message: "新使用止日须晚于今天且不超过当前授权止日",
      });
  }
  return true;
}
export async function correctionEffect(tx: Tx, f: TransitionFacts) {
  if (f.from === "takedown" && f.to === "in_service") {
    const t = await ticketOf(tx, f.subjectId),
      args = f.args as CorrectionArgs;
    await tx.orderItem.update({
      where: { id: t.orderItemId },
      data: {
        usageEndDate: new Date(args.newUsageEndDate!),
        usageEndSource: "license",
        updatedAt: f.now,
      },
    });
    const deps = boundDelivery();
    if (!deps.approval) throw new AppError("INTERNAL", { message: "版权纠偏缺少真实发布收尾依赖" });
    const targets = await readDeliveryPublishTargets(tx, [t.orderItemId]);
    await resyncDeliveryPublishExpiry(tx, { ...deps, approval: deps.approval }, f.ctx, targets, {
      deliveryTicketId: t.id,
      now: f.now,
    });
  }
}
/** Read-only, local checks: forced corrections must never invoke healing or ledger writers. */
export async function checkCorrectionStructure(tx: Tx, f: TransitionFacts) {
  const t = await ticketOf(tx, f.subjectId),
    failures: string[] = [];
  const order = [
    "assigning",
    "plan_confirm",
    "ad_prep",
    "sample_making",
    "sample_confirm",
    "batch_compose",
    "delivering",
    "awaiting_launch",
    "launch_verify",
    "in_service",
    "takedown",
    "archived",
  ];
  const rank = order.indexOf(t.step),
    p = t.dramaOrder.deliveryPlan;
  if (rank >= 3 && !p?.confirmedVersionNo) failures.push("delivery.I1.plan");
  if (
    rank > 4 &&
    !(await tx.sample.count({ where: { deliveryTicketId: t.id, status: "confirmed" } }))
  )
    failures.push("delivery.I1.sample");
  if (
    rank > 6 &&
    (t.episodeOutputs.length !== t.orderItem.episodeCount ||
      t.episodeOutputs.some((e) => e.status !== "qc_passed"))
  )
    failures.push("delivery.I1.episodes");
  const open = t.deliveryTicketStages.filter((s) => !s.completedAt);
  if (open.length !== 1 || open[0]?.step !== t.step) failures.push("delivery.I5");
  if (p) {
    const max = Math.max(0, ...p.deliveryPlanVersions.map((v) => v.versionNo));
    if (
      p.currentVersionNo !== max ||
      p.deliveryPlanVersions.filter((v) => v.decision === null).length > 1 ||
      p.deliveryPlanVersions.some((v) => !PlanContentSchema.safeParse(v.contentSnapshot).success) ||
      (p.status === "revising" &&
        !p.deliveryPlanChangeRequests.some((r) => r.resolvedByVersionNo === null))
    )
      failures.push("delivery.I6");
  }
  const version = p?.deliveryPlanVersions.find((v) => v.versionNo === p.confirmedVersionNo);
  if (
    t.step === "plan_confirm" &&
    version?.decision === "confirmed" &&
    (await planApplied(tx, t.dramaOrderId, version.contentSnapshot))
  )
    failures.push("delivery.I3.plan");
  if (t.step === "ad_prep" && adsReady(t)) failures.push("delivery.I3.ads");
  if (["sample_making", "sample_confirm"].includes(t.step) && !adsReady(t))
    failures.push("delivery.I3.ad_reopened");
  if (
    t.step === "batch_compose" &&
    t.episodeOutputs.length === t.orderItem.episodeCount &&
    t.episodeOutputs.every((e) => e.status === "qc_passed") &&
    t.qcRecords.find((q) => q.targetType === "delivery_ticket")?.verdict === "pass"
  )
    failures.push("delivery.I3.episodes");
  if (t.step === "in_service" && !t.launchTasks.some((l) => l.isLive))
    failures.push("delivery.I3.launch");
  if (
    t.step === "launch_verify" &&
    (t.launchTasks.some((l) => l.isLive) ||
      !t.launchTasks.some((l) => l.reviewStatus === "verifying"))
  )
    failures.push("delivery.I3.verifying");
  return failures;
}
