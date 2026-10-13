import type { Tx } from "../kernel/index.js";

/** 只返回当前关系是否存在，不解密或暴露企业微信标识。 */
export async function hasActiveWecomContact(tx: Tx, merchantUserId: string, staffId: string) {
  return (
    (await tx.wecomContact.findFirst({
      where: { merchantUserId, staffId, removedAt: null },
      select: { id: true },
    })) !== null
  );
}
