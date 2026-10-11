import {
  InvitationCardSchema,
  InvitationMarkSharedResultSchema,
  InvitationPreviewSchema,
  InvitationRevokeResultSchema,
  mInvitationCreate,
  mInvitationLookup,
  mInvitationMarkShared,
  mInvitationRevoke,
  mInvitationAccept,
  MembershipResultSchema,
} from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { respondByRole } from "../http/respond-by-role.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";

export const invitationHandlers = [
  defineHandler(mInvitationAccept, async (c) => {
    const ctx = c.get("identity"),
      principal = c.get("merchantSession");
    if (!ctx || !principal) throw new AppError("AUTH_REQUIRED");
    const result = await merchantServicesOf(c.var.runtime).tenant.acceptInvitation(
      ctx,
      { ...c.req.valid("param"), ...c.req.valid("json") },
      { idem: idemOf(c), principal },
    );
    c.header("Cache-Control", "no-store");
    return ok(c, MembershipResultSchema.parse(result));
  }),
  defineHandler(mInvitationCreate, async (c) => {
    const ctx = c.get("identity"),
      principal = c.get("merchantSession");
    if (!ctx || !principal) throw new AppError("AUTH_REQUIRED");
    const result = await merchantServicesOf(c.var.runtime).tenant.createInvitation(
      ctx,
      c.req.valid("json"),
      { idem: idemOf(c), principal },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(c, { owner: InvitationCardSchema }, result);
  }),
  defineHandler(mInvitationMarkShared, async (c) => {
    const ctx = c.get("identity");
    if (!ctx) throw new AppError("AUTH_REQUIRED");
    const result = await merchantServicesOf(c.var.runtime).tenant.markInvitationShared(
      ctx,
      c.req.valid("param"),
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(c, { owner: InvitationMarkSharedResultSchema }, result);
  }),
  defineHandler(mInvitationRevoke, async (c) => {
    const ctx = c.get("identity");
    if (!ctx) throw new AppError("AUTH_REQUIRED");
    const result = await merchantServicesOf(c.var.runtime).tenant.revokeInvitation(
      ctx,
      { ...c.req.valid("param"), ...c.req.valid("json") },
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(c, { owner: InvitationRevokeResultSchema }, result);
  }),
  defineHandler(mInvitationLookup, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).tenant.lookupInvitation(
      c.req.valid("query").token,
    );
    c.header("Cache-Control", "no-store");
    return ok(c, InvitationPreviewSchema.parse(result));
  }),
];
