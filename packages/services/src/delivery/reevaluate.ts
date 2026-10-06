import { PlanContentSchema } from "@liyoxi/contract";
import { getLaunchFacts } from "../publish/index.js";
import { AppError, createIdentityContext, invariantsOf, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { DeliveryCoreDeps } from "./context.js";
import { checked } from "./machines.js";
import { prefillPublishList } from "./publish-list.js";
import { orderSidePort } from "./ports.js";
import { dateOf, lockTickets, ticketOf } from "./repo.js";
import type { TicketRow } from "./repo.js";
/** M5 广告与授权书包接管；M1 的主链没有广告位，本桩不改变任何广告行。 */
export function adsReady(_ticket: TicketRow) {
  return true;
}
export function licenseReady(_ticket: TicketRow) {
  return true;
}
export async function planApplied(tx: Tx, dramaOrderId: string, snapshot: unknown) {
  const content = PlanContentSchema.parse(snapshot);
  const rows = await tx.orderItem.findMany({
    where: { dramaOrderId },
    include: { orderItemAccounts: true, orderItemPlacements: true },
  });
  for (const item of content.items) {
    const row = rows.find((r) => r.id === item.orderItemId);
    if (!row || !item.agreedLaunchDate || dateOf(row.agreedLaunchDate) !== item.agreedLaunchDate)
      return false;
    const accounts = (a: ReadonlyArray<{ channelAccountId: string; platform: string }>) =>
      a
        .map((r) => `${r.platform}:${r.channelAccountId}`)
        .sort()
        .join("|");
    if (accounts(row.orderItemAccounts) !== accounts(item.accounts)) return false;
    const placements = (a: ReadonlyArray<{ slot: string; adId: string; durationSec: number }>) =>
      a
        .map((r) => `${r.slot}:${r.adId}:${r.durationSec}`)
        .sort()
        .join("|");
    if (placements(row.orderItemPlacements) !== placements(item.placements)) return false;
  }
  const references = await tx.storeAssetUsage.findMany({
    where: { usedByType: "drama_order", usedById: dramaOrderId, role: "reference" },
    select: { storeAssetId: true },
  });
  if (content.referenceAssetIds.some((id) => !references.some((r) => r.storeAssetId === id)))
    return false;
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
      waiting_on: to === "in_service" ? "none" : "staff",
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
  await lockTickets(tx, [ticketId]);
  let moved = 0;
  let launchFacts: Awaited<ReturnType<typeof getLaunchFacts>> | undefined;
  // 每个规则最多一次；允许方案确认后同一次求值再进样片制作。
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = await ticketOf(tx, ticketId);
    if (t.pauseCount > 0) break;
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
          in: ["plan_confirm", "ad_prep", "batch_compose", "awaiting_launch", "launch_verify"],
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
