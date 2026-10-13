import {
  adminStoreList,
  adminStoreGet,
  adminStoreActivityList,
  adminAssignmentHistoryMarkContacted,
  adminStoreAssignDeliveryManager,
  adminQualificationSubmissionGet,
  adminQualificationSubmissionApprove,
  adminQualificationSubmissionReject,
  adminQualificationSubmissionRejectQuote,
  adminQualificationDocUpdate,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { merchantServicesOf } from "../../merchant/services.js";
import { defineAdminHandler } from "../../routing/admin.js";
const moduleNeed = { module: "merchant", need: "view" } as const;
export const adminProfileHandlers = [
  defineAdminHandler(adminAssignmentHistoryMarkContacted, moduleNeed, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.staffManagement.markAssignmentContacted(
        staff.ctx,
        c.var.identity!,
        c.req.valid("param").assignmentHistoryId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminStoreActivityList, moduleNeed, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await merchantServicesOf(c.var.runtime).profile.admin.activity(
        staff.ctx,
        c.req.valid("param").storeId,
        c.req.valid("query"),
      ),
    );
  }),
  defineAdminHandler(adminQualificationDocUpdate, moduleNeed, async (c, staff) =>
    ok(
      c,
      await merchantServicesOf(c.var.runtime).profile.admin.reviewDocument(
        c.var.identity!,
        staff.ctx,
        c.req.valid("param").qualificationDocId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminStoreList, moduleNeed, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await merchantServicesOf(c.var.runtime).profile.admin.list(staff.ctx, c.req.valid("query")),
    );
  }),
  defineAdminHandler(adminStoreGet, moduleNeed, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await merchantServicesOf(c.var.runtime).profile.admin.get(
        staff.ctx,
        c.req.valid("param").storeId,
      ),
    );
  }),
  defineAdminHandler(adminQualificationSubmissionGet, moduleNeed, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await merchantServicesOf(c.var.runtime).profile.admin.qualification(
        staff.ctx,
        c.req.valid("param").qualificationSubmissionId,
      ),
    );
  }),
  defineAdminHandler(adminQualificationSubmissionApprove, moduleNeed, async (c, staff) =>
    ok(
      c,
      await merchantServicesOf(c.var.runtime).profile.admin.approve(
        c.var.identity!,
        staff.ctx,
        c.req.valid("param").qualificationSubmissionId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminQualificationSubmissionReject, moduleNeed, async (c, staff) =>
    ok(
      c,
      await merchantServicesOf(c.var.runtime).profile.admin.reject(
        c.var.identity!,
        staff.ctx,
        c.req.valid("param").qualificationSubmissionId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminQualificationSubmissionRejectQuote, moduleNeed, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await merchantServicesOf(c.var.runtime).profile.admin.rejectQuote(
        staff.ctx,
        c.req.valid("param").qualificationSubmissionId,
      ),
    );
  }),
  defineAdminHandler(adminStoreAssignDeliveryManager, moduleNeed, async (c, staff) =>
    ok(
      c,
      await merchantServicesOf(c.var.runtime).profile.admin.assign(
        c.var.identity!,
        staff.ctx,
        c.req.valid("param").storeId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
];
