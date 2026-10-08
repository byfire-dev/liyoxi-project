import {
  adminTimerList,
  adminTimerReschedule,
  adminTimerCancel,
  adminOutboxDeliveryList,
  adminOutboxEventRetry,
  adminWebhookEventList,
  adminWebhookEventRetry,
} from "@liyoxi/contract";
import type { FlowOpsActor } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../../context.js";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
import type { AdminStaff } from "../../routing/admin.js";
function actor(c: Context<ApiEnv>, staff: AdminStaff): FlowOpsActor {
  const identity = c.var.identity;
  if (!identity) throw new Error("流程运维缺少身份上下文");
  return {
    staff: staff.ctx,
    identity,
    meta: {
      requestId: identity.requestId,
      ip: identity.ip,
      userAgent: identity.userAgent,
      sessionId: staff.principal.session.id,
      authMethod:
        staff.principal.session.authMethod === "password+totp"
          ? "password+totp"
          : staff.principal.session.authMethod === "password+recovery"
            ? "password+recovery"
            : null,
    },
  };
}
export const adminFlowOpsHandlers = [
  defineAdminHandler(adminTimerList, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.flowOps.listTimers(staff.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminOutboxDeliveryList, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.flowOps.listDeliveries(staff.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminWebhookEventList, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.flowOps.listWebhooks(staff.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminTimerReschedule, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.flowOps.rescheduleTimer(
        actor(c, staff),
        c.req.valid("param").timerId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminTimerCancel, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.flowOps.cancelTimer(
        actor(c, staff),
        c.req.valid("param").timerId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminOutboxEventRetry, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.flowOps.retryDelivery(
        actor(c, staff),
        c.req.valid("param").outboxEventId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminWebhookEventRetry, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.flowOps.retryWebhook(
        actor(c, staff),
        c.req.valid("param").webhookEventId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
];
