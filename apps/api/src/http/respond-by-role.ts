// 回包的最后一道裁剪（C55）；不能放进 tx.run 的闭包，否则幂等结果会先被裁剪。
import { cropMerchantView } from "@liyoxi/services";
import type { MerchantViewerRole, MerchantViewSchemas } from "@liyoxi/services";
import type { Context } from "hono";

import type { ApiEnv } from "../context.js";
import { merchantServicesOf } from "../merchant/services.js";
import { ok } from "./errors.js";

export async function observerRoleOf(c: Context<ApiEnv>): Promise<MerchantViewerRole> {
  const membership = c.get("membership");
  if (membership !== undefined) return membership.role;
  const session = c.get("merchantSession");
  if (session === undefined) return "guest";
  const { runtime } = c.var;
  const active = await runtime.tx.run((tx) =>
    merchantServicesOf(runtime).tenant.activeMembership(tx, session.merchantUserId),
  );
  return active?.role === "owner" ? "owner" : "clerk";
}

export async function respondByRole<T>(
  c: Context<ApiEnv>,
  schemas: MerchantViewSchemas<T>,
  result: unknown,
) {
  return ok(c, cropMerchantView(await observerRoleOf(c), schemas, result));
}
