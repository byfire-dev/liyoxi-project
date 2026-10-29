import { getLaunchFacts } from "../publish/index.js";
import { createIdentityContext, lockRows } from "../kernel/index.js";
import type { InvariantViolation, Tx } from "../kernel/index.js";
import { boundDelivery } from "./binding.js";
import { PlanContentSchema } from "@liyoxi/contract";
import { planApplied, reevaluate } from "./reevaluate.js";
import { lockTickets, ticketInclude } from "./repo.js";
import { productionViolations } from "./production-invariants.js";
import { pauseSourceValid, releasePause } from "./pause.js";
import { workHoursAt } from "../sla/index.js";
import { prepareReevaluation } from "./reevaluate-locks.js";
export const DELIVERY_INVARIANT_CODES = [
  "I1",
  "I2",
  "I3",
  "I4",
  "I5",
  "I6",
  "I7",
  "I8",
  "I9",
  "I10",
  "I11",
  "I12",
  "I13",
  "I14",
  "I15",
] as const;
export async function findDeliveryViolations(tx: Tx, code: string): Promise<InvariantViolation[]> {
  const result: InvariantViolation[] = [],
    bad = (type: string, id: string, entityId: string, detail: Record<string, unknown>) =>
      result.push({ subject: { type, id }, entityId, detail });
  if (code === "I2") {
    const rows = await tx.deliveryTicket.findMany({
      include: ticketInclude,
      orderBy: { id: "asc" },
    });
    // Every healing candidate is prelocked once, before any child/plan/file effect.
    await prepareReevaluation(
      tx,
      rows.map((t) => t.id),
    );
    for (const t of rows) {
      const active = t.deliveryTicketPauses,
        stale = [] as string[];
      for (const cause of active) if (!(await pauseSourceValid(tx, cause))) stale.push(cause.id);
      const summaryMismatch =
        t.pauseCount !== active.length ||
        active.length > 0 !== (t.pausedAt !== null) ||
        (active.length === 0 && t.pauseRemainingMin !== null);
      if (!summaryMismatch && !stale.length) continue;
      const deps = boundDelivery(),
        ctx = createIdentityContext({ actor: { type: "system", job: "delivery.pause_self_heal" } });
      const stage = t.deliveryTicketStages.find((s) => s.completedAt === null),
        now = deps.clock.now();
      let remaining = t.pauseRemainingMin;
      const pausedAt = active.length
        ? (t.pausedAt ?? active.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b)).createdAt)
        : null;
      if (active.length && remaining === null && stage?.dueAt && pausedAt)
        remaining =
          stage.dueAt <= pausedAt
            ? 0
            : await deps.sla.workMinutesBetween(tx, {
                from: pausedAt,
                to: stage.dueAt,
                workHours: await workHoursAt(tx, pausedAt),
              });
      if (summaryMismatch)
        await tx.deliveryTicket.update({
          where: { id: t.id },
          data: {
            pauseCount: active.length,
            pausedAt,
            pauseRemainingMin: active.length ? remaining : null,
            updatedAt: now,
          },
        });
      for (const id of stale) await releasePause(tx, deps, ctx, id, "self_heal");
      const fresh = await tx.deliveryTicket.findUniqueOrThrow({ where: { id: t.id } });
      if (!fresh.pauseCount) await reevaluate(tx, deps, ctx, t.id);
      result.push({
        subject: { type: "delivery_ticket", id: t.id },
        entityId: t.entityId,
        detail: {
          storedPauseCount: t.pauseCount,
          actualPauseCount: active.length,
          stalePauseIds: stale,
          summaryMismatch,
        },
        healed: { action: "pause_self_heal", at: now },
      });
    }
  }
  if (code === "I14")
    for (const r of await tx.deliveryReissue.findMany({
      include: { deliveryTicket: { include: { orderItem: true } }, publishedDeliveryRelease: true },
    })) {
      const invalidEpisodes =
        !r.episodeNos.length ||
        new Set(r.episodeNos).size !== r.episodeNos.length ||
        r.episodeNos.some((n) => n < 1 || n > r.deliveryTicket.orderItem.episodeCount);
      const release = r.publishedDeliveryRelease;
      const invalidPublished =
        r.status === "published" &&
        (!release ||
          release.deliveryTicketId !== r.deliveryTicketId ||
          release.orderItemId !== r.deliveryTicket.orderItemId ||
          [...release.changedEpisodeNos].sort((a, b) => a - b).join() !==
            [...r.episodeNos].sort((a, b) => a - b).join());
      if (invalidEpisodes || invalidPublished)
        bad("delivery_reissue", r.id, r.entityId, { invalidEpisodes, invalidPublished });
    }
  if (["I1", "I3", "I5"].includes(code)) {
    const rows = await tx.deliveryTicket.findMany({
      include: ticketInclude,
      orderBy: { id: "asc" },
    });
    if (code === "I3") {
      await prepareReevaluation(
        tx,
        rows.map((t) => t.id),
      );
      // full 检查是一个事务：先持有全部低级父锁，避免第二张工单在方案锁之后首次加父锁。
      await lockTickets(
        tx,
        rows.map((r) => r.id),
      );
      await lockRows(
        tx,
        "delivery_plan",
        rows.flatMap((r) => (r.dramaOrder.deliveryPlan ? [r.dramaOrder.deliveryPlan.id] : [])),
      );
    }
    if (code === "I3") {
      // 自动推进多工单可能预填封面；同事务统一先持全部封面锁，不能逐项回退文件 id。
      const posters = rows.flatMap((r) => {
        const shot = r.orderItem.dramaSnapshot as { posterFileId?: string };
        return shot.posterFileId ? [shot.posterFileId] : [];
      });
      const dramas = await tx.drama.findMany({ where: { id: { in: rows.map((r) => r.dramaId) } } });
      await lockRows(tx, "file_object", [
        ...posters,
        ...dramas.flatMap((d) => (d.posterFileId ? [d.posterFileId] : [])),
      ]);
    }
    for (const r of rows) {
      if (code === "I1") {
        const advanced = [
          "sample_making",
          "sample_confirm",
          "batch_compose",
          "delivering",
          "awaiting_launch",
          "launch_verify",
          "in_service",
          "takedown",
          "archived",
        ].includes(r.step);
        if (advanced && !r.dramaOrder.deliveryPlan?.confirmedVersionNo)
          bad("delivery_ticket", r.id, r.entityId, { missingConfirmedPlan: true });
        if (
          [
            "batch_compose",
            "delivering",
            "awaiting_launch",
            "launch_verify",
            "in_service",
            "takedown",
            "archived",
          ].includes(r.step) &&
          !(await tx.sample.count({ where: { deliveryTicketId: r.id, status: "confirmed" } }))
        )
          bad("delivery_ticket", r.id, r.entityId, { missingConfirmedSample: true });
        if (
          [
            "delivering",
            "awaiting_launch",
            "launch_verify",
            "in_service",
            "takedown",
            "archived",
          ].includes(r.step) &&
          (r.episodeOutputs.length !== r.orderItem.episodeCount ||
            r.episodeOutputs.some((e) => e.status !== "qc_passed"))
        )
          bad("delivery_ticket", r.id, r.entityId, { invalidCurrentEpisodes: true });
      }
      if (code === "I5") {
        const open = r.deliveryTicketStages.filter((s) => s.completedAt === null),
          closed = ["archived", "terminated"].includes(r.step);
        const initial = await tx.statusTransition.findFirst({
          where: {
            machine: "delivery_ticket",
            subjectId: r.id,
            stateField: "step",
            fromState: null,
          },
          orderBy: { occurredAt: "asc" },
        });
        if (closed ? open.length > 0 : open.length !== 1 || open[0]?.step !== r.step)
          bad("delivery_ticket", r.id, r.entityId, { step: r.step, openCount: open.length });
        if (
          initial?.event === "ticket.created" &&
          initial.toState === "plan_confirm" &&
          !r.deliveryTicketStages.some(
            (s) =>
              s.step === "assigning" &&
              s.exitEvent === "ticket.created" &&
              s.completedAt?.getTime() === s.enteredAt.getTime(),
          )
        )
          bad("delivery_ticket", r.id, r.entityId, { missingInitialAssigning: true });
      }
      if (code === "I3" && !r.pauseCount) {
        const p = r.dramaOrder.deliveryPlan,
          v = p?.deliveryPlanVersions.find((v) => v.versionNo === p.confirmedVersionNo);
        const facts = ["awaiting_launch", "launch_verify"].includes(r.step)
          ? await getLaunchFacts(tx, r.orderItemId)
          : null;
        const composed =
          r.episodeOutputs.length === r.orderItem.episodeCount &&
          new Set(r.episodeOutputs.map((e) => e.episodeNo)).size === r.orderItem.episodeCount &&
          r.episodeOutputs.every(
            (e) =>
              e.episodeNo >= 1 &&
              e.episodeNo <= r.orderItem.episodeCount &&
              e.status === "qc_passed",
          ) &&
          r.qcRecords.find((q) => q.targetType === "delivery_ticket")?.verdict === "pass";
        const ready =
          (r.step === "plan_confirm" &&
            !!v &&
            v.decision === "confirmed" &&
            (await planApplied(tx, r.dramaOrderId, v.contentSnapshot))) ||
          r.step === "ad_prep" ||
          (r.step === "batch_compose" && composed) ||
          (!!facts &&
            (facts.hasLive ||
              (r.step === "awaiting_launch" && facts.hasVerifying) ||
              (r.step === "launch_verify" && !facts.hasVerifying)));
        if (ready) {
          const deps = boundDelivery(),
            { moved } = await reevaluate(
              tx,
              deps,
              createIdentityContext({ actor: { type: "system", job: "invariants.full" } }),
              r.id,
            );
          if (moved)
            result.push({
              subject: { type: "delivery_ticket", id: r.id },
              entityId: r.entityId,
              detail: { stepBefore: r.step, moved },
              healed: { action: "reevaluate", at: deps.clock.now() },
            });
        }
      }
    }
  }
  if (code === "I4") {
    for (const t of await tx.deliveryTicket.findMany({ include: { orderItem: true } }))
      if (
        t.entityId !== t.orderItem.entityId ||
        t.storeId !== t.orderItem.storeId ||
        t.dramaOrderId !== t.orderItem.dramaOrderId ||
        t.dramaId !== t.orderItem.dramaId
      )
        bad("delivery_ticket", t.id, t.entityId, { parentMismatch: true });
    for (const p of await tx.deliveryPlan.findMany({
      include: { dramaOrder: true, deliveryPlanVersions: true, deliveryPlanChangeRequests: true },
    })) {
      if (p.entityId !== p.dramaOrder.entityId || p.storeId !== p.dramaOrder.storeId)
        bad("delivery_plan", p.id, p.entityId, { parentMismatch: true });
      for (const child of [...p.deliveryPlanVersions, ...p.deliveryPlanChangeRequests])
        if (child.entityId !== p.entityId || child.storeId !== p.storeId)
          bad("delivery_plan", p.id, p.entityId, { childId: child.id, parentMismatch: true });
    }
  }
  if (code === "I6")
    for (const p of await tx.deliveryPlan.findMany({
      include: { deliveryPlanVersions: true, deliveryPlanChangeRequests: true },
    })) {
      const undecided = p.deliveryPlanVersions.filter((v) => v.decision === null),
        max = Math.max(0, ...p.deliveryPlanVersions.map((v) => v.versionNo));
      if (
        p.currentVersionNo !== max ||
        undecided.length > 1 ||
        undecided.some((v) => v.versionNo !== p.currentVersionNo) ||
        (p.status === "revising" &&
          !p.deliveryPlanChangeRequests.some((r) => r.resolvedByVersionNo === null))
      )
        bad("delivery_plan", p.id, p.entityId, {
          currentVersionNo: p.currentVersionNo,
          max,
          undecidedCount: undecided.length,
        });
      // 快照解析同时验证已存内容，检查项不能把坏 JSON 当成正常方案。
      for (const v of p.deliveryPlanVersions)
        if (!PlanContentSchema.safeParse(v.contentSnapshot).success)
          bad("delivery_plan_version", v.id, v.entityId, { invalidSnapshot: true });
    }
  return [...result, ...(await productionViolations(tx, code))];
}
