import { StoreListSchema, mStoreList } from "@liyoxi/contract";
import type { StoreList } from "@liyoxi/contract";
import { merchantSessionOf } from "../http/merchant-auth.js";
import { respondByRole } from "../http/respond-by-role.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";

export const storeHandlers = [
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
