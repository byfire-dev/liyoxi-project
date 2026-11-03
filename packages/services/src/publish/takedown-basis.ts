import { addDays, atMinuteOfDay } from "@liyoxi/shared/time";
import { createIdentityContext } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { createTimers, timerKey } from "../timers/index.js";
import type { PublishDeps } from "./context.js";
import { withTakedownWrite } from "./takedown-machine.js";
/** Called after the launch writer updates is_live, under delivery's complete prelocked graph. */
export async function syncTakedownBasis(
  tx: Tx,
  deps: PublishDeps,
  ctx: IdentityContext,
  launchTaskId: string,
) {
  const launch = await tx.launchTask.findUniqueOrThrow({ where: { id: launchTaskId } });
  const rows = await tx.takedownTask.findMany({
    where: { launchTaskId, status: { in: ["pending_merchant", "merchant_confirmed"] } },
    orderBy: { id: "asc" },
  });
  const basis = launch.isLive ? "live" : "delivered_unverified",
    now = deps.clock.now(),
    timers = createTimers({ assembly: deps.assembly });
  for (const row of rows) {
    if (
      row.status === "merchant_confirmed" &&
      row.merchantMethod === "not_published" &&
      launch.isLive
    ) {
      const due = row.dueDate.toISOString().slice(0, 10),
        fireAt = atMinuteOfDay(addDays(due, 1), 540);
      const system = createIdentityContext({
        actor: { type: "system", job: "publish.takedown_basis" },
        requestId: ctx.requestId,
      });
      await withTakedownWrite(tx, row.id, "takedown.basis_reopen", () =>
        deps.flow.transition(tx, system, {
          machine: "takedown_task",
          stateField: "status",
          id: row.id,
          event: "takedown.basis_reopen",
          ref: "11:658",
          entityId: row.entityId,
          storeId: row.storeId,
          set: {
            basis,
            merchant_method: null,
            merchant_confirmed_at: null,
            merchant_confirmed_by_user_id: null,
            check_due_at: null,
            sla_snapshot: null,
            ...(fireAt <= now ? { escalated_at: now } : {}),
          },
          emit: {
            type: "takedown.basis_reopened",
            payload: { v: 1, takedownTaskId: row.id, orderItemId: row.orderItemId },
          },
        }),
      );
      await timers.cancel(tx, {
        subject: { type: "takedown_task", id: row.id },
        kinds: ["takedown.overdue"],
      });
      if (fireAt > now)
        await timers.arm(tx, {
          kind: "takedown.overdue",
          subject: { type: "takedown_task", id: row.id },
          key: timerKey("takedown.overdue", { type: "takedown_task", id: row.id }, due),
          fireAt,
          entityId: row.entityId,
          storeId: row.storeId,
          payload: { dueDate: due },
        });
    } else if (row.basis !== basis)
      await tx.takedownTask.update({ where: { id: row.id }, data: { basis, updatedAt: now } });
  }
}
