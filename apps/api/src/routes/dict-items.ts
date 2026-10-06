import { DictItemListResultSchema, mDictItemList } from "@liyoxi/contract";
import { respondByRole } from "../http/respond-by-role.js";
import { defineHandler } from "../routing/define.js";

export const dictItemHandlers = [
  defineHandler(mDictItemList, async (c) => {
    const { typeKey, ...options } = c.req.valid("query");
    const items = await c.var.runtime.config.dicts.listForMerchant(typeKey, options);
    return respondByRole(
      c,
      {
        owner: DictItemListResultSchema,
        clerk: DictItemListResultSchema,
        guest: DictItemListResultSchema,
      },
      { items },
    );
  }),
];
