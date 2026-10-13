import {
  adminMerchantUserDisable,
  adminMerchantUserEnable,
  adminMerchantUserForceLogout,
  adminAccountChangeRequestList,
  adminAccountChangeRequestGet,
  adminAccountChangeRequestCreate,
  adminAccountChangeRequestApprove,
  adminAccountChangeRequestReject,
  adminAccountChangeRequestWithdraw,
  adminReferralCodeList,
  adminReferralCodeCreate,
  adminReferralCodeDisable,
  adminReferralCodeEnable,
} from "@liyoxi/contract";
import type { RequestMeta } from "@liyoxi/services";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { merchantServicesOf } from "../../merchant/services.js";
import { defineAdminHandler } from "../../routing/admin.js";
import type { AdminStaff } from "../../routing/admin.js";

const metaOf = (
  staff: AdminStaff,
  identity: Pick<RequestMeta, "requestId" | "ip" | "userAgent">,
): Pick<RequestMeta, "requestId" | "ip" | "userAgent"> & {
  sessionId: string;
  authMethod: "password+totp" | "password+recovery" | null;
} => ({
  ...identity,
  sessionId: staff.principal.session.id,
  authMethod:
    staff.principal.session.authMethod === "password+totp" ||
    staff.principal.session.authMethod === "password+recovery"
      ? staff.principal.session.authMethod
      : null,
});
export const adminIdentityHandlers = [
  defineAdminHandler(
    adminReferralCodeList,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.referralCodes.list(
          c.var.identity!,
          staff.ctx,
          c.req.valid("query"),
          { meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminReferralCodeCreate,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.referralCodes.create(
          c.var.identity!,
          staff.ctx,
          c.req.valid("json"),
          { idem: idemOf(c), meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminReferralCodeDisable,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.referralCodes.disable(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").referralCodeId,
          c.req.valid("json"),
          { idem: idemOf(c), meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminReferralCodeEnable,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.referralCodes.enable(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").referralCodeId,
          c.req.valid("json"),
          { idem: idemOf(c), meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminMerchantUserDisable,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.adminUserAction(
          c.var.identity!,
          staff.ctx,
          "disable",
          { ...c.req.valid("param"), ...c.req.valid("json") },
          { idem: idemOf(c), meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminMerchantUserEnable,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.adminUserAction(
          c.var.identity!,
          staff.ctx,
          "enable",
          { ...c.req.valid("param"), ...c.req.valid("json") },
          { idem: idemOf(c), meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminMerchantUserForceLogout,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.adminUserAction(
          c.var.identity!,
          staff.ctx,
          "forceLogout",
          { ...c.req.valid("param"), ...c.req.valid("json") },
          { idem: idemOf(c), meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminAccountChangeRequestList,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.accountChanges.list(
          c.var.identity!,
          staff.ctx,
          c.req.valid("query"),
          { meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminAccountChangeRequestGet,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.accountChanges.get(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").accountChangeRequestId,
          { meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminAccountChangeRequestCreate,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.accountChanges.create(
          c.var.identity!,
          staff.ctx,
          c.req.valid("json"),
          { idem: idemOf(c), meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminAccountChangeRequestApprove,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.accountChanges.approve(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").accountChangeRequestId,
          c.req.valid("json"),
          { idem: idemOf(c), meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminAccountChangeRequestReject,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.accountChanges.reject(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").accountChangeRequestId,
          c.req.valid("json"),
          { idem: idemOf(c), meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminAccountChangeRequestWithdraw,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.accountChanges.withdraw(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").accountChangeRequestId,
          c.req.valid("json"),
          { idem: idemOf(c), meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
];
