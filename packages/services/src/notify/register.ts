import { defineRegistration, implementMerchantFacts } from "../kernel/index.js";
import { countUnread } from "./messages.scope.js";

// PR1只交真实消息读侧；五条x01由后续场景/派发集成登记，不能以空处理器抢占。
export const registration = defineRegistration("notify", {
  portImplementations: [
    implementMerchantFacts("notify", async (tx, query) => ({
      unreadMessageCount:
        query.merchantUserId === null
          ? 0
          : await countUnread(tx, {
              merchantUserId: query.merchantUserId,
              entityId: query.entityId,
              storeIds: query.storeIds,
              now: query.now,
            }),
    })),
  ],
});
