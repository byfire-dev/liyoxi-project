// 删除草稿门店的六项历史由真实拥有者在调用方事务中读取。
import { countSubmittedQualificationHistory } from "../profile/index.js";
import { countStoreOrderHistory } from "../order/index.js";
import { countStoreAdHistory } from "../ad/index.js";
import { countStoreChannelAccountHistory } from "../publish/index.js";
import { countStoreServiceTicketHistory } from "../support/index.js";
import { countStoreOriginalAssets } from "../media/index.js";
import type { TenantDeps } from "../tenant/index.js";

export const readStoreDraftFacts: NonNullable<TenantDeps["readStoreDraftFacts"]> = async (
  tx,
  input,
) => ({
  qualificationSubmissions: await countSubmittedQualificationHistory(tx, input),
  orders: await countStoreOrderHistory(tx, input),
  ads: await countStoreAdHistory(tx, input),
  channelAccounts: await countStoreChannelAccountHistory(tx, input),
  serviceTickets: await countStoreServiceTicketHistory(tx, input),
  originalAssets: await countStoreOriginalAssets(tx, input),
});
