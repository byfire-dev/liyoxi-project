import type { Sample } from "@liyoxi/db";
import type { AuditRequestMeta } from "../audit/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { DeliveryDeps } from "./context.js";
import { checked } from "./machines.js";
import type { TicketRow } from "./repo.js";

export const sampleAuditMeta = (
  ctx: IdentityContext,
  jobName = "cli.delivery.sample",
): AuditRequestMeta => ({
  requestId: ctx.requestId,
  ip: ctx.ip,
  userAgent: ctx.userAgent,
  authMethod: null,
  sessionId: null,
  ...(ctx.actor.client === "cli" ? { jobName } : {}),
});

export async function moveSample(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  t: TicketRow,
  s: Sample,
  event: string,
  set: Record<string, unknown> = {},
  created = false,
) {
  await deps.flow.transition(tx, ctx, {
    machine: "sample",
    stateField: "status",
    id: s.id,
    event,
    created,
    meta: sampleAuditMeta(ctx),
    args: checked(),
    entityId: t.entityId,
    storeId: t.storeId,
    set,
    payload: { versionNo: s.versionNo },
    emit: {
      type: event,
      payload: {
        v: 1,
        sampleId: s.id,
        deliveryTicketId: t.id,
        dramaOrderId: t.dramaOrderId,
        versionNo: s.versionNo,
        ...(event === "sample.confirmed" ? { viewedVia: set.confirm_viewed_via } : {}),
      },
    },
  });
}
