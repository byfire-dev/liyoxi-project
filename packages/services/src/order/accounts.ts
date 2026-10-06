import type { ChannelAccount } from "@liyoxi/db";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

/** 报价展示未解绑账号；提交只能选本店可用账号，同一平台至多一个。 */
export async function orderAccounts(
  tx: Tx,
  storeId: string,
  selectedIds: readonly string[] = [],
): Promise<{ selected: ChannelAccount[]; available: ChannelAccount[] }> {
  const rows = await tx.channelAccount.findMany({
    where: { storeId },
    orderBy: [{ platform: "asc" }, { id: "asc" }],
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const selected: ChannelAccount[] = [];
  const platforms = new Set<string>();
  for (const id of selectedIds) {
    const row = byId.get(id);
    if (!row || row.status !== "available") {
      throw new AppError("ORDER_ACCOUNT_INVALID", {
        details: {
          channelAccountId: id,
          reason: row ? "not_available" : "not_in_store",
        },
      });
    }
    if (platforms.has(row.platform)) {
      throw new AppError("VALIDATION_FAILED", {
        details: {
          fieldErrors: [{ path: "channelAccountIds", message: "同一平台只能选择一个发布账号" }],
        },
      });
    }
    platforms.add(row.platform);
    selected.push(row);
  }
  return { selected, available: rows.filter((row) => row.status !== "unbound") };
}
