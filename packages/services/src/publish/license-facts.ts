import type { Tx } from "../kernel/index.js";

export interface LicenseAccountFact {
  id: string;
  entityId: string;
  storeId: string;
  platform: string;
  name: string;
  accountNo: string;
  status: string;
}

/** 返回实际账号及归属；异常、解绑和缺失须由调用方据实检查，不能当作移出选定集合。 */
export async function readLicenseAccounts(
  tx: Tx,
  ids: readonly string[],
): Promise<LicenseAccountFact[]> {
  if (ids.length === 0) return [];
  const rows = await tx.channelAccount.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: {
      id: true,
      entityId: true,
      storeId: true,
      platform: true,
      accountName: true,
      accountUid: true,
      status: true,
    },
    orderBy: { id: "asc" },
  });
  return rows.map(({ accountName, accountUid, ...row }) => ({
    ...row,
    name: accountName,
    accountNo: accountUid,
  }));
}
