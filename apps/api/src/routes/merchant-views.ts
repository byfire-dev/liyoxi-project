import {
  BootstrapSchema,
  IdSchema,
  mBootstrapGet,
  mMeOverviewGet,
  MeOverviewForClerkSchema,
  MeOverviewOwnerSchema,
} from "@liyoxi/contract";
import type { MeOverview } from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import { merchantSessionOf } from "../http/merchant-auth.js";
import { respondByRole } from "../http/respond-by-role.js";
import {
  CLIENT_PLATFORM_HEADER,
  CLIENT_VERSION_HEADER,
  ENV_VERSION_HEADER,
} from "../http/version-gate.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";

export const merchantViewHandlers = [
  defineHandler(mBootstrapGet, async (c) => {
    const store = IdSchema.safeParse(c.req.header("X-Store-Id"));
    const rawEnv = c.req.header(ENV_VERSION_HEADER);
    const envVersion =
      rawEnv === "develop" || rawEnv === "trial" || rawEnv === "release" ? rawEnv : null;
    const result = await merchantServicesOf(c.var.runtime).identity.bootstrap({
      merchantUserId: c.get("merchantSession")?.merchantUserId ?? null,
      storeId: store.success ? store.data : null,
      platform: c.req.header(CLIENT_PLATFORM_HEADER) ?? null,
      clientVersion: c.req.header(CLIENT_VERSION_HEADER) ?? null,
      envVersion,
    });
    c.header("Cache-Control", "no-store");
    return respondByRole(
      c,
      { owner: BootstrapSchema, clerk: BootstrapSchema, guest: BootstrapSchema },
      result,
    );
  }),
  defineHandler(mMeOverviewGet, async (c) => {
    const membership = c.get("membership");
    if (membership === undefined) throw new AppError("NOT_A_MEMBER");
    const result = await merchantServicesOf(c.var.runtime).identity.overview({
      merchantUserId: merchantSessionOf(c).merchantUserId,
      membership,
    });
    c.header("Cache-Control", "no-store");
    return respondByRole<MeOverview>(
      c,
      { owner: MeOverviewOwnerSchema, clerk: MeOverviewForClerkSchema },
      result,
    );
  }),
];
