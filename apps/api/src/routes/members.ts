import {
  MemberRemovalResultSchema,
  MemberItemSchema,
  MemberListSchema,
  mMemberRemove,
  mMemberList,
  mMemberUpdate,
} from "@liyoxi/contract";
import type { MemberList } from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import { idemOf } from "../http/idempotency.js";
import { respondByRole } from "../http/respond-by-role.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";

export const memberHandlers = [
  defineHandler(mMemberList, async (c) => {
    const ctx = c.get("identity");
    if (!ctx) throw new AppError("AUTH_REQUIRED");
    const result = await merchantServicesOf(c.var.runtime).tenant.listMembers(ctx);
    c.header("Cache-Control", "no-store");
    return respondByRole<MemberList>(
      c,
      { owner: MemberListSchema.options[0], clerk: MemberListSchema.options[1] },
      result,
    );
  }),
  defineHandler(mMemberUpdate, async (c) => {
    const ctx = c.get("identity");
    if (!ctx) throw new AppError("AUTH_REQUIRED");
    const result = await merchantServicesOf(c.var.runtime).tenant.updateMember(
      ctx,
      { ...c.req.valid("param"), ...c.req.valid("json") },
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(c, { owner: MemberItemSchema }, result);
  }),
  defineHandler(mMemberRemove, async (c) => {
    const ctx = c.get("identity");
    if (!ctx) throw new AppError("AUTH_REQUIRED");
    const result = await merchantServicesOf(c.var.runtime).tenant.removeMember(
      ctx,
      c.req.valid("param"),
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(
      c,
      { owner: MemberRemovalResultSchema, clerk: MemberRemovalResultSchema },
      result,
    );
  }),
];
