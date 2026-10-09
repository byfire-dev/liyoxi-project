import {
  adminStaffCreate,
  adminStaffGet,
  adminStaffList,
  adminStaffUpdate,
  adminStaffSummary,
  adminStaffEnable,
  adminStaffDisable,
  adminStaffHandover,
  adminStaffResetPassword,
  adminStaffResetMfa,
  adminStaffReissueActivationCode,
  adminStaffUnlock,
  adminStaffBindWecom,
  adminStaffInviteWecom,
  adminStaffOpenWorkGet,
  adminStaffPoolMembershipReplace,
  adminStaffDutyUpdate,
  adminStaffGroupList,
  adminStaffSessionList,
  adminStaffSessionRevoke,
  adminAssignmentPoolMemberList,
  StaffDetailSchema,
  StaffMutationResultSchema,
  StaffWecomSchema,
  ActivationIssueSchema,
  HandoverResultSchema,
  PoolMemberSchema,
  PoolMemberListSchema,
  StaffCountsSchema,
  OpenWorkSummarySchema,
  StaffSessionViewSchema,
  StaffGroupSummarySchema,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
import type { Runtime } from "@liyoxi/services";

export const staffManagementOf = (runtime: Runtime) => runtime.staffManagement;
const systemView = { module: "system", need: "view" } as const;

export const adminStaffHandlers = [
  defineAdminHandler(adminStaffList, null, async (c, current) => {
    const page = await staffManagementOf(c.var.runtime).list(current.ctx, c.req.valid("query"));
    c.header("Cache-Control", "no-store");
    return ok(c, page);
  }),
  // Literal paths precede staffId; summary retains the list's scope and filters.
  defineAdminHandler(adminStaffSummary, systemView, async (c, current) =>
    ok(
      c,
      StaffCountsSchema.parse(
        await staffManagementOf(c.var.runtime).summary(current.ctx, c.req.valid("query")),
      ),
    ),
  ),
  defineAdminHandler(adminStaffGet, systemView, async (c, current) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      StaffDetailSchema.parse(
        await staffManagementOf(c.var.runtime).get(current.ctx, c.req.valid("param").staffId),
      ),
    );
  }),
  defineAdminHandler(adminStaffCreate, systemView, async (c, current) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      StaffMutationResultSchema.parse(
        await staffManagementOf(c.var.runtime).create(
          current.ctx,
          c.var.identity!,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    );
  }),
  defineAdminHandler(adminStaffUpdate, systemView, async (c, current) =>
    ok(
      c,
      StaffDetailSchema.parse(
        await staffManagementOf(c.var.runtime).update(
          current.ctx,
          c.var.identity!,
          c.req.valid("param").staffId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminStaffEnable, systemView, async (c, current) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      StaffMutationResultSchema.parse(
        await staffManagementOf(c.var.runtime).enable(
          current.ctx,
          c.var.identity!,
          c.req.valid("param").staffId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    );
  }),
  defineAdminHandler(adminStaffDisable, systemView, async (c, current) =>
    ok(
      c,
      HandoverResultSchema.parse(
        await staffManagementOf(c.var.runtime).disable(
          current.ctx,
          c.var.identity!,
          c.req.valid("param").staffId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminStaffHandover, systemView, async (c, current) =>
    ok(
      c,
      HandoverResultSchema.parse(
        await staffManagementOf(c.var.runtime).handover(
          current.ctx,
          c.var.identity!,
          c.req.valid("param").staffId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminStaffResetPassword, systemView, async (c, current) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      StaffMutationResultSchema.parse(
        await staffManagementOf(c.var.runtime).resetPassword(
          current.ctx,
          c.var.identity!,
          c.req.valid("param").staffId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    );
  }),
  defineAdminHandler(adminStaffResetMfa, systemView, async (c, current) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      StaffMutationResultSchema.parse(
        await staffManagementOf(c.var.runtime).resetMfa(
          current.ctx,
          c.var.identity!,
          c.req.valid("param").staffId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    );
  }),
  defineAdminHandler(adminStaffReissueActivationCode, systemView, async (c, current) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      ActivationIssueSchema.parse(
        await staffManagementOf(c.var.runtime).reissueActivationCode(
          current.ctx,
          c.var.identity!,
          c.req.valid("param").staffId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    );
  }),
  defineAdminHandler(adminStaffUnlock, systemView, async (c, current) =>
    ok(
      c,
      StaffDetailSchema.parse(
        await staffManagementOf(c.var.runtime).unlock(
          current.ctx,
          c.var.identity!,
          c.req.valid("param").staffId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminStaffInviteWecom, systemView, async (c, current) =>
    ok(
      c,
      StaffWecomSchema.parse(
        await staffManagementOf(c.var.runtime).inviteWecom(
          current.ctx,
          c.var.identity!,
          c.req.valid("param").staffId,
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminStaffBindWecom, systemView, async (c, current) =>
    ok(
      c,
      StaffWecomSchema.parse(
        await staffManagementOf(c.var.runtime).bindWecom(
          current.ctx,
          c.var.identity!,
          c.req.valid("param").staffId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminStaffOpenWorkGet, systemView, async (c, current) =>
    ok(
      c,
      OpenWorkSummarySchema.parse(
        await staffManagementOf(c.var.runtime).openWork(current.ctx, c.req.valid("param").staffId),
      ),
    ),
  ),
  defineAdminHandler(adminStaffPoolMembershipReplace, systemView, async (c, current) =>
    ok(
      c,
      StaffDetailSchema.parse(
        await staffManagementOf(c.var.runtime).replacePools(
          current.ctx,
          c.var.identity!,
          c.req.valid("param").staffId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminStaffDutyUpdate, null, async (c, current) => {
    if (c.req.valid("param").staffId !== current.ctx.staff.id)
      current.assertPermission("service.ticket.assign");
    return ok(
      c,
      PoolMemberSchema.parse(
        await staffManagementOf(c.var.runtime).duty(
          current.ctx,
          c.var.identity!,
          c.req.valid("param").staffId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    );
  }),
  defineAdminHandler(adminAssignmentPoolMemberList, null, async (c, current) =>
    ok(
      c,
      PoolMemberListSchema.parse(
        await staffManagementOf(c.var.runtime).pools(current.ctx, c.req.valid("query")),
      ),
    ),
  ),
  defineAdminHandler(adminStaffGroupList, systemView, async (c, current) =>
    ok(c, {
      items: (
        await staffManagementOf(c.var.runtime).groups(current.ctx, c.req.valid("query"))
      ).items.map((item) => StaffGroupSummarySchema.parse(item)),
    }),
  ),
  defineAdminHandler(adminStaffSessionList, systemView, async (c, current) =>
    ok(
      c,
      await staffManagementOf(c.var.runtime).sessions(
        current.ctx,
        c.req.valid("query"),
        current.principal.session.id,
      ),
    ),
  ),
  defineAdminHandler(adminStaffSessionRevoke, systemView, async (c, current) =>
    ok(
      c,
      StaffSessionViewSchema.parse(
        await staffManagementOf(c.var.runtime).revokeSession(
          current.ctx,
          c.var.identity!,
          c.req.valid("param").staffSessionId,
          current.principal.session.id,
          c.req.valid("json").reason,
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
];
