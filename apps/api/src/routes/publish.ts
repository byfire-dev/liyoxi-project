import {
  mChannelAccountList,
  mChannelAccountCreate,
  mChannelAccountSubmit,
  mLaunchTaskList,
  mLaunchTaskSummary,
  mLaunchTaskGet,
  mLaunchTaskSubmit,
  adminChannelAccountGet,
  adminChannelAccountSubmissionGet,
  adminChannelAccountSubmissionApprove,
  adminChannelAccountSubmissionReject,
  adminLaunchSubmissionGet,
  adminLaunchSubmissionApprove,
  adminLaunchSubmissionReject,
  adminChecklistTemplateList,
  ChannelAccountPageSchema,
  ChannelAccountCardSchema,
  LaunchTaskPageSchema,
  LaunchTaskSummarySchema,
  LaunchTaskDetailSchema,
  LaunchTaskCardSchema,
  ChannelAccountDetailSchema,
  ChannelAccountSubmissionDetailSchema,
  ChannelAccountDecisionResultSchema,
  LaunchSubmissionDetailSchema,
  ChecklistTemplateListSchema,
} from "@liyoxi/contract";
import { AppError, authz, createFlow, createPublish } from "@liyoxi/services";
import type { Runtime, Publish, PublishViewer } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { defineHandler } from "../routing/define.js";
import { defineAdminHandler } from "../routing/admin.js";
const services = new WeakMap<Runtime, Publish>();
export function publishOf(runtime: Runtime) {
  let service = services.get(runtime);
  if (!service) {
    const { tx, clock, assembly, approval, events, media } = runtime;
    service = createPublish({
      tx,
      clock,
      assembly,
      approval,
      media,
      flow: createFlow({ assembly, clock, events }),
    });
    services.set(runtime, service);
  }
  return service;
}
function viewer(c: Context<ApiEnv>): PublishViewer {
  const ctx = c.get("identity"),
    membership = c.get("membership");
  if (!ctx || !membership) throw new AppError("NOT_A_MEMBER");
  return { ctx, membership };
}
function identity(c: Context<ApiEnv>) {
  const ctx = c.get("identity");
  if (!ctx) throw new AppError("PERMISSION_DENIED");
  return ctx;
}
const privateRead = (c: Context<ApiEnv>) => c.header("Cache-Control", "no-store");
export const publishHandlers = [
  defineHandler(mChannelAccountList, async (c) => {
    privateRead(c);
    return ok(
      c,
      ChannelAccountPageSchema.parse(
        await publishOf(c.var.runtime).channelAccounts(viewer(c), c.req.valid("query")),
      ),
    );
  }),
  defineHandler(mChannelAccountCreate, async (c) =>
    ok(
      c,
      ChannelAccountCardSchema.parse(
        await publishOf(c.var.runtime).bind(viewer(c), c.req.valid("json"), { idem: idemOf(c) }),
      ),
    ),
  ),
  defineHandler(mChannelAccountSubmit, async (c) =>
    ok(
      c,
      ChannelAccountCardSchema.parse(
        await publishOf(c.var.runtime).resubmit(
          viewer(c),
          c.req.valid("param").channelAccountId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineHandler(mLaunchTaskList, async (c) => {
    privateRead(c);
    return ok(
      c,
      LaunchTaskPageSchema.parse(
        await publishOf(c.var.runtime).launchTasks(viewer(c), c.req.valid("query")),
      ),
    );
  }),
  defineHandler(mLaunchTaskSummary, async (c) => {
    privateRead(c);
    return ok(
      c,
      LaunchTaskSummarySchema.parse(
        await publishOf(c.var.runtime).launchSummary(viewer(c), c.req.valid("query")),
      ),
    );
  }),
  defineHandler(mLaunchTaskGet, async (c) => {
    privateRead(c);
    return ok(
      c,
      LaunchTaskDetailSchema.parse(
        await publishOf(c.var.runtime).launchTask(viewer(c), c.req.valid("param").launchTaskId),
      ),
    );
  }),
  defineHandler(mLaunchTaskSubmit, async (c) =>
    ok(
      c,
      LaunchTaskCardSchema.parse(
        await publishOf(c.var.runtime).submitLaunch(
          viewer(c),
          c.req.valid("param").launchTaskId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminChannelAccountGet, null, async (c, staff) => {
    privateRead(c);
    if (
      !authz.satisfiesLevel(staff.ctx.moduleLevels.publish, "view") &&
      !authz.satisfiesLevel(staff.ctx.moduleLevels.merchant, "view")
    )
      throw new AppError("PERMISSION_DENIED");
    return ok(
      c,
      ChannelAccountDetailSchema.parse(
        await publishOf(c.var.runtime).accountDetail(
          staff.ctx,
          c.req.valid("param").channelAccountId,
        ),
      ),
    );
  }),
  defineAdminHandler(adminChannelAccountSubmissionGet, null, async (c, staff) => {
    privateRead(c);
    if (
      !authz.hasPermission(staff.ctx, "publish.account.verify") &&
      !authz.satisfiesLevel(staff.ctx.moduleLevels.publish, "view") &&
      !authz.satisfiesLevel(staff.ctx.moduleLevels.merchant, "view")
    )
      throw new AppError("PERMISSION_DENIED");
    return ok(
      c,
      ChannelAccountSubmissionDetailSchema.parse(
        await publishOf(c.var.runtime).accountSubmission(
          staff.ctx,
          c.req.valid("param").channelAccountSubmissionId,
        ),
      ),
    );
  }),
  defineAdminHandler(
    adminChannelAccountSubmissionApprove,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        ChannelAccountDecisionResultSchema.parse(
          await publishOf(c.var.runtime).approveAccount(
            identity(c),
            staff.ctx,
            c.req.valid("param").channelAccountSubmissionId,
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineAdminHandler(
    adminChannelAccountSubmissionReject,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        ChannelAccountDecisionResultSchema.parse(
          await publishOf(c.var.runtime).rejectAccount(
            identity(c),
            staff.ctx,
            c.req.valid("param").channelAccountSubmissionId,
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineAdminHandler(
    adminLaunchSubmissionGet,
    { module: "publish", need: "view" },
    async (c, staff) => {
      privateRead(c);
      return ok(
        c,
        LaunchSubmissionDetailSchema.parse(
          await publishOf(c.var.runtime).launchSubmission(
            staff.ctx,
            c.req.valid("param").launchSubmissionId,
          ),
        ),
      );
    },
  ),
  defineAdminHandler(
    adminLaunchSubmissionApprove,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        LaunchSubmissionDetailSchema.parse(
          await publishOf(c.var.runtime).approveLaunch(
            identity(c),
            staff.ctx,
            c.req.valid("param").launchSubmissionId,
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineAdminHandler(
    adminLaunchSubmissionReject,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        LaunchSubmissionDetailSchema.parse(
          await publishOf(c.var.runtime).rejectLaunch(
            identity(c),
            staff.ctx,
            c.req.valid("param").launchSubmissionId,
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineAdminHandler(adminChecklistTemplateList, null, async (c, staff) => {
    privateRead(c);
    const query = c.req.valid("query");
    if (query.allVersions || query.status?.some((s) => s !== "active"))
      staff.assertPermission("flow.checklist.manage");
    return ok(
      c,
      ChecklistTemplateListSchema.parse(
        await publishOf(c.var.runtime).checklists(staff.ctx, query),
      ),
    );
  }),
];
