// 回包的最后一道裁剪（C55）；不能放进 tx.run 的闭包，否则幂等结果会先被裁剪。
import { AppError, cropMerchantView } from "@liyoxi/services";
import type { MerchantViewerRole, MerchantViewSchemas } from "@liyoxi/services";
import type { Context } from "hono";

import type { ApiEnv } from "../context.js";
import { merchantServicesOf } from "../merchant/services.js";
import { ok } from "./errors.js";

export function observerRoleOf(c: Context<ApiEnv>): Promise<MerchantViewerRole>;
export function observerRoleOf(
  c: Context<ApiEnv>,
  noMembershipRole: "none",
): Promise<MerchantViewerRole | "none">;
export async function observerRoleOf(
  c: Context<ApiEnv>,
  noMembershipRole: "clerk" | "none" = "clerk",
): Promise<MerchantViewerRole | "none"> {
  const membership = c.get("membership");
  if (membership !== undefined) return membership.role;
  const session = c.get("merchantSession");
  if (session === undefined) return "guest";
  const { runtime } = c.var;
  const active = await runtime.tx.run((tx) =>
    merchantServicesOf(runtime).tenant.activeMembership(tx, session.merchantUserId),
  );
  return active === null ? noMembershipRole : active.role;
}

export async function respondByRole<T>(
  c: Context<ApiEnv>,
  schemas: MerchantViewSchemas<T> & { none?: { parse(input: unknown): T } },
  result: unknown,
  noMembershipRole?: "none",
) {
  const role =
    noMembershipRole === "none" ? await observerRoleOf(c, "none") : await observerRoleOf(c);
  if (role === "none") {
    if (schemas.none === undefined) throw new AppError("ROLE_FORBIDDEN");
    const value =
      typeof result === "object" && result !== null && "viewerRole" in result
        ? { ...result, viewerRole: role }
        : result;
    return ok(c, schemas.none.parse(value));
  }
  return ok(c, cropMerchantView(role, schemas, result));
}
