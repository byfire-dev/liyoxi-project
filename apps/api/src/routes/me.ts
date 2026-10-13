import {
  CurrentStoreSchema,
  MeUserSchema,
  MemberRemovalResultSchema,
  UserNoticeAckResultSchema,
  WechatIdentityListSchema,
  WechatIdentityRemoveResultSchema,
  mMeCurrentStoreReplace,
  mMeMembershipLeave,
  mMeUpdate,
  mMeUserNoticeAcknowledge,
  mMeWechatIdentityDelete,
  mMeWechatIdentityList,
} from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import type { RequestMeta } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { idemOf } from "../http/idempotency.js";
import { merchantSessionOf } from "../http/merchant-auth.js";
import { respondByRole } from "../http/respond-by-role.js";
import { CLIENT_VERSION_HEADER } from "../http/version-gate.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";

function metaOf(c: Context<ApiEnv>): RequestMeta {
  return {
    requestId: c.get("requestId"),
    ip: c.get("clientIp"),
    userAgent: c.req.header("User-Agent") ?? null,
    clientVersion: c.req.header(CLIENT_VERSION_HEADER)?.slice(0, 32) ?? null,
  };
}

export const meHandlers = [
  defineHandler(mMeUpdate, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).identity.updateMe(
      merchantSessionOf(c),
      metaOf(c),
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(c, { owner: MeUserSchema, clerk: MeUserSchema }, result);
  }),
  defineHandler(mMeUserNoticeAcknowledge, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).identity.acknowledgeUserNotice(
      merchantSessionOf(c),
      metaOf(c),
      c.req.valid("param"),
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(
      c,
      { owner: UserNoticeAckResultSchema, clerk: UserNoticeAckResultSchema },
      result,
    );
  }),
  defineHandler(mMeWechatIdentityList, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).identity.listWechatIdentities(
      merchantSessionOf(c),
      c.req.valid("query"),
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(
      c,
      { owner: WechatIdentityListSchema, clerk: WechatIdentityListSchema },
      result,
    );
  }),
  defineHandler(mMeWechatIdentityDelete, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).identity.removeWechatIdentity(
      merchantSessionOf(c),
      metaOf(c),
      c.req.valid("param"),
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(
      c,
      { owner: WechatIdentityRemoveResultSchema, clerk: WechatIdentityRemoveResultSchema },
      result,
    );
  }),
  defineHandler(mMeMembershipLeave, async (c) => {
    const ctx = c.get("identity");
    if (!ctx) throw new AppError("AUTH_REQUIRED");
    const result = await merchantServicesOf(c.var.runtime).tenant.leaveMembership(ctx, {
      idem: idemOf(c),
    });
    c.header("Cache-Control", "no-store");
    return respondByRole(
      c,
      { owner: MemberRemovalResultSchema, clerk: MemberRemovalResultSchema },
      result,
    );
  }),
  defineHandler(mMeCurrentStoreReplace, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).tenant.rememberCurrentStore(
      { merchantUserId: merchantSessionOf(c).merchantUserId, ...c.req.valid("json") },
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(c, { owner: CurrentStoreSchema, clerk: CurrentStoreSchema }, result);
  }),
];
