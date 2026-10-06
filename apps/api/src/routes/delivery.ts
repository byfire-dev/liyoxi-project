import {
  adminDeliveryTicketList,
  adminDeliveryTicketSummary,
  adminDeliveryTicketGet,
  adminDeliveryTicketAssignManager,
  adminDeliveryPlanGet,
  adminDeliveryPlanDraftReplace,
  adminDeliveryPlanPush,
  mDeliveryPlanGet,
  mDeliveryPlanConfirm,
  mDeliveryPlanRequestChange,
  DeliveryTicketPageSchema,
  DeliveryTicketSummarySchema,
  DeliveryTicketDetailSchema,
  DeliveryTicketWriteResultSchema,
  AdminDeliveryPlanDetailSchema,
  AdminDeliveryPlanWriteResultSchema,
  DeliveryPlanDetailSchema,
  DeliveryPlanWriteResultSchema,
} from "@liyoxi/contract";
import { AppError, createDelivery, createSla } from "@liyoxi/services";
import type { Delivery, DeliveryViewer, Runtime } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";
import { defineAdminHandler } from "../routing/admin.js";
const built = new WeakMap<Runtime, Delivery>();
export function deliveryOf(runtime: Runtime) {
  let service = built.get(runtime);
  if (!service) {
    const { tx, clock, assembly, flow, events, media } = runtime;
    service = createDelivery({
      tx,
      clock,
      assembly,
      flow,
      events,
      media,
      sla: createSla({ clock, assembly }),
      profile: merchantServicesOf(runtime).profile,
    });
    built.set(runtime, service);
  }
  return service;
}
const viewer = (c: Context<ApiEnv>): DeliveryViewer => {
  if (!c.var.identity || !c.var.membership) throw new AppError("NOT_A_MEMBER");
  return { ctx: c.var.identity, membership: c.var.membership };
};
const read = { module: "delivery", need: "view" } as const;
const edit = { module: "delivery", need: "edit" } as const;
export const deliveryHandlers = [
  defineAdminHandler(adminDeliveryTicketList, read, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      DeliveryTicketPageSchema.parse(
        await deliveryOf(c.var.runtime).list(s.ctx, c.req.valid("query")),
      ),
    );
  }),
  defineAdminHandler(adminDeliveryTicketSummary, read, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      DeliveryTicketSummarySchema.parse(
        await deliveryOf(c.var.runtime).summary(s.ctx, c.req.valid("query")),
      ),
    );
  }),
  defineAdminHandler(adminDeliveryTicketGet, read, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      DeliveryTicketDetailSchema.parse(
        await deliveryOf(c.var.runtime).get(s.ctx, c.req.valid("param").deliveryTicketId),
      ),
    );
  }),
  defineAdminHandler(adminDeliveryTicketAssignManager, read, async (c, s) =>
    ok(
      c,
      DeliveryTicketWriteResultSchema.parse(
        await deliveryOf(c.var.runtime).assign(
          c.var.identity!,
          s.ctx,
          c.req.valid("param").deliveryTicketId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminDeliveryPlanGet, read, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      AdminDeliveryPlanDetailSchema.parse(
        await deliveryOf(c.var.runtime).adminPlan(s.ctx, c.req.valid("param").deliveryPlanId),
      ),
    );
  }),
  defineAdminHandler(adminDeliveryPlanDraftReplace, edit, async (c, s) =>
    ok(
      c,
      AdminDeliveryPlanWriteResultSchema.parse(
        await deliveryOf(c.var.runtime).replaceDraft(
          c.var.identity!,
          s.ctx,
          c.req.valid("param").deliveryPlanId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminDeliveryPlanPush, edit, async (c, s) =>
    ok(
      c,
      AdminDeliveryPlanWriteResultSchema.parse(
        await deliveryOf(c.var.runtime).push(
          c.var.identity!,
          s.ctx,
          c.req.valid("param").deliveryPlanId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineHandler(mDeliveryPlanGet, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      DeliveryPlanDetailSchema.parse(
        await deliveryOf(c.var.runtime).merchantPlan(
          viewer(c),
          c.req.valid("param").deliveryPlanId,
        ),
      ),
    );
  }),
  defineHandler(mDeliveryPlanConfirm, async (c) =>
    ok(
      c,
      DeliveryPlanWriteResultSchema.parse(
        await deliveryOf(c.var.runtime).confirm(
          viewer(c),
          c.req.valid("param").deliveryPlanId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineHandler(mDeliveryPlanRequestChange, async (c) =>
    ok(
      c,
      DeliveryPlanWriteResultSchema.parse(
        await deliveryOf(c.var.runtime).requestChange(
          viewer(c),
          c.req.valid("param").deliveryPlanId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
];
