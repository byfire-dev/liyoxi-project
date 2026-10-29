import { calendarDate } from "@liyoxi/shared/time";
import {
  getLaunchFacts,
  readDeliveryPublishTargets,
  closeExpiredDeliveryPublish,
} from "../publish/index.js";
import { AppError, createIdentityContext, invariantsOf, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { DeliveryCoreDeps } from "./context.js";
import { checked } from "./machines.js";
import { prefillPublishList } from "./publish-list.js";
import { orderSidePort } from "./ports.js";
import { dateOf, lockTickets, ticketOf } from "./repo.js";
import type { TicketRow } from "./repo.js";
import { prepareReevaluation } from "./reevaluate-locks.js";
import { closeSystemFollowUps } from "../staff/index.js";
export { adsReady, planApplied } from "./reevaluate-facts.js";
import { adsReady, planApplied } from "./reevaluate-facts.js";
/** W5-06 owns actual letter readiness; this legacy no-letter M1 path stays explicit. */
export function licenseReady(_ticket: TicketRow) {
  return true;
}
export async function step(
  tx: Tx,
  deps: DeliveryCoreDeps,
  ctx: IdentityContext,
  t: TicketRow,
  event: string,
  to: string,
  ref: string,
  milestone: Record<string, unknown> = {},
) {
  const now = deps.clock.now();
  await deps.flow.transition(tx, ctx, {
    machine: "delivery_ticket",
    stateField: "step",
    id: t.id,
    event,
    to,
    ref,
    args: checked(),
    entityId: t.entityId,
    storeId: t.storeId,
    set: {
      step_entered_at: now,
      step_due_at: null,
      waiting_on: ["in_service", "archived", "terminated"].includes(to) ? "none" : "staff",
      ...milestone,
    },
    emit: {
      type: "ticket.step_changed",
      payload: {
        v: 1,
        deliveryTicketId: t.id,
        dramaOrderId: t.dramaOrderId,
        orderItemId: t.orderItemId,
        isForced: false,
      },
    },
  });
}
export async function reevaluate(
  tx: Tx,
  deps: DeliveryCoreDeps,
  ctx: IdentityContext,
  ticketId: string,
) {
  const first = await ticketOf(tx, ticketId);
  if (["awaiting_launch", "launch_verify", "in_service", "takedown"].includes(first.step))
    await prepareReevaluation(tx, [ticketId]);
  else
    await lockRows(
      tx,
      "ad",
      first.orderItem.orderItemPlacements.map((p) => p.adId),
      "share",
    );
  await lockTickets(tx, [ticketId]);
  let moved = 0;
  let launchFacts: Awaited<ReturnType<typeof getLaunchFacts>> | undefined;
  // 每个规则最多一次；允许方案确认后同一次求值再进样片制作。
  for (let attempt = 0; attempt < 4; attempt++) {
    const t = await ticketOf(tx, ticketId);
    if (t.pauseCount > 0) break;
    if (["awaiting_launch", "launch_verify", "in_service"].includes(t.step)) {
      const targets = await readDeliveryPublishTargets(tx, [t.orderItemId]);
      const expired = calendarDate(deps.clock.now()) > dateOf(t.orderItem.usageEndDate)!;
      const confirmed =
        targets.takedowns.length > 0 &&
        targets.takedowns.every((r) => r.merchantConfirmedAt !== null);
      if (expired || (t.step === "in_service" && confirmed)) {
        if (!deps.approval)
          throw new AppError("INTERNAL", { message: "交付到期求值缺少真实审批收尾依赖" });
        await closeExpiredDeliveryPublish(tx, { ...deps, approval: deps.approval }, ctx, targets, {
          deliveryTicketId: t.id,
          now: deps.clock.now(),
        });
        if (t.step !== "in_service")
          await tx.downloadGrant.updateMany({
            where: { orderItemId: t.orderItemId, state: "active" },
            data: { state: "revoked", endedAt: deps.clock.now(), updatedAt: deps.clock.now() },
          });
        const reissues = await tx.deliveryReissue.findMany({
          where: { deliveryTicketId: t.id },
          select: { id: true },
        });
        await closeSystemFollowUps(tx, ctx, {
          subjects: reissues.map((r) => ({
            subjectType: "delivery_reissue" as const,
            subjectId: r.id,
          })),
          now: deps.clock.now(),
        });
        await step(
          tx,
          deps,
          ctx,
          t,
          "usage.ended",
          "takedown",
          t.step === "in_service" ? "10:186" : "10:187",
          { usage_ended_at: deps.clock.now() },
        );
        moved++;
        continue;
      }
    }
    if (t.step === "takedown") {
      const targets = await readDeliveryPublishTargets(tx, [t.orderItemId]);
      if (targets.takedowns.length > 0 && targets.takedowns.every((r) => r.status === "checked")) {
        await step(tx, deps, ctx, t, "takedown.all_checked", "archived", "10:188", {
          archived_at: deps.clock.now(),
        });
        moved++;
        continue;
      }
    }
    if (["sample_making", "sample_confirm"].includes(t.step) && !adsReady(t)) {
      const samples = await tx.sample.findMany({
        where: { deliveryTicketId: t.id, status: { in: ["uploaded", "qc_passed", "pushed"] } },
      });
      await lockRows(
        tx,
        "sample",
        samples.map((s) => s.id),
      );
      for (const s of samples)
        await deps.flow.transition(tx, ctx, {
          machine: "sample",
          stateField: "status",
          id: s.id,
          event: "sample.superseded",
          args: checked(),
          entityId: t.entityId,
          storeId: t.storeId,
          emit: {
            type: "sample.superseded",
            payload: {
              v: 1,
              sampleId: s.id,
              deliveryTicketId: t.id,
              dramaOrderId: t.dramaOrderId,
              versionNo: s.versionNo,
            },
          },
        });
      await step(tx, deps, ctx, t, "ad.reopened", "ad_prep", "10:179");
      moved++;
      continue;
    }
    if (t.step === "plan_confirm") {
      const p = t.dramaOrder.deliveryPlan;
      if (!p || !p.confirmedVersionNo) break;
      await lockRows(tx, "delivery_plan", [p.id]);
      const fresh = await tx.deliveryPlan.findUniqueOrThrow({
        where: { id: p.id },
        include: { deliveryPlanVersions: true },
      });
      const v = fresh.deliveryPlanVersions.find((r) => r.versionNo === fresh.confirmedVersionNo);
      if (
        !v ||
        v.decision !== "confirmed" ||
        !(await planApplied(tx, t.dramaOrderId, v.contentSnapshot))
      )
        break;
      await step(tx, deps, ctx, t, "plan.confirmed", "ad_prep", "10:173", {
        plan_confirmed_at: fresh.confirmedAt,
      });
      moved++;
      continue;
    }
    if (t.step === "ad_prep" && adsReady(t)) {
      await step(tx, deps, ctx, t, "ads.ready", "sample_making", "10:174", {
        ads_ready_at: deps.clock.now(),
      });
      moved++;
      continue;
    }
    if (t.step === "batch_compose") {
      const outputs = t.episodeOutputs;
      const packageQc = t.qcRecords.find((r) => r.targetType === "delivery_ticket");
      if (
        outputs.length === t.orderItem.episodeCount &&
        new Set(outputs.map((r) => r.episodeNo)).size === t.orderItem.episodeCount &&
        outputs.every(
          (r) =>
            r.episodeNo >= 1 && r.episodeNo <= t.orderItem.episodeCount && r.status === "qc_passed",
        ) &&
        packageQc?.verdict === "pass"
      ) {
        await step(tx, deps, ctx, t, "episodes.all_passed", "delivering", "10:180", {
          composed_at: deps.clock.now(),
        });
        await prefillPublishList(tx, deps, await ticketOf(tx, ticketId));
        moved++;
        continue;
      }
    }
    if (["awaiting_launch", "launch_verify", "in_service"].includes(t.step)) {
      const facts = await getLaunchFacts(tx, t.orderItemId);
      launchFacts = facts;
      if (t.step !== "in_service") {
        const to = facts.hasLive
          ? "in_service"
          : facts.hasVerifying
            ? "launch_verify"
            : "awaiting_launch";
        if (to !== t.step) {
          const ref = to === "in_service" ? "10:185" : to === "launch_verify" ? "10:183" : "10:184";
          await step(tx, deps, ctx, t, "launch.changed", to, ref, {
            ...(to === "in_service" ? { live_at: deps.clock.now() } : {}),
            ...(to === "launch_verify" && !t.linksSubmittedAt
              ? { links_submitted_at: deps.clock.now() }
              : {}),
          });
          moved++;
        }
      }
    }
    break;
  }
  // 订单侧按最新步骤推导；稳态上线数量变更仍回调一次，不在迁移前推导旧步骤。
  if (moved || launchFacts) {
    const fresh = await ticketOf(tx, ticketId);
    await deps.assembly
      .port(orderSidePort)
      .rederive(tx, { orderItemIds: [fresh.orderItemId], ...(launchFacts ? { launchFacts } : {}) });
  }
  return { moved };
}
export async function reevaluateSweep(deps: DeliveryCoreDeps) {
  const ids = await deps.tx.run((tx) =>
    tx.deliveryTicket.findMany({
      where: {
        pauseCount: 0,
        step: {
          in: [
            "plan_confirm",
            "ad_prep",
            "sample_making",
            "sample_confirm",
            "batch_compose",
            "awaiting_launch",
            "launch_verify",
            "in_service",
            "takedown",
          ],
        },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    }),
  );
  const ctx = createIdentityContext({ actor: { type: "system", job: "flow_reevaluate_sweep" } });
  let moved = 0;
  for (const { id } of ids) {
    const result = await deps.tx.run(async (tx) => {
      const t = await tx.deliveryTicket.findUnique({ where: { id } });
      if (!t) return null;
      await prepareReevaluation(tx, [id]);
      const result = await reevaluate(tx, deps, ctx, id);
      return result.moved ? { ...result, entityId: t.entityId } : null;
    });
    // 提交成功才独立上报；事务回滚不会把一次尝试误报为已经补偿。
    if (result) {
      moved += result.moved;
      await invariantsOf(deps.assembly).report({
        code: "flow.STUCK_TICKET",
        module: "delivery",
        severity: "P2",
        subject: { type: "delivery_ticket", id },
        entityId: result.entityId,
        detail: { moved: result.moved },
      });
    }
  }
  return { inspected: ids.length, moved };
}
export async function assertPlanApplied(tx: Tx, dramaOrderId: string, content: unknown) {
  if (!(await planApplied(tx, dramaOrderId, content)))
    throw new AppError("INTERNAL", { message: "order 端口未完整应用已确认方案" });
}
