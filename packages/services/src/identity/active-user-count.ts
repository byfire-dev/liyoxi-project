import type { Tx } from "../kernel/index.js";
/** 簿记瞬间的真实正常账号数；不把缺能力当0。 */
export const countActiveMerchantUsers = (tx: Tx): Promise<number> =>
  tx.merchantUser.count({ where: { status: "active" } });
