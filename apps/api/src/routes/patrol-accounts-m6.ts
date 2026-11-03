import {
  adminChannelAccountList,
  adminChannelAccountSummary,
  adminChannelAccountMarkAbnormal,
  mChannelAccountUnbind,
  adminPatrolTaskList,
  adminPatrolTaskSummary,
  adminPatrolTaskGet,
  adminPatrolTaskCreate,
  adminPatrolTaskMarkNormal,
  adminPatrolTaskMarkAbnormal,
  adminPatrolTaskRecover,
  adminPatrolTaskRemind,
  AdminChannelAccountPageSchema,
  AdminChannelAccountSummarySchema,
  ChannelAccountDetailSchema,
  ChannelAccountCardSchema,
  PatrolTaskPageSchema,
  PatrolSummarySchema,
  PatrolTaskDetailSchema,
  PatrolTaskCreateResultSchema,
} from "@liyoxi/contract";
import {
  AppError,
  authz,
  createFlow,
  createChannelHealth,
  createPublishPatrol,
} from "@liyoxi/services";
import type { Runtime, PublishViewer } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { defineHandler } from "../routing/define.js";
import { defineAdminHandler } from "../routing/admin.js";
const cached = new WeakMap<
  Runtime,
  { health: ReturnType<typeof createChannelHealth>; patrol: ReturnType<typeof createPublishPatrol> }
>();
function services(runtime: Runtime) {
  let value = cached.get(runtime);
  if (!value) {
    const { tx, clock, assembly, approval, events, media, timers } = runtime;
    const deps = {
      tx,
      clock,
      assembly,
      approval,
      events,
      media,
      timers,
      flow: createFlow({ assembly, clock, events }),
    };
    value = { health: createChannelHealth(deps), patrol: createPublishPatrol(deps) };
    cached.set(runtime, value);
  }
  return value;
}
function identity(c: Context<ApiEnv>) {
  const ctx = c.get("identity");
  if (!ctx) throw new AppError("PERMISSION_DENIED");
  return ctx;
}
function viewer(c: Context<ApiEnv>): PublishViewer {
  const membership = c.get("membership");
  if (!membership) throw new AppError("NOT_A_MEMBER");
  return { ctx: identity(c), membership };
}
export const patrolAccountHandlers = [
  defineAdminHandler(adminChannelAccountList, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    if (
      !authz.satisfiesLevel(staff.ctx.moduleLevels.publish, "view") &&
      !authz.satisfiesLevel(staff.ctx.moduleLevels.merchant, "view")
    )
      throw new AppError("PERMISSION_DENIED");
    return ok(
      c,
      AdminChannelAccountPageSchema.parse(
        await services(c.var.runtime).health.list(staff.ctx, c.req.valid("query")),
      ),
    );
  }),
  defineAdminHandler(adminChannelAccountSummary, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    if (
      !authz.satisfiesLevel(staff.ctx.moduleLevels.publish, "view") &&
      !authz.satisfiesLevel(staff.ctx.moduleLevels.merchant, "view")
    )
      throw new AppError("PERMISSION_DENIED");
    return ok(
      c,
      AdminChannelAccountSummarySchema.parse(
        await services(c.var.runtime).health.summary(staff.ctx, c.req.valid("query")),
      ),
    );
  }),
  defineAdminHandler(
    adminChannelAccountMarkAbnormal,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        ChannelAccountDetailSchema.parse(
          await services(c.var.runtime).health.markAbnormal(
            identity(c),
            staff.ctx,
            c.req.valid("param").channelAccountId,
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineHandler(mChannelAccountUnbind, async (c) =>
    ok(
      c,
      ChannelAccountCardSchema.parse(
        await services(c.var.runtime).health.unbind(
          viewer(c),
          c.req.valid("param").channelAccountId,
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminPatrolTaskList, { module: "publish", need: "view" }, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      PatrolTaskPageSchema.parse(
        await services(c.var.runtime).patrol.list(staff.ctx, c.req.valid("query")),
      ),
    );
  }),
  defineAdminHandler(
    adminPatrolTaskSummary,
    { module: "publish", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        PatrolSummarySchema.parse(
          await services(c.var.runtime).patrol.summary(staff.ctx, c.req.valid("query")),
        ),
      );
    },
  ),
  defineAdminHandler(adminPatrolTaskGet, { module: "publish", need: "view" }, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      PatrolTaskDetailSchema.parse(
        await services(c.var.runtime).patrol.get(staff.ctx, c.req.valid("param").patrolTaskId),
      ),
    );
  }),
  defineAdminHandler(adminPatrolTaskCreate, { module: "publish", need: "edit" }, async (c, staff) =>
    ok(
      c,
      PatrolTaskCreateResultSchema.parse(
        await services(c.var.runtime).patrol.create(identity(c), staff.ctx, c.req.valid("json"), {
          idem: idemOf(c),
        }),
      ),
    ),
  ),
  defineAdminHandler(
    adminPatrolTaskMarkNormal,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        PatrolTaskDetailSchema.parse(
          await services(c.var.runtime).patrol.decide(
            identity(c),
            staff.ctx,
            c.req.valid("param").patrolTaskId,
            "normal",
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineAdminHandler(
    adminPatrolTaskMarkAbnormal,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        PatrolTaskDetailSchema.parse(
          await services(c.var.runtime).patrol.decide(
            identity(c),
            staff.ctx,
            c.req.valid("param").patrolTaskId,
            "abnormal",
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineAdminHandler(
    adminPatrolTaskRecover,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        PatrolTaskDetailSchema.parse(
          await services(c.var.runtime).patrol.decide(
            identity(c),
            staff.ctx,
            c.req.valid("param").patrolTaskId,
            "recover",
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineAdminHandler(adminPatrolTaskRemind, { module: "publish", need: "edit" }, async (c, staff) =>
    ok(
      c,
      PatrolTaskDetailSchema.parse(
        await services(c.var.runtime).patrol.remind(
          identity(c),
          staff.ctx,
          c.req.valid("param").patrolTaskId,
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
];
