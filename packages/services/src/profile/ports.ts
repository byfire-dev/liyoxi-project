import { definePort } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { FinalRejectImpact } from "@liyoxi/contract";

export interface QualificationImpact {
  previewFinalReject(
    tx: Tx,
    input: { entityId: string; storeId: string },
    at: Date,
  ): Promise<FinalRejectImpact>;
}
/** a03 §3.25：真实 order 实现；缺装配必须失败，不把未知影响当零。 */
export const QualificationImpactPort = definePort<QualificationImpact>(
  "profile.qualification_impact",
);

export interface ManagerAssignment {
  readonly storeId: string;
  readonly entityId: string;
  readonly staffId: string;
  readonly ctx: IdentityContext;
}
export type SyncStoreManager = (tx: Tx, input: ManagerAssignment) => Promise<void | number>;
// W1-15 / W1-16a 各自注册；两个写入与 tenant 的门店更新共用同一事务。
export const orderManagerPort = definePort<SyncStoreManager>("profile.order_manager_sync", {
  fallback: async () => {},
});
export const deliveryManagerPort = definePort<SyncStoreManager>("profile.delivery_manager_assign", {
  fallback: async () => {},
});

// 返回本次真实改写数量；旧 void 只兼容既有空实现，归零。以 input.staffId 为目标，调用时 store 行已锁但经理列尚未更新。
