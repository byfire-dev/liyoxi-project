import {
  adminTakedownTaskList,
  adminTakedownTaskSummary,
  adminTakedownTaskGet,
  adminTakedownTaskCheck,
  adminTakedownTaskBatchCheck,
  adminTakedownTaskMarkOnline,
  adminTakedownTaskEscalate,
  adminTakedownTaskSendBreachNotice,
  mTakedownTaskList,
  mTakedownTaskSummary,
  mTakedownTaskConfirm,
  AdminTakedownTaskPageSchema,
  AdminTakedownTaskSummarySchema,
  MerchantTakedownTaskPageSchema,
  MerchantTakedownTaskSummarySchema,
  TakedownTaskDetailSchema,
  TakedownTaskWriteResultSchema,
  TakedownTaskBatchCheckResultSchema,
} from "@liyoxi/contract";
import { AppError, createFlow, createPublishTakedown, createSla } from "@liyoxi/services";
import type { PublishViewer, Runtime } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { defineAdminHandler } from "../routing/admin.js";
import { defineHandler } from "../routing/define.js";

const cache = new WeakMap<Runtime, ReturnType<typeof createPublishTakedown>>();
function takedownOf(runtime: Runtime) {
  let service = cache.get(runtime);
  if (!service) {
    const { tx, clock, assembly, approval, events, media, timers } = runtime;
    service = createPublishTakedown({
      tx,
      clock,
      assembly,
      approval,
      events,
      media,
      timers,
      flow: createFlow({ assembly, clock, events }),
      sla: createSla({ assembly, clock }),
    });
    cache.set(runtime, service);
  }
  return service;
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

export const takedownHandlers = [
  defineAdminHandler(
    adminTakedownTaskList,
    { module: "publish", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        AdminTakedownTaskPageSchema.parse(
          await takedownOf(c.var.runtime).list(staff.ctx, c.req.valid("query")),
        ),
      );
    },
  ),
  defineAdminHandler(
    adminTakedownTaskSummary,
    { module: "publish", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        AdminTakedownTaskSummarySchema.parse(
          await takedownOf(c.var.runtime).summary(staff.ctx, c.req.valid("query")),
        ),
      );
    },
  ),
  defineAdminHandler(
    adminTakedownTaskBatchCheck,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        TakedownTaskBatchCheckResultSchema.parse(
          await takedownOf(c.var.runtime).batchCheck(identity(c), staff.ctx, c.req.valid("json"), {
            idem: idemOf(c),
          }),
        ),
      ),
  ),
  defineAdminHandler(
    adminTakedownTaskGet,
    { module: "publish", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        TakedownTaskDetailSchema.parse(
          await takedownOf(c.var.runtime).get(staff.ctx, c.req.valid("param").takedownTaskId),
        ),
      );
    },
  ),
  defineAdminHandler(
    adminTakedownTaskCheck,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        TakedownTaskDetailSchema.parse(
          await takedownOf(c.var.runtime).check(
            identity(c),
            staff.ctx,
            c.req.valid("param").takedownTaskId,
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineAdminHandler(
    adminTakedownTaskMarkOnline,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        TakedownTaskDetailSchema.parse(
          await takedownOf(c.var.runtime).markOnline(
            identity(c),
            staff.ctx,
            c.req.valid("param").takedownTaskId,
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineAdminHandler(
    adminTakedownTaskEscalate,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        TakedownTaskDetailSchema.parse(
          await takedownOf(c.var.runtime).escalate(
            identity(c),
            staff.ctx,
            c.req.valid("param").takedownTaskId,
            c.req.valid("json"),
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineAdminHandler(
    adminTakedownTaskSendBreachNotice,
    { module: "publish", need: "edit" },
    async (c, staff) =>
      ok(
        c,
        TakedownTaskDetailSchema.parse(
          await takedownOf(c.var.runtime).sendBreachNotice(
            identity(c),
            staff.ctx,
            c.req.valid("param").takedownTaskId,
            { idem: idemOf(c) },
          ),
        ),
      ),
  ),
  defineHandler(mTakedownTaskList, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      MerchantTakedownTaskPageSchema.parse(
        await takedownOf(c.var.runtime).merchantList(viewer(c), c.req.valid("query")),
      ),
    );
  }),
  defineHandler(mTakedownTaskSummary, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      MerchantTakedownTaskSummarySchema.parse(
        await takedownOf(c.var.runtime).merchantSummary(viewer(c), c.req.valid("query")),
      ),
    );
  }),
  defineHandler(mTakedownTaskConfirm, async (c) =>
    ok(
      c,
      TakedownTaskWriteResultSchema.parse(
        await takedownOf(c.var.runtime).confirm(
          viewer(c),
          c.req.valid("param").takedownTaskId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
];
