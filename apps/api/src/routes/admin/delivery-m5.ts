import {
  adminDeliveryTicketActivityList,
  adminDeliveryTicketAssignEditor,
  adminDeliveryTicketAssignPublisher,
  adminDeliveryTicketForceTransition,
  adminDeliveryTicketReevaluate,
  adminDeliveryTicketReissueCreate,
  adminDeliveryTicketRemind,
  adminDeliveryTicketRework,
  adminOrderItemRescheduleLaunch,
  adminReissueCancel,
  adminReissuePublish,
  TicketActivityPageSchema,
  DeliveryTicketWriteResultSchema,
  ReevaluateResultSchema,
  ReissueWriteResultSchema,
  ReissuePublishResultSchema,
  AdminRemindResultSchema,
  AdminOrderItemWriteResultSchema,
} from "@liyoxi/contract";
import { createDeliveryM5, createSla } from "@liyoxi/services";
import type { Runtime } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../../context.js";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { merchantServicesOf } from "../../merchant/services.js";
import { defineAdminHandler } from "../../routing/admin.js";
import { publishOf } from "../publish.js";

const built = new WeakMap<Runtime, ReturnType<typeof createDeliveryM5>>();
export function deliveryM5Of(runtime: Runtime) {
  let service = built.get(runtime);
  if (!service) {
    const { tx, clock, assembly, flow, events, media } = runtime;
    service = createDeliveryM5({
      tx,
      clock,
      assembly,
      flow,
      events,
      media,
      approval: runtime.approval,
      sla: createSla({ clock, assembly }),
      profile: merchantServicesOf(runtime).profile,
      publish: publishOf(runtime),
      samplePlayback: (entityId) =>
        runtime.config.flags.isEnabled("weapp.video.sample.enabled", { entityId }),
    });
    built.set(runtime, service);
  }
  return service;
}

const read = { module: "delivery", need: "view" } as const;
const edit = { module: "delivery", need: "edit" } as const;
const privateOk = <T>(c: Context<ApiEnv>, data: T) => {
  c.header("Cache-Control", "no-store");
  return ok(c, data);
};

export const adminDeliveryM5Handlers = [
  defineAdminHandler(adminDeliveryTicketActivityList, read, async (c, staff) =>
    privateOk(
      c,
      TicketActivityPageSchema.parse(
        await deliveryM5Of(c.var.runtime).activityList(
          staff.ctx,
          c.req.valid("param").deliveryTicketId,
          c.req.valid("query"),
        ),
      ),
    ),
  ),
  defineAdminHandler(adminDeliveryTicketAssignEditor, edit, async (c, staff) =>
    privateOk(
      c,
      DeliveryTicketWriteResultSchema.parse(
        await deliveryM5Of(c.var.runtime).assignEditor(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").deliveryTicketId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminDeliveryTicketAssignPublisher, read, async (c, staff) =>
    privateOk(
      c,
      DeliveryTicketWriteResultSchema.parse(
        await deliveryM5Of(c.var.runtime).assignPublisher(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").deliveryTicketId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminDeliveryTicketForceTransition, null, async (c, staff) =>
    privateOk(
      c,
      DeliveryTicketWriteResultSchema.parse(
        await deliveryM5Of(c.var.runtime).forceTransition(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").deliveryTicketId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminDeliveryTicketReevaluate, null, async (c, staff) =>
    privateOk(
      c,
      ReevaluateResultSchema.parse(
        await deliveryM5Of(c.var.runtime).reevaluate(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").deliveryTicketId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminDeliveryTicketReissueCreate, edit, async (c, staff) =>
    privateOk(
      c,
      ReissueWriteResultSchema.parse(
        await deliveryM5Of(c.var.runtime).reissueCreate(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").deliveryTicketId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  // 场景、本人负责人或主管的判定需要工单事实，由持范围的用例完成。
  defineAdminHandler(adminDeliveryTicketRemind, read, async (c, staff) =>
    privateOk(
      c,
      AdminRemindResultSchema.parse(
        await deliveryM5Of(c.var.runtime).remind(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").deliveryTicketId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminDeliveryTicketRework, edit, async (c, staff) =>
    privateOk(
      c,
      DeliveryTicketWriteResultSchema.parse(
        await deliveryM5Of(c.var.runtime).rework(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").deliveryTicketId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminOrderItemRescheduleLaunch, edit, async (c, staff) =>
    privateOk(
      c,
      AdminOrderItemWriteResultSchema.parse(
        await deliveryM5Of(c.var.runtime).rescheduleLaunch(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").orderItemId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminReissueCancel, edit, async (c, staff) =>
    privateOk(
      c,
      ReissueWriteResultSchema.parse(
        await deliveryM5Of(c.var.runtime).reissueCancel(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").reissueId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminReissuePublish, { module: "publish", need: "edit" }, async (c, staff) =>
    privateOk(
      c,
      ReissuePublishResultSchema.parse(
        await deliveryM5Of(c.var.runtime).reissuePublish(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").reissueId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
];
