import {
  adminDeliveryTicketPublishListGet,
  adminDeliveryTicketPublishListReplace,
  adminDeliveryTicketPublishListImport,
  mOrderItemPublishListGet,
  portalOrderItemPublishListGet,
  adminLaunchCalendarGet,
  adminLaunchTaskList,
  adminLaunchTaskSummary,
  adminLaunchSubmissionRevoke,
  PublishListAdminViewSchema,
  PublishListSaveResultSchema,
  PublishListImportResultSchema,
  PublishListViewSchema,
  LaunchCalendarSchema,
  LaunchTrackPageSchema,
  LaunchTrackSummarySchema,
  LaunchSubmissionDetailSchema,
} from "@liyoxi/contract";
import {
  AppError,
  createFlow,
  createPublishLists,
  createLaunchRevoke,
  createLaunchWorkbench,
  createSla,
} from "@liyoxi/services";
import type { Runtime, DeliveryViewer } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { portalPrincipalOf } from "../http/portal-auth.js";
import { defineHandler } from "../routing/define.js";
import { defineAdminHandler } from "../routing/admin.js";

const cache = new WeakMap<Runtime, ReturnType<typeof createServices>>();
function createServices(runtime: Runtime) {
  const { tx, clock, media, events, assembly, approval } = runtime;
  return {
    lists: createPublishLists({ tx, clock, media, events }),
    workbench: createLaunchWorkbench({ tx, clock }),
    revoke: createLaunchRevoke({
      tx,
      clock,
      media,
      assembly,
      approval,
      flow: createFlow({ assembly, clock, events }),
      sla: createSla({ assembly, clock }),
    }),
  };
}
export function publishWorkbenchOf(runtime: Runtime) {
  let result = cache.get(runtime);
  if (!result) {
    result = createServices(runtime);
    cache.set(runtime, result);
  }
  return result;
}
function viewer(c: Context<ApiEnv>): DeliveryViewer {
  if (!c.var.identity || !c.var.membership) throw new AppError("NOT_A_MEMBER");
  return { ctx: c.var.identity, membership: c.var.membership };
}
export const publishWorkbenchHandlers = [
  defineAdminHandler(
    adminDeliveryTicketPublishListGet,
    { module: "publish", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        PublishListAdminViewSchema.parse(
          await publishWorkbenchOf(c.var.runtime).lists.get(
            staff.ctx,
            c.req.valid("param").deliveryTicketId,
          ),
        ),
      );
    },
  ),
  defineAdminHandler(
    adminDeliveryTicketPublishListReplace,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        PublishListSaveResultSchema.parse(
          await publishWorkbenchOf(c.var.runtime).lists.replace(
            c.var.identity!,
            { ...staff.ctx, scope: staff.taskScope },
            c.req.valid("param").deliveryTicketId,
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineAdminHandler(
    adminDeliveryTicketPublishListImport,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        PublishListImportResultSchema.parse(
          await publishWorkbenchOf(c.var.runtime).lists.import(
            c.var.identity!,
            { ...staff.ctx, scope: staff.taskScope },
            c.req.valid("param").deliveryTicketId,
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineHandler(mOrderItemPublishListGet, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      PublishListViewSchema.parse(
        await publishWorkbenchOf(c.var.runtime).lists.merchantGet(
          viewer(c),
          c.req.valid("param").orderItemId,
        ),
      ),
    );
  }),
  defineHandler(portalOrderItemPublishListGet, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      PublishListViewSchema.parse(
        await publishWorkbenchOf(c.var.runtime).lists.portalGet(
          portalPrincipalOf(c),
          c.req.valid("param").orderItemId,
        ),
      ),
    );
  }),
  defineAdminHandler(
    adminLaunchCalendarGet,
    { module: "publish", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        LaunchCalendarSchema.parse(
          await publishWorkbenchOf(c.var.runtime).workbench.calendar(
            staff.ctx,
            c.req.valid("query"),
          ),
        ),
      );
    },
  ),
  defineAdminHandler(adminLaunchTaskList, { module: "publish", need: "view" }, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      LaunchTrackPageSchema.parse(
        await publishWorkbenchOf(c.var.runtime).workbench.list(staff.ctx, c.req.valid("query")),
      ),
    );
  }),
  defineAdminHandler(
    adminLaunchTaskSummary,
    { module: "publish", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        LaunchTrackSummarySchema.parse(
          await publishWorkbenchOf(c.var.runtime).workbench.summary(
            staff.ctx,
            c.req.valid("query"),
          ),
        ),
      );
    },
  ),
  defineAdminHandler(
    adminLaunchSubmissionRevoke,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        LaunchSubmissionDetailSchema.parse(
          await publishWorkbenchOf(c.var.runtime).revoke.revoke(
            c.var.identity!,
            { ...staff.ctx, scope: staff.taskScope },
            c.req.valid("param").launchSubmissionId,
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
];
