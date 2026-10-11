import {
  StoreListSchema,
  mStoreList,
  StoreArchiveResultSchema,
  mStoreArchive,
  StoreCardSchema,
  mStoreRestore,
  StoreDeleteResultSchema,
  mStoreDelete,
} from "@liyoxi/contract";
import type { StoreList } from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import { idemOf } from "../http/idempotency.js";
import { merchantSessionOf } from "../http/merchant-auth.js";
import { respondByRole } from "../http/respond-by-role.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";

export const storeHandlers = [
  defineHandler(mStoreDelete, async (c) => {
    const ctx = c.get("identity");
    if (!ctx) throw new AppError("AUTH_REQUIRED");
    const result = await merchantServicesOf(c.var.runtime).tenant.deleteStore(
      ctx,
      c.req.valid("param"),
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(c, { owner: StoreDeleteResultSchema }, result);
  }),
  defineHandler(mStoreRestore, async (c) => {
    const ctx = c.get("identity");
    if (!ctx) throw new AppError("AUTH_REQUIRED");
    const result = await merchantServicesOf(c.var.runtime).tenant.restoreStore(
      ctx,
      c.req.valid("param"),
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(c, { owner: StoreCardSchema }, result);
  }),
  defineHandler(mStoreArchive, async (c) => {
    const ctx = c.get("identity");
    if (!ctx) throw new AppError("AUTH_REQUIRED");
    const result = await merchantServicesOf(c.var.runtime).tenant.archiveStore(
      ctx,
      c.req.valid("param"),
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(c, { owner: StoreArchiveResultSchema }, result);
  }),
  defineHandler(mStoreList, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).tenant.listStores({
      merchantUserId: merchantSessionOf(c).merchantUserId,
    });
    c.header("Cache-Control", "no-store");
    return respondByRole<StoreList>(
      c,
      {
        owner: StoreListSchema.options[0],
        clerk: StoreListSchema.options[1],
        none: StoreListSchema.options[2],
      },
      result,
      "none",
    );
  }),
];
