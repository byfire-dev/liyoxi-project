import type { Tx } from "../kernel/index.js";
import { taskScope } from "../authz/index.js";
import type { DataScope } from "../authz/index.js";
import type { Prisma } from "@liyoxi/db";

// 绑定关系是 order 所有；此出口只读 ad 自有事实，不反向引用 order 内部表。
const select = {
  id: true,
  entityId: true,
  storeId: true,
  adNo: true,
  type: true,
  durationSec: true,
  status: true,
  returnedFrom: true,
  openCancelRequestId: true,
  pointHoldId: true,
  chargePoints: true,
  refundRequestedPoints: true,
  pricingSnapshot: true,
  capturedAt: true,
} as const;
export function readAdCancelFacts(tx: Tx, adId: string, scope?: DataScope) {
  const visible = scope
    ? taskScope<Prisma.AdWhereInput>(scope, {
        store: (where) => ({ store: where }),
        assignees: [{ col: "editorId", pool: "ad_editor" }],
      })
    : {};
  return tx.ad.findFirst({ where: { AND: [{ id: adId }, visible] }, select });
}
export function readQualificationCancelAds(tx: Tx, input: { entityId: string; storeId: string }) {
  return tx.ad.findMany({
    where: {
      ...input,
      openCancelRequestId: null,
      OR: [{ status: "pending_assign" }, { status: "returned", returnedFrom: "pending_assign" }],
    },
    select,
    orderBy: { id: "asc" },
  });
}
export type AdCancelFacts = NonNullable<Awaited<ReturnType<typeof readAdCancelFacts>>>;
